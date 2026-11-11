// Regression: the RPC returns fees as bigint and they must flow through
// BigInt-only comparisons. Math.max()/Number()-style handling of bigint
// values throws TypeError — the bug that crashed scripts/evm/send.mjs —
// so every assertion here fails on such code.
import { describe, it, expect, vi } from 'vitest';
import { createPublicClient } from 'viem';

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(),
  };
});

import {
  getNonceAndFees,
  MIN_MAX_FEE_PER_GAS,
  MIN_MAX_PRIORITY_FEE_PER_GAS,
} from '../src/index.js';

const ADDR = '0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57' as `0x${string}`;

type RpcFees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

function stubRpc(fees: RpcFees, nonce = 7): void {
  (createPublicClient as unknown as { mockReturnValue(v: unknown): void }).mockReturnValue({
    getTransactionCount: async () => nonce,
    estimateFeesPerGas: async () => fees,
  });
}

describe('getNonceAndFees (RPC fees as bigint)', () => {
  it('bumps bigint fees with BigInt-only math and applies the priority floor', async () => {
    stubRpc({ maxFeePerGas: 1_234_567_890n, maxPriorityFeePerGas: 55_000_000n }, 7);
    const fees = await getNonceAndFees(ADDR);
    expect(fees.nonce).toBe(7);
    expect(typeof fees.max_fee_per_gas).toBe('bigint');
    expect(typeof fees.max_priority_fee_per_gas).toBe('bigint');
    // (1_234_567_890n * 110n) / 100n = 1_358_024_679n — exact BigInt arithmetic
    expect(fees.max_fee_per_gas).toBe(1_358_024_679n);
    // bumped 60_500_000n is below the 0.1 gwei floor → floor applies
    expect(fees.max_priority_fee_per_gas).toBe(MIN_MAX_PRIORITY_FEE_PER_GAS);
  });

  it('keeps precision for fees above Number.MAX_SAFE_INTEGER (no Number() conversion)', async () => {
    stubRpc({ maxFeePerGas: 12_345_678_912_345_678n, maxPriorityFeePerGas: 1_000_000_000n });
    const fees = await getNonceAndFees(ADDR);
    // (12_345_678_912_345_678n * 110n) / 100n = 13_580_246_803_580_245n
    // (Number() rounding would land on …246 or lose precision entirely)
    expect(fees.max_fee_per_gas).toBe(13_580_246_803_580_245n);
    expect(fees.max_priority_fee_per_gas).toBe(1_100_000_000n);
  });

  it('floors below-minimum bigint fees at the exported minimums', async () => {
    stubRpc({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    const fees = await getNonceAndFees(ADDR);
    expect(fees.max_fee_per_gas).toBe(MIN_MAX_FEE_PER_GAS);
    expect(fees.max_priority_fee_per_gas).toBe(MIN_MAX_PRIORITY_FEE_PER_GAS);
  });

  it('passes bumped fees through unchanged when above both floors', async () => {
    stubRpc({ maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
    const fees = await getNonceAndFees(ADDR);
    expect(fees.max_fee_per_gas).toBe(2_200_000_000n);
    expect(fees.max_priority_fee_per_gas).toBe(1_100_000_000n);
  });
});
