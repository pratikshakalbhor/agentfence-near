# Architecture

## Flow

```mermaid
flowchart TD
    Agent[LLM agent<br/>function-call key:<br/>may call only request_spend]
    Contract[agentfence contract<br/>policy check]
    MPC[MPC contract<br/>v1.signer-prod.testnet<br/>sign]
    EVM[Sepolia<br/>derived EVM address<br/>belongs to the CONTRACT]
    Owner[Owner<br/>CLI only]

    Agent -->|request_spend(destination, amount, nonce, fees)| Contract
    Owner -->|set_policy / add_destination / set_paused<br/>via near CLI| Contract
    Contract -->|policy violation| Blocked[Blocked + audit log]
    Contract -->|policy ok| MPC
    MPC -->|signature| Contract
    Contract -->|signature| Agent
    Agent -->|signed EVM tx| EVM
```

**Derived EVM address.** The MPC `sign` caller is the **contract**
(`agentfence-contract-evm-0b497ae1.testnet`), and the derivation path is
`evm-sepolia-<agent_account_id>` (built by the contract, never by the
agent). So the address the MPC signs for is
`0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57` — it belongs to the contract.
Any attempt by the agent to call MPC `sign` directly derives against the
**agent's** account and produces a different address the fence never uses.

**Details.**

- The agent's NEAR key is a function-call access key scoped to
  `request_spend` on the agentfence contract, allowance 1 NEAR, no
  deposit. Design note: the fence is non-payable for MPC calls; it pays
  the 0.05 NEAR deposit from its own (funded) balance.
- `request_spend` checks, in order: no policy → paused → amount zero →
  allowlist → destination format (`evm:0x` + 40 hex) → per-tx limit →
  daily cap → fee cap (`max_fee_per_gas × gas_limit ≤ 0.005 ETH`). First
  failure wins, writes an audit entry and returns `Blocked` without
  panicking. On `Allowed`, the contract reserves the spend, audits
  `Allowed`, builds the real EIP-1559 transaction (`chain_id = 11155111`,
  `to`/`value` from the checked destination/amount, empty data,
  agent-supplied nonce/fees), sigs `keccak256(unsigned)` via MPC, and
  the callback returns `{ decision, reason, signature, payload_hash,
  unsigned_tx }` to the caller.
- `on_sign` is `#[private]`; if the MPC call fails, the daily reservation
  is refunded (matched-day) and a `Blocked` audit entry is appended.
- The payload hash was verified independently against viem (`2e983aa3…52b6ca`/`fd3ca631…db8`
  byte-for-byte, see `scripts/testnet-demo.md`).

## Why the agent cannot bypass the policy

- **(a)** Its NEAR key is a function-call key that may only invoke
  `request_spend` on the agentfence contract — `set_policy`, `set_paused`,
  an MPC `sign`, or any call with a deposit are all refused by NEAR access
  keys before the transaction is sent (live-verified; see the
  runbook "Bypass proof: scoped key").
- **(b)** The MPC signing address derives from the **contract** account
  (path `evm-sepolia-<agent_id>`), not the agent. A direct MPC call by the
  agent would sign for a different address — one the fence never reads
  from and that has no policy attached.
- **(c)** `to`, `value` and `chain_id` (and empty `data`) of the signed
  EVM transaction are built **inside the contract** from the
  policy-checked `destination` and `amount`. The agent chooses only
  `nonce` and fees, and fees are capped.
- **(d)** The contract's signing hash was verified byte-for-byte against
  an independent viem implementation.

## Honest limitations

- Spend is reserved when the signature is **requested**, not when the tx
  is mined. A failed or never-sent broadcast does **not** refund it.
- Testnet only. ETH on Sepolia only.
- No TEE — the MPC is the trust root.
- An allowlisted destination is still trusted; the fence constrains the
  agent, not the supplier.
- The owner key is a single key (no multisig).
- The injection demo uses `--force-tool-call` to simulate a compromised
  model unless run with a real LLM.
- The derived EVM address changes if the contract is redeployed to a new
  account (derivation key is the contract account).
