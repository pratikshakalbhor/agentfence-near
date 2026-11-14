// agentfence-sdk: minimal TypeScript client for the agentfence contract.
// The agent holds only a function-call key; the SDK never needs (or logs)
// anything beyond that key.
import { contracts, chainAdapters } from 'chainsig.js';
import { Account, JsonRpcProvider } from 'near-api-js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient,
  http,
  serializeTransaction,
  recoverAddress,
  getAddress,
  type Hex,
} from 'viem';
import { sepolia } from 'viem/chains';
import type { PublicClient } from 'viem';

export const MAX_FEE_WEI = 5_000_000_000_000_000n;
export const GAS_LIMIT = 21000n;
export const MIN_MAX_FEE_PER_GAS = 1_000_000_000n; // 1 gwei
export const MIN_MAX_PRIORITY_FEE_PER_GAS = 100_000_000n; // 0.1 gwei
export const SEPOLIA_RPC_DEFAULT = 'https://ethereum-sepolia-rpc.publicnode.com';
export const NEAR_RPC_DEFAULT = 'https://test.rpc.fastnear.com';

export type AgentFenceErrorCode =
  | 'CONFIG'
  | 'ADDRESS_FORMAT'
  | 'FEE_CAP'
  | 'PAYLOAD_MISMATCH'
  | 'SIGNATURE_MISSING'
  | 'SIGNER_MISMATCH'
  | 'NETWORK';

export class AgentFenceError extends Error {
  readonly code: AgentFenceErrorCode;
  constructor(code: AgentFenceErrorCode, message: string) {
    super(message);
    this.name = 'AgentFenceError';
    this.code = code;
  }
}

export interface Policy {
  per_tx_limit: string;
  daily_cap: string;
  paused: boolean;
}

export interface AuditEntry {
  id: number;
  timestamp: number;
  agent_id: string;
  destination: string;
  amount: string;
  decision: 'Allowed' | 'Blocked';
  reason: string | null;
}

export interface PayArgs {
  to: string; // plain 0x… address; SDK adds "evm:" prefix
  amountWei: bigint;
  broadcast?: boolean; // default false
}

export interface PayResult {
  decision: 'Allowed' | 'Blocked';
  reason?: string;
  payloadHash?: string;
  signedTx?: string;
  txHash?: string;
  etherscanUrl?: string;
}

export interface AgentFenceOptions {
  network: 'testnet';
  contractAccount: string;
  agentAccount: string;
  agentKeyFile?: string;
  agentKey?: string;
  evmRpcUrl?: string;
  nearRpcUrl?: string;
  nearRpcUrls?: string[];
}

export interface SpendContractResult {
  decision: 'Allowed' | 'Blocked';
  reason: string | null;
  signature: {
    big_r: { affine_point: string };
    s: { scalar: string };
    recovery_id: number;
  } | null;
  payload_hash: string | null;
  unsigned_tx: string | null;
}

export interface SpendContractArgs {
  destination: string;
  amount: string;
  nonce: number;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  gas_limit: number;
}

/** Normalize "0x…" (or bare-hex) to the contract's "evm:0x…" form. */
export function normalizeDestination(to: string): string {
  const raw = to.startsWith('evm:') ? to.slice(4) : to;
  const hexBody = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (
    !(raw.startsWith('0x') || to.startsWith('evm:')) ||
    hexBody.length !== 40 ||
    ![...hexBody].every((c) => /[0-9a-fA-F]/.test(c))
  ) {
    throw new AgentFenceError(
      'ADDRESS_FORMAT',
      `destination ${JSON.stringify(to)} is not a valid 0x address`,
    );
  }
  return `evm:0x${hexBody.toLowerCase()}`;
}

/** Expand a leading "~" (bare, "~/" or "~\") to os.homedir(). */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

export function publicClientFor(rpcUrl: string = SEPOLIA_RPC_DEFAULT): PublicClient {
  return createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
}

export async function deriveEvmAddress(
  contractAccount: string,
  agentAccount: string,
  rpcUrl: string = SEPOLIA_RPC_DEFAULT,
): Promise<{ address: `0x${string}`; path: string; publicKey: string }> {
  const path = `evm-sepolia-${agentAccount}`;
  const mpcContract = new contracts.ChainSignatureContract({
    networkId: 'testnet',
    contractId: 'v1.signer-prod.testnet',
  });
  const evmChain = new chainAdapters.evm.EVM({
    publicClient: publicClientFor(rpcUrl),
    contract: mpcContract,
  });
  const { address, publicKey } =
    await evmChain.deriveAddressAndPublicKey(contractAccount, path);
  return { address: address as `0x${string}`, path, publicKey };
}

export async function getNonceAndFees(
  address: `0x${string}`,
  rpcUrl: string = SEPOLIA_RPC_DEFAULT,
): Promise<{
  nonce: number;
  max_fee_per_gas: bigint;
  max_priority_fee_per_gas: bigint;
}> {
  const publicClient = publicClientFor(rpcUrl);
  const nonce = await publicClient.getTransactionCount({ address });
  const { maxFeePerGas, maxPriorityFeePerGas } =
    await publicClient.estimateFeesPerGas();
  const bump = (x: bigint) => (x * 110n) / 100n; // round up ~10%
  const max_fee_per_gas = bump(maxFeePerGas) > MIN_MAX_FEE_PER_GAS
    ? bump(maxFeePerGas)
    : MIN_MAX_FEE_PER_GAS;
  const max_priority_fee_per_gas =
    bump(maxPriorityFeePerGas) > MIN_MAX_PRIORITY_FEE_PER_GAS
      ? bump(maxPriorityFeePerGas)
      : MIN_MAX_PRIORITY_FEE_PER_GAS;
  return { nonce, max_fee_per_gas, max_priority_fee_per_gas };
}

export function feeWithinCap(max_fee_per_gas: bigint, gas_limit = 21000): boolean {
  return max_fee_per_gas * BigInt(gas_limit) <= MAX_FEE_WEI;
}

export interface AttachedTx {
  signedTx: Hex;
  lowSApplied: boolean;
  r: bigint;
  s: bigint;
  yParity: number;
}

export function attachSignature(
  spendResult: SpendContractResult,
  args: SpendContractArgs,
): AttachedTx {
  if (!spendResult.signature)
    throw new AgentFenceError(
      'SIGNATURE_MISSING',
      'Allowed result without signature',
    );
  const sig = spendResult.signature;
  const point = sig.big_r.affine_point;
  const r = BigInt(`0x${point.slice(2)}`);
  const SECP256K1N =
    BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
  let s = BigInt(`0x${sig.s.scalar}`);
  let yParity = sig.recovery_id;
  let lowSApplied = false;
  if (s > SECP256K1N / 2n) {
    s = SECP256K1N - s;
    yParity ^= 1;
    lowSApplied = true;
  }
  const signedTx = serializeTransaction(
    {
      type: 'eip1559',
      chainId: 11155111,
      nonce: args.nonce,
      to: (args.destination.replace('evm:', '') as `0x${string}`),
      value: BigInt(args.amount),
      data: '0x',
      maxFeePerGas: BigInt(args.max_fee_per_gas),
      maxPriorityFeePerGas: BigInt(args.max_priority_fee_per_gas),
      gas: BigInt(args.gas_limit),
    },
    { r: `0x${r.toString(16)}`, s: `0x${s.toString(16)}`, yParity },
  );
  return { signedTx, lowSApplied, r, s, yParity };
}

export async function recoverSigner(
  hash32: string,
  attached: AttachedTx,
): Promise<`0x${string}`> {
  const hash = (hash32.startsWith('0x') ? hash32 : `0x${hash32}`) as Hex;
  return getAddress(
    await recoverAddress({
      hash,
      signature: {
        r: `0x${attached.r.toString(16)}`,
        s: `0x${attached.s.toString(16)}`,
        yParity: attached.yParity,
      },
    }),
  );
}

type Deps = {
  deriveEvmAddress: (
    contractAccount: string,
    agentAccount: string,
    rpcUrl: string,
  ) => Promise<{ address: `0x${string}`; path: string; publicKey: string }>;
  getNonceAndFees: (
    address: `0x${string}`,
    rpcUrl: string,
  ) => Promise<{
    nonce: number;
    max_fee_per_gas: bigint;
    max_priority_fee_per_gas: bigint;
  }>;
  nearCallView: (
    method: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>;
  nearRequestSpend: (
    args: SpendContractArgs,
  ) => Promise<SpendContractResult>;
  attachSignature: (
    result: SpendContractResult,
    args: SpendContractArgs,
  ) => AttachedTx;
  recoverSigner: (
    hash32: string,
    attached: AttachedTx,
  ) => Promise<`0x${string}`>;
  broadcastSepolia: (
    signedTx: Hex,
  ) => Promise<{ hash: `0x${string}`; status: string; blockNumber: bigint }>;
};

function parseNearRpcUrls(opts: AgentFenceOptions): string[] {
  const envUrls = (typeof process !== 'undefined' && process.env?.NEAR_RPC_URLS)
    ? process.env.NEAR_RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const envUrl = (typeof process !== 'undefined' && process.env?.NEAR_RPC_URL)
    ? process.env.NEAR_RPC_URL.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const optUrls = Array.isArray(opts.nearRpcUrls) && opts.nearRpcUrls.length
    ? opts.nearRpcUrls.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const optUrl = opts.nearRpcUrl
    ? String(opts.nearRpcUrl).split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const list = optUrls.length ? optUrls : (optUrl.length ? optUrl : (envUrls.length ? envUrls : (envUrl.length ? envUrl : [NEAR_RPC_DEFAULT])));
  return Array.from(new Set(list));
}

function isRetryableRpcError(err: unknown, status?: number): boolean {
  if (status === 429) return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/429|Too Many Requests/i.test(msg)) return true;
  // network/fetch/CORS-like failures
  if (/fetch failed|network|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|timeout/i.test(msg)) return true;
  if (err instanceof TypeError) return true;
  return false;
}

export class AgentFence {
  private readonly opts: AgentFenceOptions;
  private readonly nearRpcUrls: string[];
  private readonly nearRpcSkipUntil = new Map<string, number>();
  private nearRpcLastGood: string;
  private readonly evmRpcUrl: string;
  private readonly fckSecretKey: string;
  private provider: JsonRpcProvider;
  private readonly deps: Deps;

  constructor(opts: AgentFenceOptions) {
    if (opts.network !== 'testnet') {
      throw new AgentFenceError(
        'CONFIG',
        `network ${JSON.stringify(opts.network)} not supported (testnet only)`,
      );
    }
    if (!opts.contractAccount || !opts.agentAccount) {
      throw new AgentFenceError('CONFIG', 'contractAccount and agentAccount are required');
    }
    this.opts = opts;
    this.nearRpcUrls = parseNearRpcUrls(opts);
    this.nearRpcLastGood = this.nearRpcUrls[0];
    this.evmRpcUrl = opts.evmRpcUrl ?? SEPOLIA_RPC_DEFAULT;
    // Secrets are loaded by the caller-provided key material; the key
    // string itself is never logged.
    if (!opts.agentKey && !opts.agentKeyFile) {
      throw new AgentFenceError(
        'CONFIG',
        'agentKeyFile or agentKey (function-call key) is required',
      );
    }
    this.fckSecretKey = opts.agentKey ?? ''; // file case resolved in init()
    this.provider = new JsonRpcProvider({ url: this.nearRpcLastGood });
    this.deps = {
      deriveEvmAddress: (c, a, rpc) => deriveEvmAddress(c, a, rpc),
      getNonceAndFees: (addr, rpc) => getNonceAndFees(addr, rpc),
      nearCallView: (method, args) => this.callViewRpc(method, args),
      nearRequestSpend: async (args) => this.requestSpendRpc(args),
      attachSignature: (result, args) => attachSignature(result, args),
      recoverSigner: (hash, attached) => recoverSigner(hash, attached),
      broadcastSepolia: async (signedTx) =>
        broadcastSepolia(signedTx, this.evmRpcUrl),
    };
  }

  private rpcOrder(): string[] {
    const now = Date.now();
    const available = this.nearRpcUrls.filter((u) => (this.nearRpcSkipUntil.get(u) || 0) <= now);
    const pool = available.length ? available : this.nearRpcUrls.slice();
    const ordered: string[] = [];
    if (pool.includes(this.nearRpcLastGood)) ordered.push(this.nearRpcLastGood);
    for (const u of pool) if (!ordered.includes(u)) ordered.push(u);
    return ordered;
  }

  private async callViewRpc(method: string, args: Record<string, unknown>): Promise<unknown> {
    const body = {
      jsonrpc: '2.0',
      id: 'sdk',
      method: 'query',
      params: {
        request_type: 'call_function',
        account_id: this.opts.contractAccount,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
        finality: 'final',
      },
    };
    let lastErr: unknown = null;
    for (const url of this.rpcOrder()) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 429) {
          this.nearRpcSkipUntil.set(url, Date.now() + 60000);
          lastErr = new Error('RPC HTTP 429');
          continue;
        }
        if (!res.ok) {
          this.nearRpcSkipUntil.set(url, Date.now() + 60000);
          lastErr = new Error(`RPC HTTP ${res.status}`);
          continue;
        }
        const json = await res.json() as any;
        if (json.error) {
          lastErr = new Error(json.error.message || JSON.stringify(json.error));
          continue;
        }
        this.nearRpcLastGood = url;
        this.provider = new JsonRpcProvider({ url });
        const text = new TextDecoder().decode(new Uint8Array(json.result.result));
        return JSON.parse(text);
      } catch (e) {
        this.nearRpcSkipUntil.set(url, Date.now() + 60000);
        lastErr = e;
        continue;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'RPC request failed'));
  }

  private async requestSpendRpc(args: SpendContractArgs): Promise<SpendContractResult> {
    let lastErr: unknown = null;
    const key = await this.resolveFckKey();
    for (const url of this.rpcOrder()) {
      try {
        this.provider = new JsonRpcProvider({ url });
        const account = new Account(this.opts.agentAccount, this.provider, key as never);
        const result = await account.callFunction({
          contractId: this.opts.contractAccount,
          methodName: 'request_spend',
          args: args as unknown as Record<string, unknown>,
          gas: '400000000000000',
          deposit: '0',
        });
        this.nearRpcLastGood = url;
        return result as unknown as SpendContractResult;
      } catch (e) {
        if (isRetryableRpcError(e)) {
          this.nearRpcSkipUntil.set(url, Date.now() + 60000);
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'RPC request failed'));
  }

  private async resolveFckKey(): Promise<string> {
    if (this.opts.agentKey) return this.opts.agentKey;
    // agentKeyFile (often AGENT_FCK_KEY_FILE=~/…) may use a leading "~".
    const file = expandHome(this.opts.agentKeyFile!);
    try {
      const raw = await readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as { secret_key?: string };
      if (parsed?.secret_key) return parsed.secret_key;
      // allow bare "ed25519:…" file contents
      const t = raw.trim();
      if (t.startsWith('ed25519:')) return t;
      throw new AgentFenceError('CONFIG', 'key file has no secret_key field');
    } catch (e) {
      if (e instanceof AgentFenceError) throw e;
      throw new AgentFenceError(
        'CONFIG',
        `could not read agent key file ${file}`,
      );
    }
  }

  private async callView(
    method: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.deps.nearCallView(method, args);
  }

  private async requestSpend(
    args: SpendContractArgs,
  ): Promise<SpendContractResult> {
    return this.deps.nearRequestSpend(args);
  }

  async deriveAddress(): Promise<{ address: string; publicKey: string }> {
    const { address, publicKey } = await this.deps.deriveEvmAddress(
      this.opts.contractAccount,
      this.opts.agentAccount,
      this.evmRpcUrl,
    );
    return { address, publicKey };
  }

  async getPolicy(): Promise<Policy | null> {
    const result = await this.callView('get_policy', {
      agent_id: this.opts.agentAccount,
    });
    return (result as Policy) ?? null;
  }

  async getSpentToday(): Promise<bigint> {
    const result = await this.callView('get_spent_today', {
      agent_id: this.opts.agentAccount,
    });
    return BigInt((result as string) ?? '0');
  }

  async getAuditLog(opts?: { from?: number; limit?: number }): Promise<AuditEntry[]> {
    const result = await this.callView('get_audit_log', {
      from_index: opts?.from ?? 0,
      limit: opts?.limit ?? 50,
    });
    return result as AuditEntry[];
  }

  async preview(args: PayArgs): Promise<{ payloadHash: string } | null> {
    const derived = await this.deps.deriveEvmAddress(
      this.opts.contractAccount,
      this.opts.agentAccount,
      this.evmRpcUrl,
    );
    const fees = await this.deps.getNonceAndFees(derived.address, this.evmRpcUrl);
    if (!feeWithinCap(fees.max_fee_per_gas)) return null;
    const spendArgs = buildSpendArgs(
      normalizeDestination(args.to),
      args.amountWei.toString(),
      fees.nonce,
      fees.max_fee_per_gas,
      fees.max_priority_fee_per_gas,
    );
    const previewHash = (await this.callView(
      'preview_payload',
      spendArgs as unknown as Record<string, unknown>,
    )) as string;
    return { payloadHash: previewHash };
  }

  async pay(args: PayArgs): Promise<PayResult> {
    const destination = normalizeDestination(args.to);
    const derived = await this.deps.deriveEvmAddress(
      this.opts.contractAccount,
      this.opts.agentAccount,
      this.evmRpcUrl,
    );
    const fees = await this.deps.getNonceAndFees(derived.address, this.evmRpcUrl);
    if (!feeWithinCap(fees.max_fee_per_gas)) {
      throw new AgentFenceError(
        'FEE_CAP',
        `fee ${fees.max_fee_per_gas * GAS_LIMIT} exceeds MAX_FEE_WEI ${MAX_FEE_WEI}`,
      );
    }
    const spendArgs = buildSpendArgs(
      destination,
      args.amountWei.toString(),
      fees.nonce,
      fees.max_fee_per_gas,
      fees.max_priority_fee_per_gas,
    );

    const previewHash = (await this.callView(
      'preview_payload',
      spendArgs as unknown as Record<string, unknown>,
    )) as string;

    const result = await this.requestSpend(spendArgs);

    if (result.decision === 'Blocked') {
      return { decision: 'Blocked', reason: result.reason ?? undefined };
    }

    if (!result.payload_hash || result.payload_hash !== previewHash) {
      throw new AgentFenceError(
        'PAYLOAD_MISMATCH',
        `payload mismatch: on-chain ${result.payload_hash} != preview ${previewHash}`,
      );
    }

    const attached = this.deps.attachSignature(result, spendArgs);
    const recovered = await this.deps.recoverSigner(
      result.payload_hash,
      attached,
    );
    if (recovered.toLowerCase() !== derived.address.toLowerCase()) {
      throw new AgentFenceError(
        'SIGNER_MISMATCH',
        `signer mismatch: recovered ${recovered} != derived ${derived.address}`,
      );
    }

    const out: PayResult = {
      decision: 'Allowed',
      payloadHash: result.payload_hash,
      signedTx: attached.signedTx,
    };
    if (args.broadcast) {
      const { hash, status } = await this.deps.broadcastSepolia(
        attached.signedTx,
      );
      out.txHash = hash;
      out.etherscanUrl = `https://sepolia.etherscan.io/tx/${hash}`;
      void status;
    }
    return out;
  }
}

function buildSpendArgs(
  destination: string,
  amount: string,
  nonce: number,
  max_fee_per_gas: bigint,
  max_priority_fee_per_gas: bigint,
): SpendContractArgs {
  return {
    destination,
    amount,
    nonce,
    max_fee_per_gas: max_fee_per_gas.toString(),
    max_priority_fee_per_gas: max_priority_fee_per_gas.toString(),
    gas_limit: 21000,
  };
}

async function broadcastSepolia(
  signedTx: Hex,
  rpcUrl: string,
): Promise<{ hash: `0x${string}`; status: string; blockNumber: bigint }> {
  const publicClient = publicClientFor(rpcUrl);
  const hash = await publicClient.sendRawTransaction({
    serializedTransaction: signedTx,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status, blockNumber: receipt.blockNumber };
}
