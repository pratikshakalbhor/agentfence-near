// Offline unit tests: the SDK is mocked, no network.
import { describe, it, expect, vi } from 'vitest';
import { loadConfig, registerTools } from '../src/index.js';

function fakeFence(result: Record<string, unknown>) {
  return {
    pay: vi.fn(async () => ({
      decision: 'Blocked',
      reason: 'destination not allowlisted',
      ...result,
    })),
    getPolicy: vi.fn(async () => ({
      per_tx_limit: '10000000000000000',
      daily_cap: '50000000000000000',
      paused: false,
    })),
    getSpentToday: vi.fn(async () => 8000000000000100n),
    getAuditLog: vi.fn(async () => []),
    deriveAddress: vi.fn(async () => ({
      address: '0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57',
      publicKey: '04abc',
    })),
  };
}

function fakeServer(): { tools: Map<string, any>; registerTool: any } {
  const tools = new Map<string, any>();
  return {
    tools,
    registerTool: (name: string, def: unknown, handler: unknown) =>
      tools.set(name, { ...((def ?? {}) as object), handler }),
  };
}

function getPay(server: ReturnType<typeof fakeServer>) {
  return server.tools.get('pay') as any;
}

describe('agentfence-mcp tools', () => {
  it('Blocked is returned as a normal result (not an MCP error)', async () => {
    const fence = fakeFence({});
    const server = fakeServer();
    registerTools(server as never, { allowBroadcast: false, fence: fence as never });
    const pay = getPay(server);
    const out = await pay.handler({
      to: '0x2222222222222222222222222222222222222222',
      amount_wei: '50000000000000000',
    });
    expect(out.isError).toBeUndefined();
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.decision).toBe('Blocked');
    expect(parsed.reason).toBe('destination not allowlisted');
    expect(fence.pay).toHaveBeenCalledWith({
      to: '0x2222222222222222222222222222222222222222',
      amountWei: 50000000000000000n,
      broadcast: false,
    });
  });

  it('non-numeric amount is rejected by schema validation (not the SDK)', async () => {
    const fence = fakeFence({});
    const server = fakeServer();
    registerTools(server as never, { allowBroadcast: false, fence: fence as never });
    const pay = getPay(server);
    await expect(
      pay.handler({
        to: '0x1111111111111111111111111111111111111111',
        amount_wei: 'not-a-number',
      }),
    ).rejects.toThrowError();
  });

  it('bigint-overflow amount is rejected by the refine', async () => {
    const fence = fakeFence({});
    const server = fakeServer();
    registerTools(server as never, { allowBroadcast: false, fence: fence as never });
    const pay = getPay(server);
    expect(() =>
      pay.inputSchema.parse({
        to: '0x1111111111111111111111111111111111111111',
        amount_wei: '99999999999999999999999999999999999999999', // 10^39
      }),
    ).toThrowError();
    expect(fence.pay).not.toHaveBeenCalled();
  });

  it('broadcast is refused without --allow-broadcast', async () => {
    const fence = fakeFence({
      decision: 'Allowed',
      payloadHash: 'abc',
      signedTx: '0x02',
    });
    const server = fakeServer();
    registerTools(server as never, { allowBroadcast: false, fence: fence as never });
    const pay = getPay(server);
    const out = await pay.handler({
      to: '0x1111111111111111111111111111111111111111',
      amount_wei: '1000000000000000',
      broadcast: true, // not a tool field; ignored by the tool
    });
    expect(fence.pay).toHaveBeenCalled();
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.txHash).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('requires env keys only', () => {
    expect(() =>
      loadConfig({
        CONTRACT_ACCOUNT: 'c',
        AGENT_ACCOUNT: 'a',
        AGENT_FCK_KEY_FILE: 'f',
      }),
    ).not.toThrow();
    expect(() => loadConfig({})).toThrowError(
      expect.objectContaining({ message: expect.stringContaining('CONTRACT_ACCOUNT') }),
    );
  });
});
