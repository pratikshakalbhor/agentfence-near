// Full end-to-end example: agent (function-call key only) -> request_spend on
// the agentfence contract -> MPC signature -> broadcast the signed Sepolia
// transaction. No contract changes, no keys in the repo.
//
// Inputs (argv args or env vars; never hard-coded keys):
//   CONTRACT_ACCOUNT        agentfence contract account
//   AGENT_ACCOUNT           agent account (holds the function-call key)
//   DESTINATION             "evm:0x..." string, must be allowlisted
//   AMOUNT                  wei amount (U128 string)
//   SEPOLIA_RPC_URL         optional; default https://ethereum-sepolia-rpc.publicnode.com
//   AGENT_FCK_KEY_FILE      path to the file holding the agent's function-call
//                           private key (outside the repo, e.g. ~/.near-credentials/agentfence-agent-fck.txt)
//   --no-broadcast          do everything except broadcasting the Sepolia
//                           transaction. NOTE: request_spend is still sent
//                           on-chain and reserves daily budget; only the
//                           Sepolia broadcast is skipped. (--dry-run is a
//                           deprecated alias.)
//
// Uses near-api-js (JsonRpcProvider + Account.callFunction /
// provider.callFunction), chainsig.js (address derivation), and viem
// (tx serialization, hashing, recovery, fees).
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { contracts, chainAdapters } from 'chainsig.js';
import { Account, JsonRpcProvider } from 'near-api-js';
import {
  createPublicClient,
  http,
  serializeTransaction,
  keccak256,
  recoverAddress,
  getAddress,
} from 'viem';
import { sepolia } from 'viem/chains';

const NO_BROADCAST = process.argv.includes('--no-broadcast');
const DRY_RUN = process.argv.includes('--dry-run');
if (NO_BROADCAST || DRY_RUN) {
  if (DRY_RUN) {
    console.log('WARNING: --dry-run is deprecated, use --no-broadcast instead.');
  }
  console.log(
    'NOTE: request_spend is still sent on-chain and reserves daily budget; only the Sepolia broadcast is skipped.',
  );
}
const [contractArg, agentArg, destArg, amountArg] = process.argv
  .slice(2)
  .filter((a) => a !== '--dry-run' && a !== '--no-broadcast');
const CONTRACT_ACCOUNT = contractArg || process.env.CONTRACT_ACCOUNT;
const AGENT_ACCOUNT = agentArg || process.env.AGENT_ACCOUNT;
const DESTINATION = destArg || process.env.DESTINATION;
const AMOUNT = amountArg || process.env.AMOUNT;
const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const MAX_FEE_WEI = 5_000_000_000_000_000n; // contract's MAX_FEE_WEI (0.005 ETH)
const GAS_LIMIT = 21000n;

if (!CONTRACT_ACCOUNT || !AGENT_ACCOUNT || !DESTINATION || !AMOUNT) {
  throw new Error(
    'Usage: node send.mjs <CONTRACT_ACCOUNT> <AGENT_ACCOUNT> "evm:0x..." <AMOUNT_WEI> [--no-broadcast]\n' +
      '   or set CONTRACT_ACCOUNT, AGENT_ACCOUNT, DESTINATION, AMOUNT env vars.\n' +
      '   AGENT_FCK_KEY_FILE must point to the function-call private key file.',
  );
}

const fckFileRaw = process.env.AGENT_FCK_KEY_FILE;
if (!fckFileRaw) {
  throw new Error('AGENT_FCK_KEY_FILE env var is required (path outside the repo).');
}
// A leading "~" is expanded to the home directory (AGENT_FCK_KEY_FILE=~/…).
const fckFile =
  fckFileRaw === '~'
    ? homedir()
    : fckFileRaw.startsWith('~/') || fckFileRaw.startsWith('~\\')
      ? join(homedir(), fckFileRaw.slice(2))
      : fckFileRaw;
const fckJson = JSON.parse(await readFile(fckFile, 'utf8'));
const FCK_KEY = fckJson.secret_key;

// Step 1: derived address + nonce + fee data from Sepolia RPC.
const path = `evm-sepolia-${AGENT_ACCOUNT}`;
const mpcContract = new contracts.ChainSignatureContract({
  networkId: 'testnet',
  contractId: 'v1.signer-prod.testnet',
});
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(SEPOLIA_RPC_URL),
});
const evmChain = new chainAdapters.evm.EVM({
  publicClient,
  contract: mpcContract,
});
const { address: fromAddress } =
  await evmChain.deriveAddressAndPublicKey(CONTRACT_ACCOUNT, path);
const nonce = await publicClient.getTransactionCount({
  address: fromAddress,
});
const { maxFeePerGas, maxPriorityFeePerGas } =
  await publicClient.estimateFeesPerGas();
const bump = (x) => (x * 110n) / 100n; // round up ~10%
const MIN_MAX_FEE_PER_GAS = 1_000_000_000n; // 1 gwei
const MIN_MAX_PRIORITY_FEE_PER_GAS = 100_000_000n; // 0.1 gwei
const maxBig = (a, b) => (a > b ? a : b); // BigInt-only max
const max_fee_per_gas = maxBig(bump(maxFeePerGas), MIN_MAX_FEE_PER_GAS);
const max_priority_fee_per_gas = maxBig(
  bump(maxPriorityFeePerGas),
  MIN_MAX_PRIORITY_FEE_PER_GAS,
);
const feeWei = max_fee_per_gas * GAS_LIMIT;
console.log(`derived address: ${fromAddress}`);
console.log(`path: ${path}`);
console.log(`nonce: ${nonce}`);
console.log(
  `fees: max_fee_per_gas=${max_fee_per_gas} max_priority=${max_priority_fee_per_gas} gas=${GAS_LIMIT}`,
);
if (feeWei > MAX_FEE_WEI) {
  throw new Error(
    `refusing: fee ${feeWei} wei exceeds MAX_FEE_WEI ${MAX_FEE_WEI} wei`,
  );
}
const args = {
  destination: DESTINATION,
  amount: AMOUNT.toString(),
  nonce: Number(nonce),
  max_fee_per_gas: max_fee_per_gas.toString(),
  max_priority_fee_per_gas: max_priority_fee_per_gas.toString(),
  gas_limit: 21000,
};
console.log('tx args:', JSON.stringify(args));

// Steps 2-4: NEAR contract calls, signed ONLY with the function-call key.
const provider = new JsonRpcProvider({
  url: 'https://test.rpc.fastnear.com',
});
const account = new Account(AGENT_ACCOUNT, provider, FCK_KEY);

console.log('preview_payload (view)...');
const previewHash = await provider.callFunction({
  contractId: CONTRACT_ACCOUNT,
  method: 'preview_payload',
  args,
});
console.log(`preview_payload: ${previewHash}`);

console.log('request_spend (400 TeraGas, 0 deposit, FCK only)...');
const result = await account.callFunction({
  contractId: CONTRACT_ACCOUNT,
  methodName: 'request_spend',
  args,
  gas: '400000000000000', // 400 TeraGas: 300 for MPC sign + 50 callback + slack
  deposit: '0',
});
console.log('request_spend outcome:', JSON.stringify(result, null, 2));
const spend = result;
// The callback result reaches the caller as the final value.
const final = spend.functionCalls?.[0]?.args ?? spend;

// Contract returns SpendResult JSON (Blocked or Allowed with signature).
const spendResult = typeof final === 'object' ? final : JSON.parse(final);
if (spendResult.decision === 'Blocked') {
  console.log(`Blocked: ${spendResult.reason}`);
  process.exitCode = 1;
} else {
  const { payload_hash: payloadHash, unsigned_tx: unsignedTx, signature } = spendResult;
  if (payloadHash !== previewHash) {
    throw new Error(
      `payload mismatch: contract ${payloadHash} != preview ${previewHash}`,
    );
  }
  console.log(`payload_hash matches preview: ${payloadHash}`);

  // Step 5: r/s/yParity with EIP-2 low-s normalization.
  const SECP256K1N =
    BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  const point = signature.big_r.affine_point; // compressed 33-byte point
  // r is the x-coordinate: the 32 bytes after the 1-byte prefix.
  let r = BigInt(`0x${point.slice(2)}`);
  let s = BigInt(`0x${signature.s.scalar}`);
  let yParity = signature.recovery_id;
  let normalized = false;
  if (s > SECP256K1N / 2n) {
    s = SECP256K1N - s;
    yParity ^= 1;
    normalized = true;
  }
  console.log(
    `signature: r=0x${r.toString(16)} s=0x${s.toString(16)} yParity=${yParity} (low-s normalization ${normalized ? 'applied' : 'not needed'})`,
  );

  // Step 6: serialize signed tx, recover signer, require match.
  const signed = serializeTransaction(
    {
      type: 'eip1559',
      chainId: 11155111,
      nonce,
      to: DESTINATION.replace('evm:', ''),
      value: BigInt(AMOUNT),
      data: '0x',
      maxFeePerGas: max_fee_per_gas,
      maxPriorityFeePerGas: max_priority_fee_per_gas,
      gas: GAS_LIMIT,
    },
    {
      r: `0x${r.toString(16)}`,
      s: `0x${s.toString(16)}`,
      yParity,
    },
  );
  console.log(`signed tx: ${signed}`);
  const recovered = getAddress(
    await recoverAddress({
      hash: keccak256(`0x${unsignedTx}`),
      signature: {
        r: `0x${r.toString(16)}`,
        s: `0x${s.toString(16)}`,
        yParity,
      },
    }),
  );
  console.log(`recovered signer: ${recovered}`);
  console.log(`derived address: ${fromAddress}`);
  if (recovered.toLowerCase() !== fromAddress.toLowerCase()) {
    throw new Error(
      `signer mismatch: recovered ${recovered} != derived ${fromAddress}`,
    );
  }
  console.log('signer matches derived address.');

  // Step 7: broadcast (unless --no-broadcast).
  if (!(NO_BROADCAST || DRY_RUN)) {
    const destBefore = await publicClient.getBalance({
      address: DESTINATION.replace('evm:', ''),
    });
    const txHash = await publicClient.sendRawTransaction({
      serializedTransaction: signed,
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });
    const destAfter = await publicClient.getBalance({
      address: DESTINATION.replace('evm:', ''),
    });
    console.log(`tx hash: ${txHash}`);
    console.log(`etherscan: https://sepolia.etherscan.io/tx/${txHash}`);
    console.log(`status: ${receipt.status} (block ${receipt.blockNumber})`);
    console.log(
      `destination balance: ${destBefore} -> ${destAfter} (delta ${destAfter - destBefore})`,
    );
  } else {
    console.log('no-broadcast: Sepolia broadcast skipped.');
  }
}

// Step 8: audit + spent.
console.log('audit log:');
console.log(
  await provider.callFunction({
    contractId: CONTRACT_ACCOUNT,
    method: 'get_audit_log',
    args: { from_index: 0, limit: 10 },
  }),
);
console.log('get_spent_today:');
console.log(
  await provider.callFunction({
    contractId: CONTRACT_ACCOUNT,
    method: 'get_spent_today',
    args: { agent_id: AGENT_ACCOUNT },
  }),
);
