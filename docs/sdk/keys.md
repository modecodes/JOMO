# Keys & identity

An agent's stealth identity is two secp256k1 key pairs wrapped in `StealthKeys`.

| Key | Can | Cannot | Where it lives |
|---|---|---|---|
| spending | spend from every stealth address | — | the agent's signer, offline where possible |
| viewing | detect payments, decrypt memos | spend | scanners, monitoring, auditors |

## Creating keys

```ts
import { StealthKeys } from "@jomo/sdk";

// Recommended for agents with a secrets store: random keys, persisted once.
const fresh = StealthKeys.generate();

// Derived from a wallet signature. Same wallet + chain → same keys, provided the signer is
// deterministic (RFC 6979). The SDK signs twice and refuses signers that disagree with themselves.
const keys = await StealthKeys.fromAccount(account, { chainId: 4663 });

// From ≥16 bytes of entropy (HKDF-SHA256).
const seeded = StealthKeys.fromSeed(process.env.AGENT_SEED!);

// From a canonical (low-s) ECDSA signature; pass the message and signer to have it checked.
const fromSig = StealthKeys.fromSignature(signature, { message, signer: account.address });
const explicit = StealthKeys.fromPrivateKeys({ spendingPrivateKey, viewingPrivateKey });
```

`fromAccount` signs a fixed message that names the chain id and warns the signer. Two things follow:

- **Anyone who gets your wallet to sign that message gets your stealth keys.** A phishing site can
  request exactly this signature. Sign it only inside software you trust, and prefer `generate()`
  for agents that already keep secrets.
- **The signer must be deterministic.** MPC and some hardware wallets use random nonces and would
  derive different keys each time, stranding funds received earlier; the SDK detects this and throws
  (`verifyDeterministic: false` skips the check). ERC-1271 smart accounts are not supported.

## Meta-address

The two public keys, in the form counterparties use to pay you:

```ts
keys.metaAddress("robinhoodchain"); // "st:robinhoodchain:0x<spend 33 bytes><view 33 bytes>"
keys.metaAddressBytes;              // "0x…"  (66 bytes, the on-chain registry form)
agent.stealthMetaAddress;           // prefix chosen from the agent's chain
```

Parse one you received:

```ts
import { parseStealthMetaAddress, isStealthMetaAddress } from "@jomo/sdk";

if (isStealthMetaAddress(input)) {
  const { spendingPublicKey, viewingPublicKey, chainShortName } = parseStealthMetaAddress(input);
}
```

## Registry

Publishing lets others pay your plain identity address; the SDK resolves it on their side.

```ts
await agent.register();                        // ERC6538Registry.registerKeys(1, metaAddressBytes)
await agent.resolve("0xSomeAgent");            // "st:…" or null if they never registered
```

Sending to an unregistered address throws `RecipientNotRegisteredError`; pass their meta-address
directly instead.

## Receive-only agents

A scanner needs the viewing key and the spending *public* key only. Give it a `StealthKeys` built
from the viewing private key and a dummy spending key is **not** supported — instead run the
low-level check yourself:

```ts
import { checkStealthAddress } from "@jomo/sdk";

const { matches } = checkStealthAddress({
  stealthAddress,        // from the announcement
  ephemeralPublicKey,    // from the announcement
  viewingPrivateKey,     // the scanner's copy
  spendingPublicKey,     // public, safe to share
  viewTag,               // metadata[0]
});
```

## Handling secrets

- `JSON.stringify(keys)` prints public keys only; use `keys.toPrivateKeys()` deliberately.
- `StealthPayment` objects returned by `scan()` carry `stealthPrivateKey` as a non-enumerable
  property: readable, but left out of `JSON.stringify`, log output and `{ ...payment }` copies. Pass
  the payment object itself to `send({ from })` and `sweep({ from })`.
- `fromSignature` refuses high-s signatures, zero or out-of-range `r`/`s`, and, when given the
  message and signer, a signature made by anyone else. A smart-contract wallet's 65-byte marker is
  not a signature and yields no keys; use `generate()` for those.
- Rotate by registering a new meta-address; old stealth addresses stay spendable with the old keys.

Next: [Sending](sending.md)
