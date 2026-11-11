# Derive the Sepolia address for agentfence

Derives the Sepolia EVM address controlled by the agentfence contract for a
given agent, via the testnet Chain Signatures MPC contract
(`v1.signer-prod.testnet`) and the `chainsig.js` library (v1.1.16).

The foreign address is derived from three inputs: the NEAR account that
calls the MPC contract's `sign` (this is `CONTRACT_ACCOUNT` — the
agentfence contract, NOT the agent), the derivation path
`evm-sepolia-<AGENT_ACCOUNT>`, and the MPC master public key.

## Run

```sh
cd scripts/evm
npm install
node derive-address.mjs CONTRACT_ACCOUNT.testnet AGENT_ACCOUNT.testnet
```

Or with env vars:

```sh
CONTRACT_ACCOUNT=... AGENT_ACCOUNT=... node derive-address.mjs
```

Optional: `SEPOLIA_RPC_URL` (defaults to
`https://ethereum-sepolia-rpc.publicnode.com`, a well-known public Sepolia
RPC).

Output: the derivation path, the Sepolia address, the public key, and the
current ETH balance at that address.

**Fund this address with Sepolia ETH from a faucet before broadcasting.**

No private keys are involved or stored — the derived address is controlled
by the MPC contract on behalf of `CONTRACT_ACCOUNT` + path, so nobody holds
a private key for it. That is the point.

## Budget semantics

Spend is reserved when the signature is requested, not when the transaction
is mined. `request_spend` charges the daily budget (and writes the audit
entry) as soon as the MPC call is made; a failed or skipped broadcast does
not release that budget, and there is no automatic refund when the Sepolia
transaction never lands. If the MPC confirmation itself fails, the daily
reservation is refunded — but a broadcast that is never sent (or fails on
Sepolia) consumes the budget anyway. `--no-broadcast` in `send.mjs` also
behaves this way: the NEAR `request_spend` really goes on-chain and
reserves budget, only the Sepolia broadcast is skipped.
