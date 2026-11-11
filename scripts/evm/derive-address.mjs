// Derive the Sepolia EVM address controlled by the agentfence contract for
// a given agent, via the testnet Chain Signatures MPC contract.
//
// The foreign address is derived from three inputs:
//   1. the NEAR account that calls `sign` (CONTRACT_ACCOUNT — the
//      agentfence contract, NOT the agent),
//   2. the derivation path "evm-sepolia-<AGENT_ACCOUNT>",
//   3. the MPC master public key (fetched by the library over RPC).
// For keygen, this is exactly the derivation path our contract uses in
// `request_spend`, so the address below is the one the MPC would sign for
// that contract. No private key is involved or stored — that is the point.
//
// Usage:
//   node derive-address.mjs <CONTRACT_ACCOUNT> <AGENT_ACCOUNT>
//   CONTRACT_ACCOUNT=... AGENT_ACCOUNT=... node derive-address.mjs
//
// Optional: SEPOLIA_RPC_URL (default: https://ethereum-sepolia-rpc.publicnode.com)
import { contracts, chainAdapters } from 'chainsig.js';
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';

const [contractAccount, agentAccount] = process.argv.slice(2);
const CONTRACT_ACCOUNT = contractAccount || process.env.CONTRACT_ACCOUNT;
const AGENT_ACCOUNT = agentAccount || process.env.AGENT_ACCOUNT;
const rpcUrl =
  process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';

if (!CONTRACT_ACCOUNT || !AGENT_ACCOUNT) {
  throw new Error(
    'Usage: node derive-address.mjs <CONTRACT_ACCOUNT> <AGENT_ACCOUNT>\n' +
      '   or set CONTRACT_ACCOUNT and AGENT_ACCOUNT env vars.',
  );
}

const path = `evm-sepolia-${AGENT_ACCOUNT}`;

const contract = new contracts.ChainSignatureContract({
  networkId: 'testnet',
  contractId: 'v1.signer-prod.testnet',
});

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(rpcUrl),
});

const evmChain = new chainAdapters.evm.EVM({
  publicClient,
  contract,
});

const { address, publicKey } =
  await evmChain.deriveAddressAndPublicKey(CONTRACT_ACCOUNT, path);
const { balance, decimals } = await evmChain.getBalance(address);

console.log(`contract_account: ${CONTRACT_ACCOUNT}`);
console.log(`agent_account: ${AGENT_ACCOUNT}`);
console.log(`path: ${path}`);
console.log(`address: ${address}`);
console.log(`public_key: ${publicKey}`);
console.log(`balance: ${balance} (decimals ${decimals})`);
