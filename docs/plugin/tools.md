# Plugin: tools & prompts

Every tool maps one-to-one onto an SDK method and inherits its privacy scope.

| Tool | SDK | Input | Returns | Confirms |
|---|---|---|---|---|
| `jomo_register` | `register()` | — | tx hash, meta-address | yes |
| `jomo_resolve` | `resolve()` | `address` | meta-address or null | no |
| `jomo_send` | `send()` | `to`, `amount`, `token?`, `memo?`, `gasStipend?` | tx hashes, stealth address, mode, fee, scope note | **always** |
| `jomo_send_batch` | `sendBatch()` | `payments[]` | tx hash, per-payment stealth addresses | **always** |
| `jomo_scan` | `scan()` | `fromBlock?`, `toBlock?` | payments (no private keys), next cursor | no |
| `jomo_forward` | `forward()` | `fromStealthAddress`, `to`, `amount`, `memo?` | tx hashes | **always** |
| `jomo_sweep` | `sweep()` | `fromStealthAddress`, `to`, `token?` | tx hash | **always** |
| `jomo_balance` | `balanceOf()` | `address?`, `token?` | balances of identity and known stealth addresses | no |
| `jomo_privacy_scope` | — | — | the guaranteed / not-guaranteed lists | no |

`fromStealthAddress` refers to a payment the server has already detected with `jomo_scan`; the
keystore holds the spending keys and never returns them.

Every "Confirms: always" tool is approved by the user or by the operator's limits. In autonomous mode
(`JOMO_CONFIRM=auto`) a call within the limits runs at once and one past them is asked of the user or
refused with `POLICY_LIMIT`. With MCP elicitation the server asks the user directly and the result is
the executed action (or `DECLINED`). Without elicitation the call is refused with
`ELICITATION_REQUIRED` and a `summary`, and nothing is sent. Only in token mode
(`JOMO_CONFIRM=token`) does the first call answer with:

```json
{ "error": { "code": "CONFIRMATION_REQUIRED", "confirmationToken": "…",
             "summary": "Send 0.25 ETH privately to 0x3C44…93BC (registered) …\nFee: 0.0025 ETH (1% on top, router mode, atomic).\n…" } }
```

Relay the summary, get approval, call again with the same arguments and `confirmationToken`. A
token is single-use, bound to that tool and those exact arguments (a different call cancels it), and
expires after two minutes.

## Input shapes

```json
{
  "to": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "amount": "0.25 ETH",
  "memo": { "taskId": "42", "deliverable": "summary.md" }
}
```

```json
{ "to": "st:robinhoodchain:0x02…", "token": "0xToken", "amount": { "value": "40", "unit": "USDC" }, "gasStipend": "0.0005 ETH" }
```

## Prompts and the calls they produce

**"Pay research-agent 0.25 ETH privately for task #42 and attach the deliverable name."**

```
jomo_resolve { address: "research-agent's identity address" }
jomo_send    { to: "…", amount: "0.25 ETH", memo: { taskId: "42", deliverable: "summary.md" } }
→ confirmation (shows the 1% fee: 0.0025 ETH on top)
→ { stealthAddress: "0xecA4…E9D8", hash: "0xa93f…", mode: "router", fee: "0.0025 ETH",
    note: "Recipient unlinkable; amount and your sender wallet are public." }
```

**"Did anyone pay me since block 112,500,000?"**

```
jomo_scan { fromBlock: 112500000 }
→ { payments: [{ stealthAddress, amount: "0.25 ETH", memo: {…}, block }], nextCursor: 112531007 }
```

**"Forward half of the last payment to data-agent, keep it private."**

```
jomo_forward { fromStealthAddress: "0xecA4…E9D8", to: "data-agent", amount: "0.125 ETH" }
→ confirmation → { hash: "0x…", from: "0xecA4…E9D8" }
```

**"Is this untraceable?"**

```
jomo_privacy_scope {}
→ { guaranteed: [...], notGuaranteed: ["amounts and tokens", "first hop from an identity wallet", …] }
```

## Errors

Tool errors mirror SDK errors by code: `RECIPIENT_NOT_REGISTERED`, `ROUTER_UNAVAILABLE`,
`INSUFFICIENT_BALANCE`, `INVALID_STEALTH_META_ADDRESS`, `MEMO`. The server adds `AMOUNT_FORMAT`,
`INVALID_RECIPIENT`, `UNKNOWN_STEALTH_ADDRESS`, `GAS_STIPEND_NOT_APPLICABLE`, `GAS_STIPEND_TOO_LARGE` and
`CONFIRMATION_REQUIRED` (which is a normal outcome, not a failure).

## OpenAI function schemas

```ts
import { jomoToolSchemas } from "@jomo/mcp/schemas";
// [{ type: "function", function: { name: "jomo_send", description, parameters } }, …]
```
