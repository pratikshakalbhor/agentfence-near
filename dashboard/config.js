// Shared AgentFence dashboard configuration. Loaded by every page before
// any other script. Edit these values only.
//
// RPC providers (testnet, public endpoints): sourced from official NEAR docs
// https://docs.near.org/api/rpc/providers (Testnet table). Endpoints below are
// public browser-callable endpoints from that page; a shared rpcView() tries
// them in order, skips endpoints after 429/network errors, and remembers the
// last working one.
window.AGENTFENCE_CONFIG = {
  // agentfence contract on NEAR testnet
  CONTRACT_ACCOUNT: 'agentfence-contract-evm-0b497ae1.testnet',
  // agent that owns the function-call key
  AGENT_ACCOUNT: 'agentfence-agent-9a9635f2.testnet',
  // Ordered NEAR testnet JSON-RPC endpoints (browser-tested from official list)
  RPC_URLS: [
    'https://archival-rpc.testnet.near.org', // NEAR (archival, rate-limited)
    'https://test.rpc.fastnear.com',         // FASTNEAR
    'https://near-testnet.drpc.org',         // dRPC
    'https://testnet-rpc.intea.rs',          // Intear RPC
  ],
  // derived Sepolia address (see scripts/evm/derive-address.mjs)
  EVM_ADDRESS: '0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57',
  // owner account id, shown for display only (owner controls on index.html)
  OWNER_ACCOUNT: 'agentfence-owner-9a9635f2.testnet',
  // NEAR testnet explorer transaction page (verified from near CLI output):
  // https://explorer.testnet.near.org/transactions/<TX_HASH>
  NEAR_EXPLORER_TX_BASE: 'https://explorer.testnet.near.org/transactions/',
};
