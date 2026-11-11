#!/usr/bin/env node
// agentfence CLI: reads through agentfence-sdk; owner-signed writes go
// through the installed `near` CLI only (owner keystays in the keychain).
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { AgentFence } from 'agentfence-sdk';
import {
  loadPolicyFile,
  execOwnerCommand,
  type OwnerCommand,
  type PolicyFile,
} from './policy.js';
import { applyPolicy } from './apply.js';

const argv = process.argv.slice(2);
const program = new Command();
program
  .name('agentfence')
  .description('agentfence command-line tool (SDK for reads, near CLI for owner writes)');

const config = {
  contractAccount: process.env.CONTRACT_ACCOUNT ?? '',
  agentAccount: process.env.AGENT_ACCOUNT ?? '',
  evmRpcUrl: process.env.SEPOLIA_RPC_URL ?? undefined,
  nearRpcUrl: process.env.NEAR_RPC_URL ?? undefined,
};

function fence(): AgentFence {
  const fckFile = process.env.AGENT_FCK_KEY_FILE;
  if (!fckFile) {
    throw new Error('AGENT_FCK_KEY_FILE is required (path outside the repo)');
  }
  return new AgentFence({
    network: 'testnet',
    contractAccount: config.contractAccount,
    agentAccount: config.agentAccount,
    agentKeyFile: fckFile,
    evmRpcUrl: config.evmRpcUrl,
    nearRpcUrl: config.nearRpcUrl,
  });
}

function requireApi(): AgentFence {
  if (!config.contractAccount || !config.agentAccount) {
    throw new Error('CONTRACT_ACCOUNT and AGENT_ACCOUNT env vars are required');
  }
  return fence();
}

function weiToEth(wei: bigint): string {
  const w = 10n ** 18n;
  // Round to at most 6 decimals (the exact wei value is always shown too).
  const microTotal = ((wei % w) * 1_000_000n + w / 2n) / w; // micro-ETH, rounded
  const whole = wei / w + (microTotal >= 1_000_000n ? 1n : 0n);
  const micro = microTotal % 1_000_000n;
  const trimmed = micro
    ? micro.toString().padStart(6, '0').replace(/0+$/, '')
    : '';
  return trimmed ? `${whole}.${trimmed}` : `${whole}`;
}

/** View-only check used to skip already-allowed destinations in `apply`.
 *  No signing is involved. */
async function checkDestinationAllowed(
  contract: string,
  agent: string,
  destination: string,
): Promise<boolean> {
  const rpc = config.nearRpcUrl ?? 'https://test.rpc.fastnear.com';
  const body = {
    jsonrpc: '2.0',
    id: 'dot',
    method: 'query',
    params: {
      request_type: 'call_function',
      account_id: contract,
      method_name: 'is_destination_allowed',
      args_base64: Buffer.from(
        JSON.stringify({ agent_id: agent, destination }),
        'utf8',
      ).toString('base64'),
      finality: 'final',
    },
  };
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    error?: { message?: string };
    result?: { result: number[] };
  };
  if (json.error) throw new Error(json.error.message ?? 'view call failed');
  const text = new TextDecoder().decode(new Uint8Array(json.result!.result));
  return JSON.parse(text) === true;
}

program
  .command('status')
  .description('Show policy, paused, spent today and the derived address')
  .action(async () => {
    const api = requireApi();
    const [policy, spent, { address }] = await Promise.all([
      api.getPolicy(),
      api.getSpentToday(),
      api.deriveAddress(),
    ]);
    if (!policy) {
      console.log('no policy for this agent');
      return;
    }
    console.log(
      `paused: ${policy.paused} (badge: ${policy.paused ? 'PAUSED' : 'ACTIVE'})`,
    );
    console.log(
      `per_tx_limit: ${policy.per_tx_limit} wei (${weiToEth(BigInt(policy.per_tx_limit))} ETH)`,
    );
    console.log(
      `daily_cap: ${policy.daily_cap} wei (${weiToEth(BigInt(policy.daily_cap))} ETH)`,
    );
    console.log(
      `spent today: ${spent} wei (${weiToEth(spent)} ETH)`,
    );
    console.log(`derived EVM address: ${address}`);
  });

program
  .command('audit')
  .description('Show the latest audit entries')
  .option('--limit <n>', 'limit', '5')
  .action(async (options: { limit: string }) => {
    const api = requireApi();
    const wanted = Math.min(Math.max(parseInt(options.limit, 10) || 5, 1), 50);
    const entries = await api.getAuditLog({ from: 0, limit: 50 });
    const rows = [...entries].reverse().slice(0, wanted);
    for (const e of rows) {
      const decision = e.decision === 'Allowed' ? 'Allowed' : 'Blocked';
      const when = new Date(e.timestamp / 1e6).toLocaleString();
      console.log(
        `#${e.id} ${when} ${e.agent_id} -> ${e.destination} ${e.amount} wei: ${decision}${e.reason ? ` (${e.reason})` : ''}`,
      );
    }
  });

program
  .command('apply <policyFile>')
  .description('Apply a policy file via the owner (near CLI, signed by keychain)')
  .option('--dry-run', 'print commands without running them')
  .option('--yes', 'skip the confirmation prompt')
  .action(async (policyFile: string, options: { dryRun?: boolean; yes?: boolean }) => {
    const policy = await loadPolicyFile(policyFile);
    console.log(
      `policy: contract=${policy.contract} owner=${policy.owner} agent=${policy.agent} perTx=${policy.perTxLimitWei} cap=${policy.dailyCapWei} paused=${policy.paused} destinations=${policy.allowlist.length}`,
    );
    if (!options.dryRun && !options.yes) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await rl.question(
        `Apply this policy on-chain? [y/N] `,
      );
      rl.close();
      if (answer.trim().toLowerCase() !== 'y') {
        console.log('aborted.');
        return;
      }
    }
    await applyPolicy({
      policy,
      dryRun: Boolean(options.dryRun),
      runCommand: async (command, p) =>
        execOwnerCommand(p.contract, p.owner, command),
      checkAllowed: (c, a, dest) => checkDestinationAllowed(c, a, dest),
    });
    console.log('done.');
  });

program
  .command('pause')
  .description('Pause the agent (owner)')
  .option('--yes', 'skip the confirmation prompt')
  .action(async (options: { yes?: boolean }) => {
    const policy = {
      contract: config.contractAccount,
      owner: process.env.OWNER_ACCOUNT ?? '',
      agent: config.agentAccount,
    } as PolicyFile & { paused: boolean };
    if (!policy.contract || !policy.owner || !policy.agent) {
      throw new Error('CONTRACT_ACCOUNT, OWNER_ACCOUNT and AGENT_ACCOUNT are required');
    }
    execOwnerCommand(policy.contract, policy.owner, {
      method: 'set_paused',
      argsJson: JSON.stringify({ agent_id: policy.agent, paused: true }),
      description: `set_paused(agent=${policy.agent}, paused=true)`,
    });
    console.log('paused.');
  });

program
  .command('resume')
  .description('Resume the agent (owner)')
  .option('--yes', 'skip the confirmation prompt')
  .action(async (options: { yes?: boolean }) => {
    const policy = {
      contract: config.contractAccount,
      owner: process.env.OWNER_ACCOUNT ?? '',
      agent: config.agentAccount,
    } as PolicyFile & { paused: boolean };
    if (!policy.contract || !policy.owner || !policy.agent) {
      throw new Error('CONTRACT_ACCOUNT, OWNER_ACCOUNT and AGENT_ACCOUNT are required');
    }
    execOwnerCommand(policy.contract, policy.owner, {
      method: 'set_paused',
      argsJson: JSON.stringify({ agent_id: policy.agent, paused: false }),
      description: `set_paused(agent=${policy.agent}, paused=false)`,
    });
    console.log('resumed.');
  });

program
  .command('pay <to> <amountWei>')
  .description('Pay a destination (SDK, function-call key only)')
  .option('--broadcast', 'broadcast the signed Sepolia transaction')
  .action(async (to: string, amountWei: string, options: { broadcast?: boolean }) => {
    const api = requireApi();
    const result = await api.pay({
      to,
      amountWei: BigInt(amountWei),
      broadcast: options.broadcast === true,
    });
    console.log(
      JSON.stringify(
        {
          decision: result.decision,
          reason: result.reason,
          payloadHash: result.payloadHash,
          txHash: result.txHash,
          etherscanUrl: result.etherscanUrl,
        },
        null,
        2,
      ),
    );
  });

await program.parseAsync(process.argv);
