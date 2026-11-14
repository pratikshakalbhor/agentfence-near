# agentfence-mcp

Standard stdio MCP server that wraps `agentfence-sdk` and exposes the
agentfence contract as MCP tools. It was verified over a real
`initialize` + `tools/list` + `tools/call` session against testnet; no
compatibility with any particular client beyond "standard stdio MCP
server" is claimed.

## Config (env only)

```json
{
  "mcpServers": {
    "agentfence": {
      "command": "npx",
      "args": ["tsx", "mcp/src/index.ts"],
      "env": {
        "CONTRACT_ACCOUNT": "agentfence-contract-evm-0b497ae1.testnet",
        "AGENT_ACCOUNT": "agentfence-agent-9a9635f2.testnet",
        "AGENT_FCK_KEY_FILE": "~/.near-credentials/agentfence-agent-fck.txt",
        "SEPOLIA_RPC_URL": "https://ethereum-sepolia-rpc.publicnode.com",
        "NEAR_RPC_URLS": "https://near-testnet.drpc.org,https://rpc.testnet.fastnear.com"
      }
    }
  }
}
```

Broadcast is refused unless the server starts with `--allow-broadcast`.
The function-call key is never logged or returned.

## Test

```sh
cd mcp
npm install
npm run build
npm test
node scripts/verify.mjs   # real initialize + tools/list + pay vs testnet
```
