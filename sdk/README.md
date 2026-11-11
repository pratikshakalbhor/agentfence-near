# agentfence-sdk

Minimal TypeScript client for the agentfence contract. The agent holds only a
function-call key; the SDK signs `request_spend` with it and never needs
anything else.

## Quickstart

```ts
import { AgentFence } from 'agentfence-sdk';

const fence = new AgentFence({
  network: 'testnet',
  contractAccount: 'agentfence-contract-evm-0b497ae1.testnet',
  agentAccount: 'agentfence-agent-9a9635f2.testnet',
  agentKeyFile: process.env.AGENT_FCK_KEY_FILE!,
});

const { address } = await fence.deriveAddress();
const result = await fence.pay({ to: '0x1111111111111111111111111111111111111111', amountWei: 1_000_000_000_000_000n });
console.log(result.decision, result.reason ?? '');
```

`agentKeyFile` (e.g. from `AGENT_FCK_KEY_FILE`) may start with `~`; it is expanded to `os.homedir()` before the key file is read.

## API

| method | description |
| --- | --- |
| `new AgentFence({ network, contractAccount, agentAccount, agentKeyFile?, agentKey?, evmRpcUrl?, nearRpcUrl? })` | Client (testnet only; one of `agentKeyFile`/`agentKey` required) |
| `deriveAddress()` | `{ address, publicKey }` of the contract-derived Sepolia address |
| `getPolicy()` | `Policy \| null` |
| `getSpentToday()` | `bigint` wei spent today |
| `getAuditLog({ from?, limit? })` | `AuditEntry[]` (oldest first per contract) |
| `preview(args)` | `{ payloadHash } \| null` — stateless signing-hash preview |
| `pay({ to, amountWei, broadcast? })` | `PayResult` (below) |

`PayResult = { decision: "Allowed" \| "Blocked"; reason?: string;
payloadHash?: string; signedTx?: string; txHash?: string;
etherscanUrl?: string }`. `pay()` returns `Blocked` without throwing.
Real failures throw `AgentFenceError` with a `code` (`CONFIG`,
`ADDRESS_FORMAT`, `FEE_CAP`, `PAYLOAD_MISMATCH`, `SIGNATURE_MISSING`,
`SIGNER_MISMATCH`, `NETWORK`).

## Limitations

Testnet only. Sepolia only. Native ETH transfers only. The spend is
reserved when the signature is requested, not when the tx is mined; a
failed broadcast does not refund the daily budget.
