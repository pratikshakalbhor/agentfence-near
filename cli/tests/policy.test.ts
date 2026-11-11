// Offline unit tests: pure validation and command building (+ apply
// logic with injected runners). No network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validatePolicy,
  buildOwnerCommands,
  type PolicyFile,
} from '../src/policy.js';
import { applyPolicy } from '../src/apply.js';

const GOOD = {
  contract: 'agentfence-contract-evm-0b497ae1.testnet',
  owner: 'agentfence-owner-9a9635f2.testnet',
  agent: 'agentfence-agent-9a9635f2.testnet',
  perTxLimitWei: '10000000000000000',
  dailyCapWei: '50000000000000000',
  allowlist: ['evm:0x1111111111111111111111111111111111111111'],
  paused: false,
};

describe('validatePolicy', () => {
  it('accepts a good policy', () => {
    const p = validatePolicy(structuredClone(GOOD));
    expect(p.perTxLimitWei).toBe('10000000000000000');
    expect(p.allowlist).toHaveLength(1);
  });

  it('rejects non-integer amounts', () => {
    const bad = { ...structuredClone(GOOD), perTxLimitWei: '10.5' };
    expect(() => validatePolicy(bad)).toThrowError(/positive integer string/);
  });

  it('rejects zero amounts', () => {
    const bad = { ...structuredClone(GOOD), dailyCapWei: '0' };
    expect(() => validatePolicy(bad)).toThrowError(/> 0/);
  });

  it('rejects perTxLimitWei > dailyCapWei', () => {
    const bad = {
      ...structuredClone(GOOD),
      perTxLimitWei: '6',
      dailyCapWei: '5',
    };
    expect(() => validatePolicy(bad)).toThrowError(/perTxLimitWei must be <= dailyCapWei/);
  });

  it('rejects bad allowlist addresses', () => {
    const bad = {
      ...structuredClone(GOOD),
      allowlist: ['evm:0x1234'],
    };
    expect(() => validatePolicy(bad)).toThrowError(/valid 0x or evm:0x/);
    const bad2 = { ...structuredClone(GOOD), allowlist: ['garbage'] };
    expect(() => validatePolicy(bad2)).toThrowError(/valid 0x or evm:0x/);
  });

  it('normalizes plain 0x allowlist items to the evm:0x form', () => {
    const p = validatePolicy({
      ...structuredClone(GOOD),
      allowlist: ['0x1111111111111111111111111111111111111111'],
    });
    expect(p.allowlist).toEqual([
      'evm:0x1111111111111111111111111111111111111111',
    ]);
  });

  it('rejects missing fields and non-boolean paused', () => {
    const { contract, ...rest } = structuredClone(GOOD) as PolicyFile &
      Record<string, unknown>;
    void contract;
    expect(() => validatePolicy(rest)).toThrowError(/missing "contract"/);
    const bad = { ...structuredClone(GOOD), paused: 'yes' };
    expect(() => validatePolicy(bad)).toThrowError(/paused/);
  });
});

describe('buildOwnerCommands', () => {
  it('builds set_policy, add_destination*, set_paused in order', () => {
    const p: PolicyFile = {
      ...structuredClone(GOOD),
      allowlist: [
        'evm:0x1111111111111111111111111111111111111111',
        'evm:0x2222222222222222222222222222222222222222',
      ],
    };
    const commands = buildOwnerCommands(p, p.allowlist);
    expect(commands.map((c) => c.method)).toEqual([
      'set_policy',
      'add_destination',
      'add_destination',
      'set_paused',
    ]);
    const setPolicy = JSON.parse(commands[0]!.argsJson);
    expect(setPolicy.per_tx_limit).toBe('10000000000000000');
    expect(setPolicy.daily_cap).toBe('50000000000000000');
    const add = JSON.parse(commands[2]!.argsJson);
    expect(add.destination).toBe('evm:0x2222222222222222222222222222222222222222');
    const paused = JSON.parse(commands[3]!.argsJson);
    expect(paused.paused).toBe(false);
  });
});

describe('applyPolicy', () => {
  let logs: string[] = [];
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) =>
      logs.push(a.join(' ')),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('skips destinations that are already allowed', async () => {
    const runCommand = vi.fn(async () => {});
    await applyPolicy({
      policy: {
        ...structuredClone(GOOD),
        allowlist: [
          'evm:0x1111111111111111111111111111111111111111',
          'evm:0x2222222222222222222222222222222222222222',
        ],
      },
      dryRun: false,
      runCommand,
      checkAllowed: async (_c, _a, dest) =>
        dest === 'evm:0x1111111111111111111111111111111111111111',
    });
    expect(logs.some((l) => l.includes('skip (already allowed)'))).toBe(true);
    const methods = ((runCommand.mock as unknown as { calls: unknown[][] }).calls.map(
      (call) => (call[0] as { method: string }).method,
    ) as string[]);
    expect(methods).toEqual(['set_policy', 'add_destination', 'set_paused']);
  });

  it('dry-run prints commands and runs nothing', async () => {
    const runCommand = vi.fn(async () => {});
    await applyPolicy({
      policy: structuredClone(GOOD) as PolicyFile,
      dryRun: true,
      runCommand,
      checkAllowed: async () => false,
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('[dry-run]'))).toBe(true);
  });
});
