// agentfence MCP server (standard stdio MCP server).
//
// Authentication/config is env-only; server logs go to stderr (stdout is
// the MCP protocol channel). No key material is ever logged.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { AgentFence } from 'agentfence-sdk';

const ALLOW_BROADCAST = process.argv.includes('--allow-broadcast');

const POLICY_NOTE =
  'Policy is enforced on-chain; a Blocked result is final for that request. Do not retry with a different destination to get around a block.';

function log(...args: unknown[]): void {
  console.error(...args);
}

interface Config {
  contractAccount: string;
  agentAccount: string;
  agentKeyFile: string;
  evmRpcUrl?: string;
  nearRpcUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const missing = [
    'CONTRACT_ACCOUNT',
    'AGENT_ACCOUNT',
    'AGENT_FCK_KEY_FILE',
  ].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`missing required env vars: ${missing.join(', ')}`);
  }
  return {
    contractAccount: env.CONTRACT_ACCOUNT!,
    agentAccount: env.AGENT_ACCOUNT!,
    agentKeyFile: env.AGENT_FCK_KEY_FILE!,
    evmRpcUrl: env.SEPOLIA_RPC_URL || undefined,
    nearRpcUrl: env.NEAR_RPC_URL || undefined,
  };
}

export const MAX_AMOUNT_WEI_EXPONENT = 38; // bigint-safe cap for range checks

export function makeFence(config: Config): AgentFence {
  return new AgentFence({
    network: 'testnet',
    contractAccount: config.contractAccount,
    agentAccount: config.agentAccount,
    agentKeyFile: config.agentKeyFile,
    evmRpcUrl: config.evmRpcUrl,
    nearRpcUrl: config.nearRpcUrl,
  });
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

const weiString = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, 'amount_wei must be a non-negative integer string');

export interface McpDeps {
  allowBroadcast: boolean;
  fence: AgentFence;
}

export function registerTools(
  server: McpServer,
  deps: McpDeps,
): void {
  const { fence, allowBroadcast } = deps;

  server.registerTool(
    'pay',
    {
      description:
        `Pay a destination using the agentfence contract (function-call key only). ` +
        `${POLICY_NOTE} Broadcast is ${allowBroadcast ? 'allowed' : 'NOT allowed'} on this server instance.`,
      inputSchema: z
        .object({
          to: z.string().describe('destination 0x address (no evm: prefix)'),
          amount_wei: weiString.describe('amount in wei as decimal string'),
          reason: z.string().optional().describe('human-readable reason (not sent on-chain)'),
        })
        .refine(
          (v) => {
            const n = BigInt(v.amount_wei);
            return n <= 10n ** BigInt(MAX_AMOUNT_WEI_EXPONENT);
          },
          { message: `amount_wei exceeds bigint-safe range (max 10^${MAX_AMOUNT_WEI_EXPONENT})` },
        ),
    },
    async ({ to, amount_wei }) => {
      if (!allowBroadcast) {
        // Broadcast still refused unless server started with --allow-broadcast.
        // The spend itself stays --no-broadcast-equivalent: signature only.
        log('pay called without --allow-broadcast; broadcasting disabled');
      }
      const result = await fence.pay({
        to,
        amountWei: BigInt(amount_wei),
        broadcast: allowBroadcast,
      });
      return textResult({
        decision: result.decision,
        reason: result.reason,
        payloadHash: result.payloadHash,
        txHash: result.txHash,
        etherscanUrl: result.etherscanUrl,
      });
    },
  );

  server.registerTool(
    'get_policy',
    { description: `${POLICY_NOTE} Returns the agent's policy (limits + paused).` },
    async () => {
      const policy = await fence.getPolicy();
      return textResult(policy);
    },
  );

  server.registerTool(
    'get_spent_today',
    { description: `${POLICY_NOTE} Returns spent today in wei and ETH.` },
    async () => {
      const spent = await fence.getSpentToday();
      const eth = Number(spent) / 1e18;
      return textResult({ spentWei: spent.toString(), spentEth: eth });
    },
  );

  server.registerTool(
    'get_audit_log',
    {
      description: `${POLICY_NOTE} Latest audit entries (limit capped at 50).`,
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    },
    async ({ limit }) => {
      const entries = await fence.getAuditLog({ from: 0, limit: limit ?? 50 });
      return textResult(entries);
    },
  );

  server.registerTool(
    'get_address',
    { description: `${POLICY_NOTE} The contract-controlled Sepolia address.` },
    async () => {
      const { address, publicKey } = await fence.deriveAddress();
      return textResult({ address, publicKey });
    },
  );
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const fence = makeFence(config);
  const server = new McpServer({
    name: 'agentfence-mcp',
    version: '0.1.0',
  });
  registerTools(server, { allowBroadcast: ALLOW_BROADCAST, fence });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url.endsWith('/dist/index.js')) {
  main().catch((e) => {
    log('agentfence-mcp failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
