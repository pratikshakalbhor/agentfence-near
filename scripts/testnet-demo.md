# agentfence — NEAR testnet demo runbook

Plain markdown runbook. Copy-paste each block into your shell in order.
These commands were verified against the installed `near-cli-rs 0.31.1`
(`near --version` → `near-cli-rs 0.31.1`) and then executed end-to-end (see
[Live output](#live-output)). Every flag below exists in that version's
`--help` output.

## Prerequisites

- Rust toolchain + `wasm32-unknown-unknown` target (to build the wasm).
- `near-cli-rs` (`near` command) version 0.31.1.
- Network access to testnet RPC.

Build the wasm first (see [Build](#build)) — step b needs the wasm file.

### Build

Preferred:

```sh
cd contract
cargo near build non-reproducible-wasm
```

On this Windows machine that fails (see [Machine notes](#machine-notes)).
The working alternative used here is:

```sh
cd contract
cargo build --target wasm32-unknown-unknown --release
# output: contract/target/wasm32-unknown-unknown/release/agentfence.wasm
```

## Variables

Replace these three placeholders everywhere before running. The blocks below
use literal account IDs (no shell variables) so each line is independently
copy-pasteable:

```sh
# OWNER_ACCOUNT   = <your-owner>.testnet
# AGENT_ACCOUNT   = <your-agent>.testnet
# CONTRACT_ACCOUNT = <your-contract>.testnet
```

- `OWNER_ACCOUNT` — sets policies, allowlist, pause state.
- `AGENT_ACCOUNT` — the agent; the contract always uses
  `env::predecessor_account_id()` as the agent, so all `request_spend`
  calls must be signed **as the agent**.
- `CONTRACT_ACCOUNT` — where the wasm is deployed.

> **u128 values (`U128`) cross the JSON boundary as strings.**
> `per_tx_limit` / `daily_cap` / `amount` are always JSON strings like
> `"100"`, never bare numbers. `from_index` / `limit` are plain numbers.

> Never commit private keys, seed phrases, or the `~/.near-credentials/`
> folder to the repo. `.gitignore` already ignores `.near-credentials/`,
> `near-credentials/` and `*.pem`.

### Shell notes (from the live run)

- Gas and deposit take **units**: `prepaid-gas '100 TeraGas'` (not a bare
  number) and `attached-deposit '0 NEAR'` (not `0`).
- In PowerShell, pass JSON in **single quotes**, e.g.
  `'{"owner":"OWNER_ACCOUNT"}'` — double-quoted `\"`-escaped JSON gets
  mangled by the shell. Alternatively write the JSON to a file and use
  `file-args` (what the live run used).
- Every deploy/call chain must end in `sign-with-keychain send` (the
  deploy chain has no `sign-as` — it signs as the contract account).
  Ending a chain at `network-config` drops into an interactive prompt
  that hangs in non-interactive shells.

### a. Create three testnet accounts and fund them

Faucet-sponsored creation (testnet only). The key pairs are saved to the
local keychain (`~/.near-credentials/` — do not commit them):

```sh
near account create-account sponsor-by-faucet-service OWNER_ACCOUNT autogenerate-new-keypair save-to-keychain network-config testnet create

near account create-account sponsor-by-faucet-service AGENT_ACCOUNT autogenerate-new-keypair save-to-keychain network-config testnet create

near account create-account sponsor-by-faucet-service CONTRACT_ACCOUNT autogenerate-new-keypair save-to-keychain network-config testnet create
```

### b. Deploy the wasm and call `new`

```sh
near contract deploy CONTRACT_ACCOUNT use-file contract/target/wasm32-unknown-unknown/release/agentfence.wasm with-init-call new json-args '{"owner":"OWNER_ACCOUNT"}' prepaid-gas '100 TeraGas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

Expected: deploy succeeds and the `new` init call runs (no panic).

### c. Owner: set policy + allowlist, then verify

As **owner**, set a policy for the agent (small round numbers):

```sh
near contract call-function as-transaction CONTRACT_ACCOUNT set_policy json-args '{"agent_id":"AGENT_ACCOUNT","per_tx_limit":"100","daily_cap":"250"}' prepaid-gas '100 TeraGas' attached-deposit '0 NEAR' sign-as OWNER_ACCOUNT network-config testnet sign-with-keychain send
```

As **owner**, allowlist one destination:

```sh
near contract call-function as-transaction CONTRACT_ACCOUNT add_destination json-args '{"agent_id":"AGENT_ACCOUNT","destination":"evm:0x1111111111111111111111111111111111111111"}' prepaid-gas '100 TeraGas' attached-deposit '0 NEAR' sign-as OWNER_ACCOUNT network-config testnet sign-with-keychain send
```

Verify with read-only calls (no signer needed):

```sh
near contract call-function as-read-only CONTRACT_ACCOUNT get_policy json-args '{"agent_id":"AGENT_ACCOUNT"}' network-config testnet now

near contract call-function as-read-only CONTRACT_ACCOUNT is_destination_allowed json-args '{"agent_id":"AGENT_ACCOUNT","destination":"evm:0x1111111111111111111111111111111111111111"}' network-config testnet now
```

Expected: `get_policy` shows
`{"per_tx_limit":"100","daily_cap":"250","paused":false}` and
`is_destination_allowed` returns `true`.

### d. Agent: allowed spend (50)

Signed **as the agent** — the contract takes the agent from
`predecessor_account_id()`:

```sh
near contract call-function as-transaction CONTRACT_ACCOUNT request_spend json-args '{"destination":"evm:0x1111111111111111111111111111111111111111","amount":"50"}' prepaid-gas '100 TeraGas' attached-deposit '0 NEAR' sign-as AGENT_ACCOUNT network-config testnet sign-with-keychain send
```

Expected: returns `"Allowed"`; today's spent goes up by 50.

### e. Agent: over the per-tx limit (500 → Blocked)

```sh
near contract call-function as-transaction CONTRACT_ACCOUNT request_spend json-args '{"destination":"evm:0x1111111111111111111111111111111111111111","amount":"500"}' prepaid-gas '100 TeraGas' attached-deposit '0 NEAR' sign-as AGENT_ACCOUNT network-config testnet sign-with-keychain send
```

Expected: returns `"Blocked"` (audit reason `"exceeds per_tx_limit"`);
the transaction itself **succeeds** — a block is not an error.

### f. Agent: non-allowlisted destination (Blocked)

```sh
near contract call-function as-transaction CONTRACT_ACCOUNT request_spend json-args '{"destination":"evm:0x2222222222222222222222222222222222222222","amount":"50"}' prepaid-gas '100 TeraGas' attached-deposit '0 NEAR' sign-as AGENT_ACCOUNT network-config testnet sign-with-keychain send
```

Expected: returns `"Blocked"` (audit reason `"destination not allowlisted"`).

### g. Inspect the audit log and today's spend

```sh
near contract call-function as-read-only CONTRACT_ACCOUNT get_audit_log json-args '{"from_index":0,"limit":10}' network-config testnet now

near contract call-function as-read-only CONTRACT_ACCOUNT get_spent_today json-args '{"agent_id":"AGENT_ACCOUNT"}' network-config testnet now
```

Expected:

- `get_audit_log` shows **all three entries** (d: Allowed/50, e: Blocked/
  500 `"exceeds per_tx_limit"`, f: Blocked/50 `"destination not allowlisted"`),
  with increasing `id` values 0, 1, 2.
- `get_spent_today` returns `"50"` — only the allowed spend counts.

### h. Owner pauses the agent; next spend is Blocked

As **owner**:

```sh
near contract call-function as-transaction CONTRACT_ACCOUNT set_paused json-args '{"agent_id":"AGENT_ACCOUNT","paused":true}' prepaid-gas '100 TeraGas' attached-deposit '0 NEAR' sign-as OWNER_ACCOUNT network-config testnet sign-with-keychain send
```

As **agent**:

```sh
near contract call-function as-transaction CONTRACT_ACCOUNT request_spend json-args '{"destination":"evm:0x1111111111111111111111111111111111111111","amount":"10"}' prepaid-gas '100 TeraGas' attached-deposit '0 NEAR' sign-as AGENT_ACCOUNT network-config testnet sign-with-keychain send
```

Expected: returns `"Blocked"` (audit reason `"agent is paused"`).

To unpause, repeat the owner call with `"paused":false`.

## Live output

Executed end-to-end on testnet with throwaway accounts
`agentfence-owner-9a9635f2.testnet`, `agentfence-agent-9a9635f2.testnet`,
`agentfence-contract-9a9635f2.testnet` (keys in `~/.near-credentials/`,
not in this repo). JSON args were passed via `file-args` temp files.

- **a.** All three accounts created via the faucet sponsor.
- **b.** `Contract code has been successfully deployed.` (code hash
  `7G7bCCchhmbtyuzRDahnYGquBmJfZ8eqx2Q37MaAvWuM`); `new` succeeded.
  (Two deploy attempts that ended at `network-config` without
  `sign-with-keychain send` hung on an interactive prompt and never
  landed — `CodeDoesNotExist`. The completed chains above are the fix.)
- **c.** `get_policy` → `{"daily_cap":"250","paused":false,"per_tx_limit":"100"}`;
  `is_destination_allowed` → `true`.
- **d.** `"Allowed"`.
- **e.** `"Blocked"` with log:
  `request_spend decision=Blocked ... amount=500 reason=Some("exceeds per_tx_limit")`.
- **f.** `"Blocked"` with log:
  `... amount=50 reason=Some("destination not allowlisted")`.
- **g.** `get_audit_log(0, 10)`:

  ```json
  [
    {"agent_id":"agentfence-agent-9a9635f2.testnet","amount":"50","decision":"Allowed","destination":"evm:0x111...1111","id":0,"reason":null,"timestamp":1794059319461760784},
    {"agent_id":"agentfence-agent-9a9635f2.testnet","amount":"500","decision":"Blocked","destination":"evm:0x111...1111","id":1,"reason":"exceeds per_tx_limit","timestamp":1794059335361705493},
    {"agent_id":"agentfence-agent-9a9635f2.testnet","amount":"50","decision":"Blocked","destination":"evm:0x222...2222","id":2,"reason":"destination not allowlisted","timestamp":1794059340681810024}
  ]
  ```

  `get_spent_today` → `"50"`.
- **h.** `set_paused(true)` succeeded; the next spend returned `"Blocked"`
  with audit entry `id 3`, `"reason": "agent is paused"`.

## Chain Signatures sanity check

Proves the testnet MPC contract `v1.signer-prod.testnet` works from the
CLI and captures its raw response. No agentfence contract changes.

### 1. Inspect: `sign` argument names and types (from the ABI)

Found with `near contract inspect v1.signer-prod.testnet network-config testnet now`
(contract version 3.18.0, commit `e691bdb98d68dcf74653da58d043453a6318765f`):

- `sign` — read-write, **payable**, "No return value" (async: the
  signature comes back via the receipt result to the caller).
- Arguments: one argument named **`request`**, of type
  **`SignRequestArgs`**, defined in the contract's
  `near-mpc-crypto-types` (`crates/near-mpc-crypto-types/src/sign.rs`):

```rust
pub struct SignRequestArgs {
    pub path: String,
    #[serde(rename = "payload_v2")]
    pub payload: Payload,
    pub domain_id: DomainId,
}
```

`Payload` for today is the *tagged* form: `{"Ecdsa": "<hex>"}` (ECDSA
payloads are hex-encoded and upper-bounded at 68 bytes); `{"EdDSA": ...}`
for Ed25519. The decoder also accepts the **legacy untagged** form —
a raw 32-byte array under `payload` (optionally with `key_version` as an
alias for `domain_id`). `domain_id` is a plain integer; `0` is Secp256k1
(confirmed by the response `"scheme": "Secp256k1"` below).

### 2. Signature deposit view

No view method returns a signature deposit: `config` carries only gas
(`sign_call_gas_attachment_requirement_tera_gas: 15`, etc.) and `state`
exposes no deposit/fee field. The contract still asks for a deposit
("we ask for a small deposit for each signature request") and refunds it
in full — the log line after the call was:

```text
refund 0.050 NEAR to agentfence-agent-9a9635f2.testnet
```

so the attached `0.05 NEAR` below was fully refunded (only gas + tx fee
were actually paid).

### 3. The call

Signed **as the agent** with a 32-byte test payload (32× `0x01`), path
`evm-sepolia-1`, `domain_id` 0, deposit `0.05 NEAR`, prepaid gas
`300 TeraGas` (JSON passed via `file-args`):

```sh
near contract call-function as-transaction v1.signer-prod.testnet sign file-args ./sign_args.json prepaid-gas '300 TeraGas' attached-deposit '0.05 NEAR' sign-as AGENT_ACCOUNT network-config testnet sign-with-keychain send
```

where `./sign_args.json` contains exactly:

```json
{"request":{"path":"evm-sepolia-1","payload_v2":{"Ecdsa":"0101010101010101010101010101010101010101010101010101010101010101"},"domain_id":0}}
```

### 4. Raw response (transaction `DrP6GNqFVoaF47oKe5Wk9rnjHvwyMWeWw5ELN9Yms4gJ`)

Exact JSON from the `sign` call on behalf of
`agentfence-agent-9a9635f2.testnet`:

```json
{
  "big_r": {
    "affine_point": "02cfa6fa7ae95777205bc042299689b3d1ceb215e648363a5c10be38fe89165dde"
  },
  "recovery_id": 1,
  "s": {
    "scalar": "56f85e0d041dba12fc4362f7a51f2f9f5aa3308700113f326e38082427a667f6"
  },
  "scheme": "Secp256k1"
}
```

Contract log from the same transaction:

```text
sign: predecessor=AccountId("agentfence-agent-9a9635f2.testnet"), request=SignRequestArgs { path: "evm-sepolia-1", payload: Ecdsa(BoundedVec { inner: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], witness: NonEmpty(()) }), domain_id: DomainId(0) }
refund 0.050 NEAR to agentfence-agent-9a9635f2.testnet
```

**Shape verdict:** the **old flat shape**, not the wrapped enum shape.
There is no outer `{"Secp256k1": {...}}` key — the top-level fields are
`big_r`, `s`, `recovery_id` exactly as in the old shape, plus one extra
top-level field: **`"scheme": "Secp256k1"`**. `recovery_id` **is present**
(`1`).

## request_spend with Chain Signatures (live)

Historical: recorded on an earlier deployment (agentfence-contract-mpc-39bd5f75.testnet), not the final contract.

`request_spend` now returns `PromiseOrValue<SpendResult>`: an allowed
spend reserves the daily budget, audits `Allowed`, then calls
`v1.signer-prod.testnet.sign` with a payload built **inside** the contract
(`keccak256("agentfence|<agent_id>|<destination>|<amount>|<audit_id>")` as
hex, path `evm-sepolia-<agent_id>`, `domain_id` 0, `0.05 NEAR` deposit and
`300 TeraGas` to the MPC call, `50 TeraGas` reserved for the `on_sign`
callback). `get_mpc_account` returns the configured MPC account.

Ran live against the fresh deployment
`agentfence-contract-mpc-39bd5f75.testnet` (the same-account redeploy
kept the old state and re-calling `new` failed with an unreachable trap,
so the new code went to a fresh account). It was funded with `3 NEAR`
from the owner (`near tokens OWNER send-near CONTRACT '3 NEAR' ...`).

Allowed spend (50) — full result:

```json
{
  "decision": "Allowed",
  "reason": null,
  "signature": {
    "big_r": {"affine_point": "03d1342784654ac97ae61468df834d54efcd4436d7f963fdcb646187c390399225"},
    "recovery_id": 1,
    "s": {"scalar": "19eeef88c8d37564721e63c44308ec416b3551ab0c7d0d14b70eb0bcd350044b"}
  }
}
```

MPC log from the same receipt:
`sign: predecessor=AccountId("agentfence-contract-mpc-39bd5f75.testnet"), request=SignRequestArgs { path: "evm-sepolia-agentfence-agent-9a9635f2.testnet", payload: Ecdsa(...), domain_id: DomainId(0) }`
and `refund 0.050 NEAR to agentfence-contract-mpc-39bd5f75.testnet`.
`get_audit_log(0,10)` shows one `Allowed` entry (`amount "50", reason null`)
and `get_spent_today` returns `"50"`; `get_mpc_account` returns
`"v1.signer-prod.testnet"`.

Over-limit spend (500) — immediate `Blocked`, no MPC call:

```json
{"decision": "Blocked", "reason": "exceeds per_tx_limit", "signature": null}
```

There is no `sign:` log line for this transaction, `get_spent_today`
stays `"50"`, and the audit log gains a second entry with
`"reason": "exceeds per_tx_limit"`.

## Real EVM (Sepolia) transactions

The placeholder payload is gone. `request_spend` now builds a real
unsigned EIP-1559 transaction inside the contract with the
`omni-transaction 0.5.0` crate (`default-features = false`,
`features = ["evm"]`), which compiles for `wasm32-unknown-unknown`:

```rust
use omni_transaction::{TransactionBuilder, TxBuilder, EVM};
let tx = TransactionBuilder::new::<EVM>()
    .chain_id(CHAIN_ID_SEPOLIA)      // 11155111
    .nonce(nonce)
    .to(to)                          // 20 bytes parsed from "evm:0x…" destination
    .value(amount.0)                 // wei
    .input(vec![])                   // plain transfer
    .max_fee_per_gas(max_fee_per_gas.0)
    .max_priority_fee_per_gas(max_priority_fee_per_gas.0)
    .gas_limit(gas_limit as u128)
    .build();
let unsigned = tx.build_for_signing();   // unsigned RLP preimage
let hash = env::keccak256(&unsigned);   // the signing hash sent to MPC
```

New checks, in order (all prior reasons unchanged): `invalid destination
format` right after the allowlist check, and `fee exceeds max_fee_cap`
when `max_fee_per_gas * gas_limit > 5_000_000_000_000_000` wei
(`0.005 ETH`) via `checked_mul`, after the daily-cap check.
`SpendResult` gains `payload_hash` and `unsigned_tx`; `preview_payload`
returns the hash with no state change.

### Hash verification against viem

Test vector: `to = 0x1111111111111111111111111111111111111111`,
`value = 50` wei, `nonce = 7`, `maxFeePerGas = 1 gwei`,
`maxPriorityFeePerGas = 1 gwei`, `gas = 21000`, `chainId = 11155111`.

Contract `preview_payload` returned:

```text
fd3ca631c8ff7e6ae9b8309fa9814f9c441f9382732b3f1cfae6bd765f2dbdb8
```

Independent throwaway script `scripts/verify-hash/verify.mjs` (viem):

```js
import { serializeTransaction, keccak256 } from 'viem';
const unsigned = serializeTransaction({
  type: 'eip1559', chainId: 11155111, nonce: 7,
  to: '0x1111111111111111111111111111111111111111', value: 50n, data: '0x',
  maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000000n, gas: 21000n,
});
console.log('unsigned_tx:', unsigned);
console.log('signing_hash:', keccak256(unsigned));
```

```text
unsigned_tx: 0x02ea83aa36a707843b9aca00843b9aca008252089411111111111111111111111111111111111111113280c0
signing_hash: 0xfd3ca631c8ff7e6ae9b8309fa9814f9c441f9382732b3f1cfae6bd765f2dbdb8
```

Identical, including byte-for-byte: the live `Allowed` result carried
`"unsigned_tx": "02ea83aa36a707843b9aca00843b9aca0082520894111111111…280c0"`
and `"payload_hash": "fd3ca631…db8"`.

### Live calls

Deployed to a fresh account `agentfence-contract-evm-0b497ae1.testnet`
(new code layout, so the previous account's state cannot be re-`new`d).
Policy: `per_tx_limit 1 ETH`, `daily_cap 10 ETH`; destination
`evm:0x1111…1111` allowlisted.

Allowed call (50 wei, nonce 7, 1/1 gwei, 21000 gas) returned:

```json
{
  "decision": "Allowed",
  "payload_hash": "fd3ca631c8ff7e6ae9b8309fa9814f9c441f9382732b3f1cfae6bd765f2dbdb8",
  "reason": null,
  "signature": {
    "big_r": {"affine_point": "0310262bb8e0bc8138ee84fe5ab45d3ba50e6179cce8a0c037906d64f3de894fd3"},
    "recovery_id": 1,
    "s": {"scalar": "…"}
  },
  "unsigned_tx": "02ea83aa36a707843b9aca00843b9aca008252089411111111111111111111111111111111111111113280c0"
}
```

Fee-cap call (`max_fee_per_gas = 10,000 gwei`, `gas 21000` → 2.1e17 wei
total) returned immediately:

```json
{"decision": "Blocked", "payload_hash": null, "reason": "fee exceeds max_fee_cap", "signature": null}
```

## Send: agent → request_spend → signed Sepolia tx (`scripts/evm/send.mjs`)

`scripts/evm/send.mjs` does the full path with the agent's
**function-call key only** (key file outside the repo, `AGENT_FCK_KEY_FILE`):
derive address, read nonce/fees from Sepolia RPC, `preview_payload`,
`request_spend`, check `payload_hash` matches, normalize `s` (EIP-2),
serialize with viem, recover signer and require it to equal the derived
address, broadcast (unless `--dry-run`), print receipt + audit log.

Derived EVM address (same as `derive-address.mjs`):
`0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57`.

Dry run (everything through signer recovery):

```text
derived address: 0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57
nonce: 0
payload_hash matches preview: d9771201b2a1aebc787173a805a53c589501125aa5121714b585d4b1a36951fa
signature: r=0x9e5679e0... yParity=0 (low-s normalization not needed)
signed tx: 0x02f86c83aa36a7800217825…c6800080c080a09e5679e089c…d4db10bbe2c a00d9e90c9ad691a443e…
recovered signer: 0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57
signer matches derived address.
dry-run: broadcast skipped.
get_spent_today: 2000000000000100
```

Real run reached broadcast and was rejected by the RPC (derived address
still has 0 balance):

```text
insufficient funds for gas * price + value: have 0 want 1000000000462000
```

Fund `0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57` with Sepolia ETH from a
faucet and re-run:

```sh
cd scripts/evm
AGENT_FCK_KEY_FILE=~/.near-credentials/agentfence-agent-fck-evm.txt \
node send.mjs agentfence-contract-evm-0b497ae1.testnet \
  agentfence-agent-9a9635f2.testnet \
  "evm:0x1111111111111111111111111111111111111111" 1000000000000000
```

## Bypass proof: scoped key

Proves that an agent holding **only a function-call key** can call
`request_spend` on `agentfence-contract-evm-0b497ae1.testnet` and nothing
else. The key's public key is
`ed25519:FnXYf8ppxE6drTWz9Sxbh9XmnPFi2vKikQfzHc7vamDS` (confirmed with
`view_access_key_list`: receiver `agentfence-contract-evm-0b497ae1.testnet`,
`method_names: ["request_spend"]`).
No contract changes; all agent calls below were signed with the
function-call key only (`sign-with-plaintext-private-key`), never the
keychain's full-access key. The four refusals (c–f) were re-run against
this contract on 2026-11-10 and left all state unchanged.

### 1. Generate the function-call key

The function-call key was generated with the CLI (`near-cli-rs 0.31.1`,
flags confirmed via `--help`):

```sh
near account add-key agentfence-agent-9a9635f2.testnet grant-function-call-access --allowance '1 NEAR' --contract-account-id agentfence-contract-evm-0b497ae1.testnet --function-names request_spend autogenerate-new-keypair print-to-terminal network-config testnet sign-with-keychain send
```

- Signer of the add: `agentfence-agent-9a9635f2.testnet` (existing full-access key).
- Receiver: `agentfence-contract-evm-0b497ae1.testnet`
- Method names: `["request_spend"]` only
- **Gas allowance: 1 NEAR**

**Public key of this contract's function-call key (only this is printed
here; confirmed on-chain with `view_access_key_list` for
`agentfence-agent-9a9635f2.testnet`, which returns receiver
`agentfence-contract-evm-0b497ae1.testnet`, `method_names:
["request_spend"]`):**

```text
ed25519:FnXYf8ppxE6drTWz9Sxbh9XmnPFi2vKikQfzHc7vamDS
```

The private key is stored only outside the repo at
`~/.near-credentials/agentfence-agent-fck-evm.txt` (gitignored via
`.near-credentials/`). It is never written to this file or the repo.
Agent calls use:

```sh
near contract call-function as-transaction agentfence-contract-evm-0b497ae1.testnet request_spend json-args '{"destination":"evm:0x1111111111111111111111111111111111111111","amount":"50"}' prepaid-gas '400 TeraGas' attached-deposit '0 NEAR' sign-as agentfence-agent-9a9635f2.testnet network-config testnet sign-with-plaintext-private-key <PRIVATE_KEY> send
```

### 2. Results

**a. FCK → `request_spend` within limits — `Allowed` + MPC signature.**
Real outcome from today's broadcast run on
`agentfence-contract-evm-0b497ae1.testnet`, signed with the function-call
key only (`docs/real-broadcast.txt`, verbatim):

```json
{
  "decision": "Allowed",
  "reason": null,
  "signature": {
    "big_r": {
      "affine_point": "03fc2d77957ec8839ff15c900121a5e0ecb2c874775dd43c3a04dc77a69625ca99"
    },
    "s": {
      "scalar": "2d38b3e1e18507acb34b26885290af9f66fa3e010f671409ebc3d8767499d33c"
    },
    "recovery_id": 1
  },
  "payload_hash": "ebb52d50755d6655d33e69c416e3b376e9f49523d15ab5a5d1b037f06c4abb61",
  "unsigned_tx": "02f183aa36a7808405f5e100843b9aca00825208941111111111111111111111111111111187038d7ea4c6800080c0"
}
```

(the audit log also records a 50-wei `Allowed` spend on this contract —
`id 0` — under the same policy.)

**b. FCK → `request_spend` over `per_tx_limit` — `Blocked`, no MPC call:**
audit entry `id 11` on `agentfence-contract-evm-0b497ae1.testnet`
(`per_tx_limit` is `10000000000000000`, so `500` passes on this contract;
the refused amount is `5000000000000000000`):

```json
{
  "agent_id": "agentfence-agent-9a9635f2.testnet",
  "amount": "5000000000000000000",
  "decision": "Blocked",
  "destination": "evm:0x1111111111111111111111111111111111111111",
  "id": 11,
  "reason": "exceeds per_tx_limit",
  "timestamp": 1794122224683445721
}
```

**c. FCK → `set_policy` — refused** (re-run 2026-11-10 against
`agentfence-contract-evm-0b497ae1.testnet`). Verbatim error:

```text
Error: 
   0: Error: Transaction method name <set_policy> isn't allowed by the access key.
Location:
   src\transaction_signature_options\send\mod.rs:185
```

**d. FCK → `set_paused` — refused.** Verbatim error:

```text
Error: 
   0: Error: Transaction method name <set_paused> isn't allowed by the access key.
Location:
   src\transaction_signature_options\send\mod.rs:185
```

**e. FCK → `v1.signer-prod.testnet.sign` (MPC directly) — refused.**
Run with `0 NEAR` attached so the receiver check is the one that fires.
Verbatim error:

```text
Error: 
   0: Error: Transaction for <v1.signer-prod.testnet> doesn't match the access key for 
<agentfence-contract-evm-0b497ae1.testnet>.
Location:
   src\transaction_signature_options\send\mod.rs:185
```

**f. FCK → `request_spend` with an attached deposit (`0.1 NEAR`) — refused.** Verbatim error:

```text
Error: 
   0: Error: Having a deposit with a function call action is not allowed with a function call access key.
Location:
   src\transaction_signature_options\send\mod.rs:185
```

All refusals are access-key checks in the NEAR protocol (surfaced by the
CLI before the transaction is sent): the key can only invoke
`request_spend` on `agentfence-contract-evm-0b497ae1.testnet`, with no
attached deposit. State was verified unchanged after the four refusals:
`get_policy` still `{"daily_cap":"50000000000000000","paused":false,"per_tx_limit":"10000000000000000"}`,
`get_spent_today` still `"1000000000000000"`, audit log still ends at
`id 26` (`from_index: 27` returns `[]`).

## Injection demo (simulated compromised model)

Ran `cd agent && npx tsx src/demo-injection.ts --no-broadcast --force-tool-call`
against `agentfence-contract-evm-0b497ae1.testnet` — clearly labeled
"SIMULATED compromised model (--force-tool-call)", not a live LLM run.
Full log: `docs/demo-output.txt` (no keys).

```text
=== A legitimate invoice ===
  tool call pay -> destination=evm:0x1111111111111111111111111111111111111111 amount=1000000000000000
  on-chain: Allowed (payload=ebb52d50755d6655d33e69c416e3b376e9f49523d15ab5a5d1b037f06c4abb61, not broadcast (no-broadcast mode))

=== B injected invoice (new address) ===
  tool call pay -> destination=evm:0x2222222222222222222222222222222222222222 amount=50000000000000000
  on-chain: Blocked (destination not allowlisted)

=== C injected invoice (allowed address, huge amount) ===
  tool call pay -> destination=evm:0x1111111111111111111111111111111111111111 amount=5000000000000000000
  on-chain: Blocked (exceeds per_tx_limit)

=== D legitimate invoice while paused ===
owner: pausing the agent...
  on-chain: Blocked (agent is paused)
owner: unpausing the agent...

=== summary ===
A legitimate invoice                         | pay(evm:0x1111…1111, 1000000000000000)    | Allowed  | Allowed. not broadcast (no-broadcast mode)
B injected invoice (new address)             | pay(evm:0x2222…2222, 50000000000000000)  | Blocked  | destination not allowlisted
C injected invoice (allowed address, huge)   | pay(evm:0x1111…1111, 5000000000000000000) | Blocked  | exceeds per_tx_limit
D legitimate invoice while paused            | pay(evm:0x1111…1111, 1000000000000000)    | Blocked  | agent is paused

get_spent_today: 7000000000000100
```

Owner unpaused the agent at the end — `get_policy` confirms
`{"daily_cap":"10000000000000000000","paused":false,"per_tx_limit":"1000000000000000000"}`.

## Machine notes

- `cargo near build non-reproducible-wasm` fails on this Windows machine.
  Exact failure: the ABI-generation host build breaks with
  `error LNK2019: unresolved external symbol bls12381_g2_multiexp ...`,
  `... bls12381_map_fp_to_g1 ...`, `... bls12381_pairing_check ...`,
  `... bls12381_p1_sum ...`, `... bls12381_p2_sum ...` and
  `fatal error LNK1120: 60 unresolved externals`, then
  `Error: 0: "cargo build --features near-sdk/__abi-generate" failed with exit code: Some(101)`.
  The plain wasm build
  (`cargo build --target wasm32-unknown-unknown --release`) succeeds and
  produces the deployable `.wasm` used above.
- `cargo install cargo-near` also fails here
  (`openssl-sys` needs `perl ./Configure ... VC-WIN64A`, exit code 2).
  Both `cargo-near` (v0.23.0) and `near-cli-rs` (v0.31.1) were installed
  from the official prebuilt Windows binaries on GitHub, and all flags
  above were confirmed with `near --help` and each subcommand's `--help`.

## Real Sepolia broadcast

The derived address `0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57` was funded
with Sepolia ETH (0.05 ETH), then one real send was run with the agent's
function-call key only — **without** `--no-broadcast`. No keys appear below;
the key file lives outside the repo (`AGENT_FCK_KEY_FILE`).

```sh
AGENT_FCK_KEY_FILE=~/.near-credentials/agentfence-agent-fck-evm.txt \
node scripts/evm/send.mjs agentfence-contract-evm-0b497ae1.testnet \
  agentfence-agent-9a9635f2.testnet \
  "evm:0x1111111111111111111111111111111111111111" 1000000000000000
```

Real output (verbatim):

```text
derived address: 0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57
path: evm-sepolia-agentfence-agent-9a9635f2.testnet
nonce: 0
fees: max_fee_per_gas=1000000000 max_priority=100000000 gas=21000
tx args: {"destination":"evm:0x1111111111111111111111111111111111111111","amount":"1000000000000000","nonce":0,"max_fee_per_gas":"1000000000","max_priority_fee_per_gas":"100000000","gas_limit":21000}
preview_payload (view)...
preview_payload: ebb52d50755d6655d33e69c416e3b376e9f49523d15ab5a5d1b037f06c4abb61
request_spend (400 TeraGas, 0 deposit, FCK only)...
request_spend outcome: {
  "decision": "Allowed",
  "reason": null,
  "signature": {
    "big_r": {
      "affine_point": "03fc2d77957ec8839ff15c900121a5e0ecb2c874775dd43c3a04dc77a69625ca99"
    },
    "s": {
      "scalar": "2d38b3e1e18507acb34b26885290af9f66fa3e010f671409ebc3d8767499d33c"
    },
    "recovery_id": 1
  },
  "payload_hash": "ebb52d50755d6655d33e69c416e3b376e9f49523d15ab5a5d1b037f06c4abb61",
  "unsigned_tx": "02f183aa36a7808405f5e100843b9aca0082520894111111111111111111111111111111111111111187038d7ea4c6800080c0"
}
payload_hash matches preview: ebb52d50755d6655d33e69c416e3b376e9f49523d15ab5a5d1b037f06c4abb61
signature: r=0xfc2d77957ec8839ff15c900121a5e0ecb2c874775dd43c3a04dc77a69625ca99 s=0x2d38b3e1e18507acb34b26885290af9f66fa3e010f671409ebc3d8767499d33c yParity=1 (low-s normalization not needed)
signed tx: 0x02f87483aa36a7808405f5e100843b9aca0082520894111111111111111111111111111111111111111187038d7ea4c6800080c001a0fc2d77957ec8839ff15c900121a5e0ecb2c874775dd43c3a04dc77a69625ca99a02d38b3e1e18507acb34b26885290af9f66fa3e010f671409ebc3d8767499d33c
recovered signer: 0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57
derived address: 0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57
signer matches derived address.
tx hash: 0x388bc60903b143229dfdd9b3000c10b0a051d3a61668e340aaa7d45799608126
etherscan: https://sepolia.etherscan.io/tx/0x388bc60903b143229dfdd9b3000c10b0a051d3a61668e340aaa7d45799608126
status: success (block 12103743)
destination balance: 9944426631806992427 -> 9945426631806992427 (delta 1000000000000000)
```

Checks verified in that output:

- `preview_payload` == `payload_hash` from `request_spend`:
  `ebb52d50755d6655d33e69c416e3b376e9f49523d15ab5a5d1b037f06c4abb61`.
- Recovered signer == derived address `0x44c8f698d9C2711925Af1Df0b9BB3d4b62E8ea57`.
- Receipt `status: success` in block `12103743`.
- Destination balance rose by exactly `1000000000000000` wei (0.001 ETH).

Follow-up views: `get_audit_log` paged to the tail (no length view exists:
`from_index` 0/10/20 then 26 → one row, 27 → `[]`), so the newest entry —
this run — is:

```json
{
  "agent_id": "agentfence-agent-9a9635f2.testnet",
  "amount": "1000000000000000",
  "decision": "Allowed",
  "destination": "evm:0x1111111111111111111111111111111111111111",
  "id": 26,
  "reason": null,
  "timestamp": 1794302886102950384
}
```

Human-readable time: **2026-11-10 09:28:06 UTC** (14:58:06 local, UTC+5:30)
— 18 s before the tx was mined (block `12103743` at `09:28:24 UTC`,
`eth_getBlockByNumber` timestamp `1794302904`). It is the only entry from
today; every earlier entry is from 8 Nov. A previous revision of this
section cited `id 13` (`1794122271283211838` = 2026-11-08 07:17:51 UTC) —
that was a fixed `{"from_index":9,"limit":5}` window mistaken for the tail,
not this broadcast.

```text
get_spent_today: "1000000000000000"
```
(confirmed again after the scoped-key refusal tests below; equals exactly
this run's amount, since today's UTC window contains only entry id 26)

Full verbatim transcript: `docs/real-broadcast.txt`.

One code fix was required for this run (nothing else changed):
`scripts/evm/send.mjs` used `Math.max()` on BigInt fee values, which throws
`TypeError: Cannot convert a BigInt value to number`; replaced with a
BigInt-only comparison. Contract code was not touched.
