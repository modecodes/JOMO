# Sending

`agent.send()` resolves the recipient, derives a one-time stealth address, seals the memo, pays and
announces. Everything below is a variation of that one call.

## Native ETH

```ts
await agent.send({ to: recipient, amount: parseEther("0.25") });
```

`to` is a registered identity address **or** a `st:…` meta-address.

## ERC-20 with a gas stipend

A stealth address that receives only tokens has no ETH to spend them. Forward a little ETH in the same
transaction so the recipient never has to fund it from a linkable wallet:

```ts
await agent.send({
  to: recipient,
  token: "0xTokenAddress",
  amount: parseUnits("25", 6),
  gasStipend: parseEther("0.0005"),
});
```

Set `defaultGasStipend` in the config to apply one to every token payment. The router pulls tokens
with `transferFrom`; the SDK submits an `approve` for the exact amount first when the allowance is
insufficient.

## Memos

```ts
await agent.send({ to, amount, memo: { taskId: "42", deliverable: "summary.md" } }); // JSON
await agent.send({ to, amount, memo: "invoice #7" });                                  // text
await agent.send({ to, amount, memo: new Uint8Array([1, 2, 3]) });                     // bytes
```

Memos are encrypted to the recipient's viewing key and travel inside the announcement. Limit 8 KiB;
JSON must be serialisable (no `bigint`). Plaintexts are padded to size buckets (64, 256, 1024, 4096
or 8192 bytes), so the bucket is visible on chain and the exact length is not. Memos are stored on
chain forever: a viewing-key compromise decrypts all of them.

## Protocol fee

Router transactions carry a **1% protocol fee, charged on top of the payment in the same asset**. The
recipient receives exactly `amount`; the announcement metadata carries `amount`; the fee goes to the
FeeVault, which can pass it on only to its sink, the contract that pays $JOMO holders.

```ts
await agent.quoteFee(parseEther("1"));   // 10000000000000000n (0.01 ETH) in router mode, 0n in direct mode

const r = await agent.send({ to, amount: parseEther("1") });
r.fee;                                   // 0.01 ETH, paid from the sender's wallet
```

- Native ETH: the transaction value is `amount + fee`.
- ERC-20: the approval covers `amount + fee`; the fee is pulled in the same token.
- Batches: `SendBatchResult.fees` sums fees per asset (`"ETH"` or the token address).
- Gas stipends are not charged, and are capped at 0.01 ETH (`STEALTH_ROUTER_MAX_GAS_STIPEND`) per
  transaction in router mode, so the stipends of a batch share one cap: a stipend only pays the
  recipient's gas. A larger one throws `RangeError`; send ETH as its own payment.
- Direct mode (no router on the chain, `mode: "direct"`, or the router stopped by its vault) is
  fee-free and earns holders nothing.
- If a token needs its allowance reset to zero before a new approval (USDT-style), the SDK does that
  first; `transactionHashes` then starts with the reset.

The fee is rounded up, so it is never zero for a non-zero amount (`quoteFee(1n) === 1n`).

## Router mode vs direct mode

| `mode` | Transactions | Atomic | Needs |
|---|---|---|---|
| `"auto"` (default) | router when deployed and allowed by its vault, else direct | — | — |
| `"router"` | 1 (+1 approve for ERC-20) | pay + fee + announce together | `StealthRouter` deployed on the chain |
| `"direct"` | 2–3: transfer, optional stipend, announce | no | canonical singletons only; no fee |

```ts
const r = await agent.send({ to, amount, mode: "direct" });
r.transactionHashes; // every transaction sent, in order
r.hash;              // the one that emitted the announcement
```

The fee vault's owner or guardian can stop the router in an emergency. The SDK checks the vault on
every send: while the router is stopped, `auto` sends go direct (no fee), `mode: "router"` and
`sendBatch` throw `RouterUnavailableError` with `reason: "disabled"`, and `quoteFee` returns `0n`.
When the router is allowed again, sends return to it by themselves.

## Batches

Many recipients, one atomic transaction (router only):

```ts
await agent.sendBatch({
  payments: [
    { to: workerA, amount: parseEther("0.1"), memo: "task-1" },
    { to: workerB, token: usdc, amount: parseUnits("40", 6), gasStipend: parseEther("0.0005") },
  ],
});
```

Approvals are aggregated per token (amounts plus fees). Throws `RouterUnavailableError` in direct mode.

## Paying from a stealth address

Any `StealthPayment` you detected (or its private key) can be the sender. This is how agent-to-agent
hops stay unlinked:

```ts
await agent.send({ from: payment, to: nextAgent, amount, memo: "40% share" });
// equivalent:
await agent.forward({ from: payment, to: nextAgent, amount });
```

## Not waiting for receipts

```ts
const r = await agent.send({ to, amount, wait: false });
```

Nonces are assigned explicitly so multi-transaction flows stay ordered; wait for `r.hash` yourself
before treating the payment as final.

## What the sender keeps

`SendResult` includes the `ephemeralPublicKey` and `stealthAddress`. Router mode pays and announces in
one transaction, so there is no in-between state. Direct mode sends the transfer and the announcement
as separate transactions: if the process dies after the transfer is mined and before the
announcement, `send` never returns, the ephemeral key existed only in memory, and the recipient has
no way to find the funds. Use router mode for anything that matters; in direct mode, keep payments
small until the router is deployed on your chain.

If any transaction in the flow is mined but reverts, `send` throws `TransactionRevertedError` with
its hash instead of returning a result.

Next: [Receiving & spending](receiving.md)
