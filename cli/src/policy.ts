// Policy file parsing/validation and owner-command construction.
// No network access in this module: pure functions, testable offline.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export interface PolicyFile {
  contract: string;
  owner: string;
  agent: string;
  perTxLimitWei: string;
  dailyCapWei: string;
  allowlist: string[];
  paused: boolean;
}

function error(message: string): Error {
  return new Error(message);
}

export function validatePolicy(raw: unknown): PolicyFile {
  if (typeof raw !== 'object' || raw === null) {
    throw error('policy must be a JSON object');
  }
  const p = raw as Record<string, unknown>;
  for (const key of ['contract', 'owner', 'agent', 'perTxLimitWei', 'dailyCapWei', 'allowlist', 'paused']) {
    if (p[key] === undefined) throw error(`policy is missing "${key}"`);
  }
  for (const key of ['contract', 'owner', 'agent'] as const) {
    if (typeof p[key] !== 'string' || p[key].length === 0) {
      throw error(`policy "${key}" must be a non-empty string`);
    }
  }
  for (const key of ['perTxLimitWei', 'dailyCapWei'] as const) {
    const v = p[key];
    if (typeof v !== 'string' || !/^(0|[1-9]\d*)$/.test(v)) {
      throw error(`policy "${key}" must be a positive integer string (wei)`);
    }
    if (BigInt(v) <= 0n) throw error(`policy "${key}" must be > 0`);
  }
  if (BigInt(p.perTxLimitWei as string) > BigInt(p.dailyCapWei as string)) {
    throw error('policy perTxLimitWei must be <= dailyCapWei');
  }
  if (!Array.isArray(p.allowlist)) {
    throw error('policy "allowlist" must be an array of 0x addresses');
  }
  for (const dest of p.allowlist as unknown[]) {
    if (typeof dest !== 'string' || !/^(0x|evm:0x)[0-9a-fA-F]{40}$/.test(dest)) {
      throw error(
        `allowlist item ${JSON.stringify(dest)} is not a valid 0x or evm:0x address`,
      );
    }
  }
  if (typeof p.paused !== 'boolean') {
    throw error('policy "paused" must be a boolean');
  }
  return {
    contract: p.contract as string,
    owner: p.owner as string,
    agent: p.agent as string,
    perTxLimitWei: p.perTxLimitWei as string,
    dailyCapWei: p.dailyCapWei as string,
    allowlist: (p.allowlist as string[]).map(normalizeAllowlistItem),
    paused: p.paused as boolean,
  };
}

/** "0x…" and "evm:0x…" both normalize to the contract's "evm:0x…" form. */
export function normalizeAllowlistItem(destination: string): string {
  return destination.startsWith('evm:') ? destination : `evm:${destination}`;
}

export async function loadPolicyFile(path: string): Promise<PolicyFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw error(
      `could not read/parse policy file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return validatePolicy(parsed);
}

export interface OwnerCommand {
  method: string;
  argsJson: string;
  description: string;
}

/** Owner commands, in apply order: set_policy, add_destination*, set_paused. */
export function buildOwnerCommands(
  policy: PolicyFile,
  destinationsToAdd: string[],
): OwnerCommand[] {
  const commands: OwnerCommand[] = [
    {
      method: 'set_policy',
      argsJson: JSON.stringify({
        agent_id: policy.agent,
        per_tx_limit: policy.perTxLimitWei,
        daily_cap: policy.dailyCapWei,
      }),
      description: `set_policy(agent=${policy.agent}, per_tx_limit=${policy.perTxLimitWei}, daily_cap=${policy.dailyCapWei})`,
    },
  ];
  for (const dest of destinationsToAdd) {
    commands.push({
      method: 'add_destination',
      argsJson: JSON.stringify({
        agent_id: policy.agent,
        destination: dest,
      }),
      description: `add_destination(agent=${policy.agent}, destination=${dest})`,
    });
  }
  commands.push({
    method: 'set_paused',
    argsJson: JSON.stringify({
      agent_id: policy.agent,
      paused: policy.paused,
    }),
    description: `set_paused(agent=${policy.agent}, paused=${policy.paused})`,
  });
  return commands;
}

/** Render the exact near command (json-args form) for display. */
export function renderNearCommand(
  contract: string,
  owner: string,
  command: OwnerCommand,
): string {
  return [
    'near',
    'contract',
    'call-function',
    'as-transaction',
    contract,
    command.method,
    'json-args',
    `'${command.argsJson}'`,
    'prepaid-gas',
    "'100 TeraGas'",
    'attached-deposit',
    "'0 NEAR'",
    `sign-as ${owner}`,
    'network-config',
    'testnet',
    'sign-with-keychain',
    'send',
  ].join(' ');
}

/** Owner signed calls go ONLY through the installed near CLI; the owner
 *  key stays in the user's keychain (the CLI signs with sign-with-keychain).
 *  No key material is read by this tool. */
export function execOwnerCommand(
  contract: string,
  owner: string,
  command: OwnerCommand,
): void {
  execFileSync(
    'near',
    [
      'contract',
      'call-function',
      'as-transaction',
      contract,
      command.method,
      'json-args',
      command.argsJson,
      'prepaid-gas',
      '100 TeraGas',
      'attached-deposit',
      '0 NEAR',
      'sign-as',
      owner,
      'network-config',
      'testnet',
      'sign-with-keychain',
      'send',
    ],
    { stdio: 'inherit' },
  );
}
