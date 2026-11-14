import { describe, it, expect, vi, beforeEach } from 'vitest';

const callFunctionMock = vi.fn();
const accountCtorUrls: string[] = [];

vi.mock('near-api-js', async () => {
  class JsonRpcProvider {
    url: string;
    constructor(opts: { url: string }) {
      this.url = opts.url;
    }
  }
  class Account {
    constructor(_accountId: string, provider: any, _key: string) {
      accountCtorUrls.push(provider?.url);
    }
    async callFunction(args: any) {
      return callFunctionMock(args, this);
    }
  }
  return { JsonRpcProvider, Account };
});

import { AgentFence } from '../src/index.js';

function makeClient(urls: string[]) {
  accountCtorUrls.length = 0;
  callFunctionMock.mockReset();
  return new AgentFence({
    network: 'testnet',
    contractAccount: 'contract.testnet',
    agentAccount: 'agent.testnet',
    agentKey: 'ed25519:dummy',
    nearRpcUrls: urls,
  });
}

const spendArgs = {
  destination: 'evm:0x1111111111111111111111111111111111111111',
  amount: '1',
  nonce: 0,
  max_fee_per_gas: '1',
  max_priority_fee_per_gas: '1',
  gas_limit: 21000,
};

describe('request_spend RPC retry safety', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('retries on 429 from first endpoint and succeeds on second', async () => {
    const client = makeClient(['https://rpc1.test', 'https://rpc2.test']);
    callFunctionMock
      .mockRejectedValueOnce(new Error('RPC HTTP 429 Too Many Requests'))
      .mockResolvedValueOnce({ decision: 'Blocked', reason: 'x', signature: null, payload_hash: null, unsigned_tx: null });

    const result = await (client as any).requestSpendRpc(spendArgs);
    expect(result.decision).toBe('Blocked');
    expect(callFunctionMock).toHaveBeenCalledTimes(2);
    expect(accountCtorUrls).toEqual(['https://rpc1.test', 'https://rpc2.test']);
  });

  it('does not retry on timeout after sending and instructs to check audit', async () => {
    const client = makeClient(['https://rpc1.test', 'https://rpc2.test']);
    callFunctionMock.mockRejectedValueOnce(new Error('request timed out after sending'));

    await expect((client as any).requestSpendRpc(spendArgs)).rejects.toMatchObject({
      message: expect.stringContaining('check `agentfence audit` before trying again'),
    });
    expect(callFunctionMock).toHaveBeenCalledTimes(1);
    expect(accountCtorUrls).toEqual(['https://rpc1.test']);
  });
});
