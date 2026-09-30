# Receiving & spending

Detection uses the viewing key only. Spending uses the spending key, derived per payment.

## Scan with a cursor

```ts
let cursor = 112_000_000n; // block where this agent started

const { payments, toBlock } = await agent.scan({ fromBlock: cursor });
cursor = toBlock + 1n;      // persist it
```

`scan()` reads `Announcement` events in chunks (`chunkSize`, default 5 000 blocks — public RPCs cap
log ranges), pre-filters by the one-byte view tag, and runs the ECDH check only on candidates. Pass
`onlyRouter: true` to look at router announcements only (cheaper, less interoperable).

Without `fromBlock` the SDK scans the last 100 000 blocks. Always configure `scan.fromBlock`.

## Watch live

```ts
const stop = agent.watch({
  onPayment: (p) => console.log("received", p.amount, "at", p.stealthAddress),
  onError: (e) => console.error(e),
  pollingInterval: 2_000,
});
// later
stop();
```

## What a payment looks like

```ts
interface StealthPayment {
  stealthAddress: Address;
  readonly stealthPrivateKey: Hex; // secret; not enumerable (kept out of JSON, logs and spreads)
  ephemeralPublicKey: Hex;
  viewTag: number;
  token: Address | null | undefined; // null = ETH, undefined = non-standard metadata
  amount: bigint | undefined;        // ANNOUNCED by the sender; unauthenticated
  balance: bigint;                   // on chain at scan time; authoritative
  verified: boolean;                 // the announced token and amount were actually delivered
  viaRouter: boolean;                // announced by the StealthRouter (validated on chain)
  announcements: number;             // announcements naming this address in this scan
  memo: { kind: "json" | "text" | "bytes"; value: unknown } | undefined;
  memoError: string | undefined;   // set when a memo was present but did not decrypt
  caller: Address;                 // router, or the sender in direct mode
  transactionHash: Hash;
  blockNumber: bigint;
  logIndex: number;
  metadata: Hex;
}
```

**Announcements are permissionless.** Anyone can re-announce a real stealth address with any
amount, and the scanner will still match it (the ECDH check passes). The SDK handles this three ways:

- **One payment per address.** `scan()` and `watch()` report each stealth address once, from the
  first announcement in block order; later announcements for it only raise `announcements`.
- **`verified` means delivered.** It is `true` when the StealthRouter emitted the announcement (the
  router checked the transfer on chain), when a direct ETH announcement is covered by the address's
  ETH balance, or when a direct announcement names a token you listed in `trustedTokens` and its
  balance covers the amount. A direct announcement of any other token is never verified, because
  the token contract is the only witness and a malicious one can report any balance.
- **Memos are bound to the figures.** A memo only decrypts next to the chain, token, amount and view
  tag it was written for, so a memo copied into a forged announcement shows up as `memoError`.

`balance` is what the address holds now. Act on it:

```ts
const eth = await agent.balanceOf(p.stealthAddress);
const tok = await agent.balanceOf(p.stealthAddress, p.token!);
```

## Spending

```ts
// Onward, privately (the next agent gets a fresh address; you sign from the stealth one)
await agent.forward({ from: p, to: nextAgent, amount: parseEther("0.05"), memo: "share" });

// Anywhere, e.g. consolidation
await agent.sweep({ from: p, to: treasury });                     // full ETH balance minus gas
await agent.sweep({ from: p, to: treasury, token: p.token! });    // full token balance

// Anything else viem can do
const signer = agent.stealthAccount(p);
```

ETH sweeps estimate gas on chain (L2 gas includes an L1 data component) and leave a little dust
behind because fee caps exceed the price paid.

## A minimal agent loop

```ts
async function serve(agent: PrivateAgent, store: { cursor: bigint }) {
  const { payments, toBlock } = await agent.scan({ fromBlock: store.cursor });
  for (const p of payments) {
    if (p.memo?.kind !== "json") continue;
    const job = p.memo.value as { taskId: string; subcontractor?: string };
    await doWork(job);
    if (job.subcontractor) {
      await agent.forward({ from: p, to: job.subcontractor, amount: (p.amount ?? 0n) / 2n });
    }
  }
  store.cursor = toBlock + 1n;
}
setInterval(() => void serve(agent, store), 5_000);
```

Next: [Configuration & networks](configuration.md)
