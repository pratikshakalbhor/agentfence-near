// Shared AgentFence dashboard configuration. Loaded by every page before
// any other script. Edit these values only.
window.AGENTFENCE_CONFIG = {
  // agentfence contract on NEAR testnet
  CONTRACT_ACCOUNT: 'agentfence-contract-evm-0b497ae1.testnet',
  // agent that owns the function-call key
  AGENT_ACCOUNT: 'agentfence-agent-9a9635f2.testnet',
  // NEAR testnet JSON-RPC (the endpoint scripts/evm uses successfully)
  NEAR_RPC_URL: 'https://test.rpc.fastnear.com',
  // derived Sepolia address (see scripts/evm/derive-address.mjs)
  EVM_ADDRESS: '0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57',
  // owner account id, shown for display only (owner controls on index.html)
  OWNER_ACCOUNT: 'agentfence-owner-9a9635f2.testnet',
  // NEAR testnet explorer transaction page (verified from near CLI output):
  // https://explorer.testnet.near.org/transactions/<TX_HASH>
  NEAR_EXPLORER_TX_BASE: 'https://explorer.testnet.near.org/transactions/',
};
