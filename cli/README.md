# agentfence CLI

`agentfence` command-line tool: reads through `agentfence-sdk`, writes
through the installed `near` CLI only (owner-signed; the owner key stays
in the user's keychain — this tool never reads or stores owner keys).

## Setup

```sh
cd cli
npm install
npm run build   # emits dist/index.js
```

## Commands

```sh
agentfence status                                   # policy, paused, spent today, derived address
agentfence audit [--limit N]                        # latest audit entries
agentfence pay <to> <amount-wei> [--broadcast]      # SDK pay (FCK only); to is a plain 0x address
agentfence pause | resume                           # owner set_paused via near CLI
agentfence apply agentfence.policy.json --dry-run   # print the near commands, run nothing
agentfence apply agentfence.policy.json --yes       # run them (default: confirmation prompt)
```

`apply` runs, in order: `set_policy`, `add_destination` for every
destination **not already allowed**, then `set_paused`. Owner calls go
through `near contract call-function as-transaction ... sign-as <owner>
network-config testnet sign-with-keychain send`.

## Policy file format

`agentfence.policy.example.json` (repo root) is a copyable example:

```json
{
  "contract": "agentfence-contract-evm-0b497ae1.testnet",
  "owner": "agentfence-owner-9a9635f2.testnet",
  "agent": "agentfence-agent-9a9635f2.testnet",
  "perTxLimitWei": "10000000000000000",
  "dailyCapWei": "50000000000000000",
  "allowlist": ["evm:0x1111111111111111111111111111111111111111"],
  "paused": false
}
```

Validated before anything is sent: amounts must be positive integer
strings, `perTxLimitWei <= dailyCapWei`, every allowlist item is a
`0x` + 40 hex address or the `evm:0x` form (normalized to `evm:0x…` for
the contract), and `paused` is boolean. An invalid file prints a
clear error and sends nothing.

## Config (env)

`CONTRACT_ACCOUNT`, `AGENT_ACCOUNT`, `OWNER_ACCOUNT`,
`AGENT_FCK_KEY_FILE` (or read from the policy file for `apply`),
`SEPOLIA_RPC_URL`, `NEAR_RPC_URL`. No key is ever printed.

## Tests

```sh
npm test
```

Offline unit tests: policy validation (good/bad), owner-command builder
output, and `apply` skipping already-allowed destinations.
