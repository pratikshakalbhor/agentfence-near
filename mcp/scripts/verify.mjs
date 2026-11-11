// Tiny MCP client: real initialize + tools/list + tools/call against
// the built server, on testnet with --no-broadcast.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: {
    ...process.env,
    CONTRACT_ACCOUNT: 'agentfence-contract-evm-0b497ae1.testnet',
    AGENT_ACCOUNT: 'agentfence-agent-9a9635f2.testnet',
    AGENT_FCK_KEY_FILE:
      'C:\\Users\\HP\\.near-credentials\\agentfence-agent-fck-evm.txt',
  },
});

const client = new Client({ name: 'mcp-test-client', version: '0.0.0' });
await client.connect(transport);

console.log('--- initialize ---');
console.log(
  JSON.stringify(
    client.getServerVersion()
      ? { protocolVersion: '2026-07-28', serverInfo: client.getServerVersion() }
      : 'connected',
    null,
    2,
  ),
);

console.log('--- tools/list ---');
const page = await client.request(
  { method: 'tools/list' },
  { expectedOutput: undefined },
);
console.log(
  JSON.stringify(
    (page.tools ?? []).map((t) => ({
      name: t.name,
      description: (t.description ?? '').slice(0, 80),
    })),
    null,
    2,
  ),
);

console.log('--- tools/call get_policy ---');
const policy = await client.callTool({
  name: 'get_policy',
  arguments: {},
});
console.log(JSON.stringify(policy, null, 2));

console.log('--- tools/call pay to non-allowlisted address ---');
const pay = await client.callTool({
  name: 'pay',
  arguments: {
    to: '0x2222222222222222222222222222222222222222',
    amount_wei: '1000000000000000',
    reason: 'mcp verify: expect Blocked',
  },
});
console.log(JSON.stringify(pay, null, 2));
console.log('isError:', Boolean(pay.isError));

await client.close();
