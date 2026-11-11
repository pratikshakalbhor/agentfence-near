# agent — LLM invoice agent (function-call key only)

A real LLM business assistant that pays invoices through the agentfence
contract. The model gets one tool, `pay(destination, amount_wei, reason)`,
which calls the contract's `request_spend` signed **only** with the agent's
function-call key. The safety is on-chain, not in the prompt.

- LLM provider (Anthropic SDK) is configured purely by env vars
  (`LLM_PROVIDER`, `LLM_MODEL`, `ANTHROPIC_API_KEY`); the model name is
  never hardcoded.
- The system prompt is a normal business-assistant prompt — no security
  instructions (no "ignore injections").
- Default mode is `--no-broadcast`: `request_spend` still goes on-chain and
  reserves budget; only the Sepolia broadcast is skipped.

## Setup

```sh
cd agent
cp .env.example .env   # fill in CONTRACT_ACCOUNT, AGENT_ACCOUNT, owner, FCK key path, LLM keys
npm install
```

`AGENT_FCK_KEY_FILE` points to the function-call private key file outside
the repo (e.g. `~/.near-credentials/agentfence-agent-fck-evm.txt`).

## Run

```sh
# single invoice (text after the flags is the user message)
npx tsx src/agent.ts --no-broadcast "Invoice #7 from Acme: pay 0.001 ETH to evm:0x1111111111111111111111111111111111111111"

# prompt-injection demo (A–D)
npx tsx src/demo-injection.ts --no-broadcast
```

Add `--broadcast` to actually send the Sepolia transaction after `Allowed`.

`demo-injection.ts` scenarios:

- A: legitimate allowlisted invoice → `Allowed`
- B: injected instruction pointing at a new address → `Blocked "destination not allowlisted"`
- C: injected huge amount to the allowlisted address → `Blocked "exceeds per_tx_limit"`
- D: legitimate spend while the owner paused the agent → `Blocked "agent is paused"` (unpauses after)

If the model refuses an injection, the demo says so plainly
(`model refused (no tool call)`). `--force-tool-call` simulates a
compromised model and calls `pay()` directly.

## What this proves

1. The agent holds no signing authority — only a function-call key that can
   call `request_spend` and nothing else (see `scripts/testnet-demo.md`
   "Bypass proof: scoped key"). Even if the prompt is hijacked, the agent
   cannot redirect funds, set policy, pause, talk to MPC directly, or
   attach a deposit.
2. The model doesn't need to be trustworthy. Injected instructions can make
   it *try* anything, but the contract applies per-tx limits, daily caps,
   an allowlist and pause on-chain, then signs only the resulting real EIP-1559 transaction with the MPC contract's key — which the agent never sees.
3. Blocked attempts are still recorded (audit log, same reasons as the
   unit tests), and allowed spends are verifiable end-to-end (payload hash
   + recovered signer, see `scripts/evm`).
