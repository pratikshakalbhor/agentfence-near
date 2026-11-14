// Offline unit tests: all network seams are replaced with mocks.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Account, KeyPair } from 'near-api-js';
import {
  AgentFence,
  AgentFenceError,
  normalizeDestination,
  feeWithinCap,
  attachSignature,
  GAS_LIMIT,
  MAX_FEE_WEI,
  type SpendContractResult,
} from '../src/index.js';

const TEST_FCK_KEY = KeyPair.fromRandom('ed25519').toString();

afterEach(() => {
  vi.restoreAllMocks();
});

const DERIVED = '0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57' as const;
const OTHER = '0x1111111111111111111111111111111111111111' as const;

function makeClient(overrides: Partial<Record<string, unknown>> = {}) {
  const client = new AgentFence({
    network: 'testnet',
    contractAccount: 'agentfence-contract-evm-0b497ae1.testnet',
    agentAccount: 'agentfence-agent-9a9635f2.testnet',
    agentKey: 'ed25519:dummy',
  });
  const deps = (client as unknown as { deps: Record<string, unknown> }).deps;
  Object.assign(deps, overrides);
  return { client, deps };
}

const allowedResult = (): SpendContractResult => ({
  decision: 'Allowed',
  reason: null,
  signature: {
    big_r: { affine_point: '03d7d9558b3d9f19ffddce530f86754b180bc96517547e126174bb24b94e0bcbb9' },
    s: { scalar: '20bb7e728ea91809eb332daa03750c9f7cc51525bddc43b2019f016904255974' },
    recovery_id: 1,
  },
  payload_hash: 'd9771201b2a1aebc787173a805a53c589501125aa5121714b585d4b1a36951fa',
  unsigned_tx:
    '02e983aa36a780021782520894111111111111111111111111111111111187038d7ea4c6800080c0',
});

const evmDeps: Record<string, unknown> = {
  deriveEvmAddress: async () => ({
    address: DERIVED,
    path: 'evm-sepolia-agentfence-agent-9a9635f2.testnet',
    publicKey: '04abc',
  }),
  getNonceAndFees: async () => ({
    nonce: 0,
    max_fee_per_gas: 1_000_000_000n,
    max_priority_fee_per_gas: 100_000_000n,
  }),
  nearCallView: async (method: string) => {
    if (method === 'preview_payload') return 'd9771201b2a1aebc787173a805a53c589501125aa5121714b585d4b1a36951fa';
    return null;
  },
  broadcastSepolia: async () => ({
    hash: '0xhashhashhashhashhashhashhashhashhashhashhashhashhashhashhashhash' as `0x${string}`,
    status: 'success',
    blockNumber: 1n,
  }),
};

describe('normalizeDestination', () => {
  it('normalizes 0x to evm:0x', () => {
    expect(normalizeDestination(OTHER)).toBe(`evm:${OTHER}`);
  });
  it('rejects bad input', () => {
    for (const bad of ['garbage', 'evm:0x123', `0x${'z'.repeat(40)}`]) {
      expect(() => normalizeDestination(bad)).toThrowError(
        expect.objectContaining({ code: 'ADDRESS_FORMAT' }),
      );
    }
  });
});

describe('feeWithinCap', () => {
  it('accepts small fees, rejects above cap', () => {
    expect(feeWithinCap(1_000_000_000n)).toBe(true);
    expect(feeWithinCap((MAX_FEE_WEI / GAS_LIMIT) + 1n)).toBe(false);
  });
});

describe('AgentFence.pay', () => {
  it('returns Blocked without throwing', async () => {
    const { client } = makeClient({
      ...evmDeps,
      nearRequestSpend: async (): Promise<SpendContractResult> => ({
        decision: 'Blocked',
        reason: 'destination not allowlisted',
        signature: null,
        payload_hash: null,
        unsigned_tx: null,
      }),
    });
    const result = await client.pay({
      to: OTHER,
      amountWei: 50n,
    });
    expect(result).toEqual({
      decision: 'Blocked',
      reason: 'destination not allowlisted',
    });
  });

  it('throws SIGNER_MISMATCH when recovered != derived', async () => {
    const { client } = makeClient({
      ...evmDeps,
      nearRequestSpend: async (): Promise<SpendContractResult> => allowedResult(),
      recoverSigner: async () => OTHER,
    });
    await expect(
      client.pay({ to: OTHER, amountWei: 50n }),
    ).rejects.toMatchObject({ code: 'SIGNER_MISMATCH' });
  });

  it('refuses fees above the cap locally before any NEAR call', async () => {
    const nearRequest = vi.fn(async () => allowedResult());
    const { client } = makeClient({
      ...evmDeps,
      getNonceAndFees: async () => ({
        nonce: 0,
        max_fee_per_gas: 10_000_000_000_000n,
        max_priority_fee_per_gas: 100_000_000n,
      }),
      nearRequestSpend: nearRequest,
    });
    await expect(
      client.pay({ to: OTHER, amountWei: 50n }),
    ).rejects.toMatchObject({ code: 'FEE_CAP' });
    expect(nearRequest).not.toHaveBeenCalled();
  });

  it('broadcasts when asked and returns etherscan URL', async () => {
    const { client } = makeClient({
      ...evmDeps,
      nearRequestSpend: async (): Promise<SpendContractResult> => allowedResult(),
      recoverSigner: async () => DERIVED,
    });
    const result = await client.pay({
      to: OTHER,
      amountWei: 50n,
      broadcast: true,
    });
    expect(result.decision).toBe('Allowed');
    expect(result.txHash).toBe(
      '0xhashhashhashhashhashhashhashhashhashhashhashhashhashhashhashhash',
    );
    expect(result.etherscanUrl).toBe(
      'https://sepolia.etherscan.io/tx/0xhashhashhashhashhashhashhashhashhashhashhashhashhashhashhashhash',
    );
  });

  it('genuine block: does not broadcast', async () => {
    const broadcastSepolia = vi.fn(async () => ({
      hash: '0xhash' as const,
      status: 'success',
      blockNumber: 1n,
    }));
    const { client } = makeClient({
      ...evmDeps,
      nearRequestSpend: async (): Promise<SpendContractResult> => ({
        decision: 'Blocked',
        reason: 'fee exceeds max_fee_cap',
        signature: null,
        payload_hash: null,
        unsigned_tx: null,
      }),
      broadcastSepolia,
    });
    const result = await client.pay({
      to: OTHER,
      amountWei: 50n,
      broadcast: true,
    });
    expect(result.decision).toBe('Blocked');
    expect(broadcastSepolia).not.toHaveBeenCalled();
  });
});

describe('attachSignature', () => {
  it('serializes an EIP-1559 tx without a signature field', () => {
    const attached = attachSignature(allowedResult(), {
      destination: `evm:0x1111111111111111111111111111111111111111`,
      amount: '50',
      nonce: 0,
      max_fee_per_gas: '1000000000',
      max_priority_fee_per_gas: '100000000',
      gas_limit: 21000,
    });
    expect(attached.signedTx).toMatch(/^0x02/);
  });
});

describe('request_spend failover', () => {
  const spendArgs = {
    destination: `evm:${OTHER}`,
    amount: '50',
    nonce: 0,
    max_fee_per_gas: '1000000000',
    max_priority_fee_per_gas: '100000000',
    gas_limit: 21000,
  };

  function makeRpcClient() {
    const client = new AgentFence({
      network: 'testnet',
      contractAccount: 'agentfence-contract-evm-0b497ae1.testnet',
      agentAccount: 'agentfence-agent-9a9635f2.testnet',
      agentKey: TEST_FCK_KEY,
      nearRpcUrls: ['https://rpc1.example', 'https://rpc2.example'],
    });
    return client as unknown as {
      requestSpendRpc: (args: typeof spendArgs) => Promise<SpendContractResult>;
      provider: { connection?: { url?: string } };
    };
  }

  it('retries on HTTP 429 before processing and uses the next endpoint', async () => {
    const client = makeRpcClient();
    const call = vi
      .spyOn(Account.prototype, 'callFunction')
      .mockRejectedValueOnce(new Error('RPC HTTP 429 Too Many Requests'))
      .mockResolvedValueOnce(allowedResult() as never);

    const result = await client.requestSpendRpc(spendArgs);

    expect(result.decision).toBe('Allowed');
    expect(call).toHaveBeenCalledTimes(2);
    expect((client.provider as any).connection?.url).toBe('https://rpc2.example');
  });

  it('does not retry on timeout after sending and surfaces audit guidance', async () => {
    const client = makeRpcClient();
    const call = vi
      .spyOn(Account.prototype, 'callFunction')
      .mockRejectedValueOnce(new Error('request timed out'));

    await expect(client.requestSpendRpc(spendArgs)).rejects.toMatchObject({
      code: 'NETWORK',
      message: expect.stringContaining('check `agentfence audit` before trying again'),
    });
    expect(call).toHaveBeenCalledTimes(1);
  });
});
