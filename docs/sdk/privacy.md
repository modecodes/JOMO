# Privacy guarantees

Design your agent around exactly these properties. The SDK does not claim more, and neither should you.

## Guaranteed

| Property | Against | Mechanism |
|---|---|---|
| Recipient unlinkability | chain observers, RPC providers | fresh ERC-5564 address per payment; view-tag scanning |
| Memo confidentiality and integrity | everyone but the recipient | XChaCha20-Poly1305 under HKDF(shared secret, stealth address) |
| Spend authority stays with the recipient | counterparties, viewing-key holders | `p_stealth = p_spend + s_h`; only the spending key can derive it |
| Sender detachment on hops | chain observers | onward payments signed by stealth addresses |
| No custody of payments | operator risk | stateless, ownerless router; payments never rest in it. The fee vault's owner or guardian can stop the router (payments then go direct, fee-free) but can never touch a payment |

## Not guaranteed

- **Amounts and tokens** are public. The transfer is an ordinary transfer.
- **The first hop** from an identity wallet is public: observers see `A → fresh address`.
- **Graph and timing analysis** can cluster stealth addresses probabilistically.
- **RPC metadata**: scanning and balance checks reveal interest patterns to the provider.
- **Memo size bucket** is visible (64 / 256 / 1024 / 4096 / 8192 bytes); memos persist on chain, so a
  viewing-key compromise decrypts all past memos.
- **Using JOMO is visible.** Router calls, fee transfers and the announcement layout let anyone list
  JOMO payments. The layer hides who received, not that JOMO was used.
- **Announced amounts are unauthenticated.** Anyone can re-announce a stealth address with any
  number; `balance` reflects chain state and `verified` says whether the announced figures were
  actually delivered (see [Receiving](receiving.md)).
- **Identity-wallet compromise redirects future payments.** The registry entry can be replaced by
  whoever holds the identity key; past stealth funds stay safe.
- **Signature-derived keys can be phished.** Any site that gets the wallet to sign the derivation
  message obtains the stealth keys; see [Keys & identity](keys.md).
- **Direct mode** announces in a separate transaction; a crash between transfer and announce leaves
  funds unannounced (still spendable with the sender's `ephemeralPublicKey`).

## Operational advice for agents

- Set `scan.fromBlock`; scan from your own node or a dedicated provider.
- Vary amounts and delay hops when relationships are sensitive.
- Do not sweep many stealth addresses into one destination in a single block.
- Keep spending keys off scanner hosts; ship the viewing key only.
- Treat `StealthPayment` objects as secrets, and memo contents as untrusted input from the sender.
- Avoid identical gas stipends and round forwarding fractions; they cluster addresses.

## Wording your product can use

Allowed: "private transactions", "unlinkable recipient addresses", "encrypted memos", "built on
ERC-5564". Not allowed: "untraceable", "anonymous", "fully private", "audited" (no audit yet).

Next: [API reference](api.md)
