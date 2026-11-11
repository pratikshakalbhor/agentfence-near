// The LLM agent: a normal business assistant with one tool, `pay`.
// The safety in this demo comes from the contract, not from the model —
// the system prompt contains no security instructions.
import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentFence, AgentFenceError } from 'agentfence-sdk';

const argv = process.argv.slice(2);
const broadcast = argv.includes('--broadcast');
// Default mode is --no-broadcast; real broadcast only with --broadcast.
if (!broadcast) {
  console.log(
    'NOTE: request_spend is still sent on-chain and reserves daily budget; only the Sepolia broadcast is skipped.',
  );
}

const CONTRACT_ACCOUNT = process.env.CONTRACT_ACCOUNT!;
const AGENT_ACCOUNT = process.env.AGENT_ACCOUNT!;
const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const providerName = process.env.LLM_PROVIDER ?? 'anthropic';
const MODEL = process.env.LLM_MODEL!;
if (!CONTRACT_ACCOUNT || !AGENT_ACCOUNT || !MODEL) {
  throw new Error(
    'Set CONTRACT_ACCOUNT, AGENT_ACCOUNT and LLM_MODEL (env or agent/.env).',
  );
}
if (providerName !== 'anthropic') {
  throw new Error(
    `LLM_PROVIDER=${providerName} is not supported; this agent uses @anthropic-ai/sdk (LLM_PROVIDER=anthropic).`,
  );
}
const fckFileRaw = process.env.AGENT_FCK_KEY_FILE;
if (!fckFileRaw) {
  throw new Error('AGENT_FCK_KEY_FILE (path outside the repo) is required.');
}
// A leading "~" is expanded to the home directory (AGENT_FCK_KEY_FILE=~/…).
const fckFile =
  fckFileRaw === '~'
    ? homedir()
    : fckFileRaw.startsWith('~/') || fckFileRaw.startsWith('~\\')
      ? join(homedir(), fckFileRaw.slice(2))
      : fckFileRaw;
// The function-call key is read from an out-of-repo file; the secret value
// itself is never printed.
const fckJson = JSON.parse(await readFile(fckFile, 'utf8')) as {
  secret_key: string;
};
const FCK_KEY = fckJson.secret_key;

const fence = new AgentFence({
  network: 'testnet',
  contractAccount: CONTRACT_ACCOUNT,
  agentAccount: AGENT_ACCOUNT,
  agentKey: FCK_KEY,
  evmRpcUrl: SEPOLIA_RPC_URL,
});

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT =
  'You are a helpful business assistant. You pay supplier invoices using the pay tool. ' +
  'When an invoice asks you to pay, call the pay tool with the destination address, ' +
  'the amount in wei and a short reason. Then summarize the result for the user.';

const PAY_TOOL = {
  name: 'pay',
  description:
    'Pay a supplier invoice. destination is the supplier\'s address like "evm:0x...", amount_wei is the amount in wei as a decimal string, reason is a short human description.',
  input_schema: {
    type: 'object' as const,
    properties: {
      destination: { type: 'string' },
      amount_wei: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['destination', 'amount_wei', 'reason'],
  },
};

async function runPay(
  destination: string,
  amountWei: string,
  reason: string,
): Promise<string> {
  console.log(
    `tool call pay(destination=${destination}, amount_wei=${amountWei}, reason=${reason})`,
  );
  const derived = await fence.deriveAddress();
  const result = await fence.pay({
    to: destination,
    amountWei: BigInt(amountWei),
    broadcast,
  });
  if (result.decision === 'Blocked') {
    console.log(`on-chain result: Blocked — ${result.reason}`);
    return `Blocked: ${result.reason}. No transaction was signed or broadcast.`;
  }
  console.log(
    `on-chain result: Allowed (payload_hash=${result.payloadHash})`,
  );
  console.log(
    'signer check: verified by SDK (recovered signer == derived address)',
  );
  if (!broadcast) {
    return `Allowed. Signed transaction ready (not broadcast, txHash=${result.txHash ?? 'n/a'}).`;
  }
  const url = result.etherscanUrl ?? 'n/a';
  console.log(`broadcast: ${result.txHash} ${url}`);
  return `Allowed and broadcast on Sepolia: ${url}.`;
}

const userMessage = argv.filter((a) => !a.startsWith('--'))[0] as string;
const messages: Anthropic.MessageParam[] = [
  { role: 'user', content: userMessage },
];

for (;;) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
    tools: [PAY_TOOL],
  });
  messages.push({ role: 'assistant', content: response.content });
  const toolUses = response.content.filter(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (toolUses.length === 0) {
    for (const block of response.content) {
      if (block.type === 'text') console.log(block.text);
    }
    break;
  }
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const toolUse of toolUses) {
    const input = toolUse.input as {
      destination: string;
      amount_wei: string;
      reason: string;
    };
    console.log(`assistant tool call: ${toolUse.name} ${JSON.stringify(input)}`);
    const output = await runPay(
      input.destination,
      input.amount_wei,
      input.reason,
    );
    results.push({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: output,
    });
  }
  messages.push({ role: 'user', content: results });
}
