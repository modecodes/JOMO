# API reference

```bash
pnpm add @jomo/sdk viem
```

Node ≥ 20.19, ESM or CJS. All amounts are `bigint` in wei / token base units.

## `createPrivateAgent(config) → PrivateAgent`

### `PrivateAgentConfig`

| Field | Type | Default | Notes |
|---|---|---|---|
| `chain` | `Chain` | required | `robinhood` (4663), `robinhoodTestnet` (46630), or any EVM chain with the contracts |
| `transport` | `Transport` | `http()` | any viem transport |
| `account` | `LocalAccount` | — | needed for `register`, `send`, `sendBatch` without `from` |
| `stealthKeys` | `StealthKeys` | required | see below |
| `contracts` | `Partial<ContractAddresses>` | canonical | `router: null` forces direct mode |
| `chainShortName` | `string` | from chain id | prefix in `st:<name>:` |
| `scan.fromBlock` | `bigint` | latest − 100 000 | set this; scanning from genesis is slow |
| `scan.chunkSize` | `bigint` | `5000n` | blocks per `eth_getLogs` |
| `scan.onlyRouter` | `boolean` | `false` | filter announcements by `caller == StealthRouter` |
| `defaultGasStipend` | `bigint` | `0n` | ETH forwarded with ERC-20 payments |
| `pollingInterval` | `number` | `2000` | ms, for `watch()` |

### Properties

- `agent.address: Address | undefined` — identity wallet.
- `agent.stealthMetaAddress: string` — `st:<chain>:0x<66 bytes>`.
- `agent.keys: StealthKeys`, `agent.chain`, `agent.publicClient`, `agent.contracts`.

### Identity

- `register({ wait? }) → Promise<Hash>` — `ERC6538Registry.registerKeys(1, metaAddressBytes)`.
- `resolve(address) → Promise<string | null>` — registered meta-address URI or `null`.
- `getRouter() → Promise<Address | null>` — the router to send through; `null` when none is configured. Throws `RouterUnavailableError` (`reason: "missing"` or `"disabled"`) when it has no code or its vault has stopped it; the vault is checked on every call.
- `quoteFee(amount) → Promise<bigint>` — the 1% protocol fee a send would pay now; `0n` in direct mode or while the router is stopped.
- `getStats() → Promise<LayerStats>` — `{ transactions, ethTransactions, ethRouted, ethFees, feeVault, stealthRouter }` from the FeeVault.

### Sending

`send(params: SendParams) → Promise<SendResult>`

| Param | Type | Notes |
|---|---|---|
| `to` | `string` | meta-address URI / 66-byte hex, or a registered identity address |
| `amount` | `bigint` | > 0 |
| `token` | `Address?` | ERC-20; omit for ETH |
| `memo` | `string \| Uint8Array \| object` | encrypted to the recipient; ≤ 8 KiB |
| `gasStipend` | `bigint?` | ETH sent with an ERC-20 payment |
| `from` | `StealthPayment \| Hex?` | spend from a stealth address instead of the identity wallet |
| `mode` | `"auto" \| "router" \| "direct"` | `auto` uses the router when deployed |
| `wait` | `boolean` | wait for receipts (default `true`) |

Router mode: `[approve?] → StealthRouter.sendToken/sendEth` (1–2 txs, atomic pay+announce).
Direct mode: `transfer → [stipend] → ERC5564Announcer.announce` (2–3 txs).

`SendResult`: `hash`, `fee`, `transactionHashes[]`, `stealthAddress`, `ephemeralPublicKey`, `viewTag`,
`mode`, `from`, `token`, `amount`, `gasStipend`.

`forward(params & { from })` — alias of `send` that requires `from`.

`sendBatch({ payments, from?, wait? }) → Promise<SendBatchResult>` — one atomic
`StealthRouter.sendBatch`; `fees` sums protocol fees per asset; throws `RouterUnavailableError`
without the router.

### Receiving

- `scan(options?) → Promise<ScanResult>` — `{ payments, fromBlock, toBlock }`. Options:
  `fromBlock`, `toBlock`, `chunkSize`, `onlyRouter`, `onProgress`.
- `watch({ onPayment, onError?, fromBlock?, onlyRouter?, pollingInterval? }) → () => void`.
- `stealthAccount(paymentOrPrivateKey) → LocalAccount` — viem account for a stealth address.
- `sweep({ from, to, token?, amount?, wait? }) → Promise<Hash>` — moves the whole balance by
  default (ETH sweeps leave a little gas dust).
- `balanceOf(address, token?) → Promise<bigint>`.

### `StealthPayment`

`stealthAddress`, `stealthPrivateKey` (secret, non-enumerable), `ephemeralPublicKey`, `viewTag`,
`token` (`null` = ETH, `undefined` = non-standard metadata), `amount` (announced, unauthenticated),
`balance`, `verified` (delivered: router-emitted, or direct and covered for ETH or a
`trustedTokens` token), `viaRouter`, `announcements`, `memo` (`{ kind: "text" | "json" | "bytes",
value }`), `memoError`, `caller`, `transactionHash`, `blockNumber`, `logIndex`, `metadata`.

A transaction that is mined but reverts throws `TransactionRevertedError` (`code:
"TRANSACTION_REVERTED"`, `hash`) from `send`, `sendBatch`, `register` and `sweep`; it is never
returned as a result.

---

## `StealthKeys`

| Constructor | Use |
|---|---|
| `StealthKeys.generate()` | random keys; persist them |
| `StealthKeys.fromAccount(signer, { chainId })` | deterministic from a wallet signature (recommended) |
| `StealthKeys.fromSignature(sig, { message?, signer? })` | from a canonical ECDSA signature, optionally checked against its signer |
| `StealthKeys.fromSeed(seed)` | HKDF-SHA256 from ≥16 bytes of entropy |
| `StealthKeys.fromPrivateKeys({ spendingPrivateKey, viewingPrivateKey })` | explicit |

Members: `spendingPrivateKey`, `viewingPrivateKey`, `spendingPublicKey`, `viewingPublicKey`,
`publicKeys`, `metaAddressBytes`, `metaAddress(chainShortName?)`, `toPrivateKeys()`, `toJSON()`
(public keys only).

## Low-level primitives

All exported for custom integrations:

- `generateStealthAddress({ spendingPublicKey, viewingPublicKey, ephemeralPrivateKey? })`
- `checkStealthAddress({ stealthAddress, ephemeralPublicKey, viewingPrivateKey, spendingPublicKey, viewTag? })`
- `computeStealthKey({ ephemeralPublicKey, viewingPrivateKey, spendingPrivateKey })`
- `deriveSharedSecret`, `hashSharedSecret`, `SCHEME_ID`
- `encodeStealthMetaAddress`, `encodeStealthMetaAddressBytes`, `parseStealthMetaAddress`, `isStealthMetaAddress`
- `encryptMemo({ sharedSecret, stealthAddress, binding, memo })`, `decryptMemo({ …, binding, ciphertext })`,
  `memoAssociatedData`, `deriveMemoKey`, `isMemoCiphertext`. `binding` is `{ chainId, viewTag, token, amount }`.
- `encodeAnnouncementMetadata`, `decodeAnnouncementMetadata`
- `quoteFee(amount)` (pure), `computeDeploymentAddresses({ feeVaultOwner, announcer? })`
- Addresses/ABIs: `ERC5564_ANNOUNCER_ADDRESS`, `ERC6538_REGISTRY_ADDRESS`, `STEALTH_ROUTER_DEPLOYMENTS`,
  `STEALTH_ROUTER_FEE_BPS`, `STEALTH_ROUTER_SALT`, `FEE_VAULT_SALT`, `CREATE2_FACTORY_ADDRESS`,
  `erc5564AnnouncerAbi`, `erc6538RegistryAbi`, `stealthRouterAbi`, `stealthRouterBytecode`,
  `feeVaultAbi`, `feeVaultBytecode`

## Errors

All extend `JomoError` with a stable `code`: `InvalidStealthMetaAddressError`,
`InvalidKeyError`, `RecipientNotRegisteredError`, `NoAccountError`, `RouterUnavailableError`,
`MemoError`, `InsufficientBalanceError`.

## Network facts used by the SDK

| | Mainnet | Testnet |
|---|---|---|
| Chain id | 4663 | 46630 |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` | `https://explorer.testnet.chain.robinhood.com` |
| ERC-5564 Announcer | `0x55649E01B5Df198D18D95b5cc5051630cfD45564` | same |
| ERC-6538 Registry | `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538` | same |
| StealthRouter v2 | `0xDc30aACc6883F3f2b27C6981e4BF641c336dCA30` (live since 2026-09-30, in `STEALTH_ROUTER_DEPLOYMENTS`) | not yet deployed; SDK runs in direct mode |
| FeeVault | `0xA01ABBfEaC3540dF18629A8c5bb383e33F448f75` (live since 2026-09-30) | not yet deployed |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | same |

Public RPCs are rate-limited and not recommended for production scanning.
