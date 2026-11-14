// Read-only: snapshots policy, spent today, and full audit log for the dashboard fallback.
// Usage: node scripts/snapshot-audit.mjs
// Env: CONTRACT_ACCOUNT, AGENT_ACCOUNT, NEAR_RPC_URL / NEAR_RPC_URLS (optional). No key/txs.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AgentFence } from '../sdk/dist/index.js';

// config.js assigns to window.AGENTFENCE_CONFIG (browser-style). Load it in Node.
globalThis.window = globalThis.window || {};
await import('../dashboard/config.js');
const cfg = globalThis.window.AGENTFENCE_CONFIG;
if (!cfg) throw new Error('Failed to load dashboard/config.js');

const contractAccount = process.env.CONTRACT_ACCOUNT || cfg.CONTRACT_ACCOUNT;
const agentAccount = process.env.AGENT_ACCOUNT || cfg.AGENT_ACCOUNT;
const nearRpcUrl = process.env.NEAR_RPC_URL;
const nearRpcUrls = process.env.NEAR_RPC_URLS
  ? process.env.NEAR_RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean)
  : undefined;

// SDK requires a key in constructor but view calls do not use it.
const fence = new AgentFence({
  network: 'testnet',
  contractAccount,
  agentAccount,
  agentKey: 'ed25519:1111111111111111111111111111111111111111111111111111111111111111',
  ...(nearRpcUrls ? { nearRpcUrls } : {}),
  ...(nearRpcUrl ? { nearRpcUrl } : {}),
});

async function fetchAllAudit() {
  const limit = 50;
  const maxRows = 500;
  const audit = [];
  let fromIndex = 0;
  while (audit.length < maxRows) {
    const page = await fence.getAuditLog({ from: fromIndex, limit });
    if (!page || page.length === 0) break;
    audit.push(...page);
    if (page.length < limit) break;
    fromIndex += limit;
  }
  return audit;
}

const [policy, spentToday, audit] = await Promise.all([
  fence.getPolicy(),
  fence.getSpentToday(),
  fetchAllAudit(),
]);

const snapshot = {
  generatedAt: new Date().toISOString(),
  contract: contractAccount,
  policy,
  spentToday: spentToday.toString(),
  audit,
};

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'audit-snapshot.json');
await writeFile(outPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
console.log(`Wrote ${outPath} (${audit.length} audit rows) generatedAt=${snapshot.generatedAt}`);
