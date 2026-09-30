import type { Address, Chain, Hash, Hex, LocalAccount, Transport } from "viem";
import type { StealthKeys } from "./crypto/keys.js";
import type { Memo, MemoInput } from "./crypto/memo.js";

export interface ContractAddresses {
  /** ERC-5564 Announcer. Defaults to the canonical singleton. */
  announcer: Address;
  /** ERC-6538 Registry. Defaults to the canonical singleton. */
  registry: Address;
  /**
   * StealthRouter. Defaults to the deployment recorded for the chain (see
   * `STEALTH_ROUTER_DEPLOYMENTS`); `null` disables the router and forces direct
   * (multi-transaction, fee-free) ERC-5564 sends.
   */
  router: Address | null;
  /**
   * Earlier StealthRouter versions on this chain. Their announcements still count as router
   * announcements when scanning; they are never used to send. Defaults to the deployment record.
   */
  previousRouters: readonly Address[];
}

export interface ScanDefaults {
  /** First block to scan when `scan()` is called without `fromBlock`. Defaults to a recent lookback window. */
  fromBlock?: bigint | undefined;
  /** Blocks per `eth_getLogs` request. Public RPCs usually cap this; default 5000. */
  chunkSize?: bigint | undefined;
  /** Only consider announcements emitted through the StealthRouter (cheaper, less interoperable). */
  onlyRouter?: boolean | undefined;
}

export interface PrivateAgentConfig {
  /** `robinhood`, `robinhoodTestnet`, or any EVM chain where the contracts are deployed. */
  chain: Chain;
  /** viem transport; defaults to `http()` against the chain's default RPC. */
  transport?: Transport | undefined;
  /** The agent's identity/funding wallet. Optional for receive-only agents. */
  account?: LocalAccount | undefined;
  /** Stealth spending + viewing keys. */
  stealthKeys: StealthKeys;
  contracts?: Partial<ContractAddresses> | undefined;
  /** Override the `st:<shortName>:` prefix. Defaults from the chain id. */
  chainShortName?: string | undefined;
  scan?: ScanDefaults | undefined;
  /** ETH forwarded with ERC-20 payments so the recipient can pay gas. Default 0. */
  defaultGasStipend?: bigint | undefined;
  /** Polling interval for `watch()` in ms. Default 2000. */
  pollingInterval?: number | undefined;
  /**
   * ERC-20 tokens whose `balanceOf` this agent trusts. An announcement names its token itself, and
   * both the SDK and the StealthRouter can only ask that token what it holds, so a malicious token
   * can report any balance. ERC-20 payments are only marked `verified` for tokens listed here,
   * whether or not they came through the router. Native ETH needs no list.
   */
  trustedTokens?: readonly Address[] | undefined;
}

export type SendMode = "auto" | "router" | "direct";

export interface SendParams {
  /** Stealth meta-address (`st:…` or 0x-hex) or an address registered in the ERC-6538 registry. */
  to: string;
  amount: bigint;
  /** ERC-20 token. Omit for native ETH. */
  token?: Address | undefined;
  /** Encrypted, recipient-only payload. */
  memo?: MemoInput | undefined;
  /** ETH sent alongside an ERC-20 payment. Defaults to `defaultGasStipend`. */
  gasStipend?: bigint | undefined;
  /**
   * Spend from a stealth address the agent controls (a `StealthPayment` or its private key)
   * instead of the identity account. This is how agent-to-agent hops stay unlinked.
   */
  from?: StealthPayment | Hex | undefined;
  /** `auto` (default) uses the router when deployed, else direct ERC-5564 transactions. */
  mode?: SendMode | undefined;
  /** Wait for receipts (default true). */
  wait?: boolean | undefined;
  /** Deterministic ephemeral key for tests. Never reuse in production. */
  ephemeralPrivateKey?: Hex | undefined;
}

export interface SendResult {
  /** Transaction that emitted the announcement. */
  hash: Hash;
  /** Protocol fee paid on top of `amount` (router mode only; `0n` in direct mode). */
  fee: bigint;
  /** Every transaction sent (approve/transfer/stipend/announce), in order. */
  transactionHashes: Hash[];
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag: number;
  mode: Exclude<SendMode, "auto">;
  from: Address;
  token: Address | null;
  amount: bigint;
  gasStipend: bigint;
}

export type BatchPaymentParams = Omit<SendParams, "from" | "mode" | "wait">;

export interface SendBatchParams {
  payments: BatchPaymentParams[];
  from?: StealthPayment | Hex | undefined;
  wait?: boolean | undefined;
}

export interface SendBatchResult {
  hash: Hash;
  transactionHashes: Hash[];
  from: Address;
  /** Sum of protocol fees across the batch, per asset (`"ETH"` or token address). */
  fees: Record<string, bigint>;
  payments: Omit<SendResult, "hash" | "transactionHashes" | "mode" | "from">[];
}

/** Live counters published by the FeeVault (native ETH). */
export interface LayerStats {
  /** Router payments recorded since deployment, every asset. */
  transactions: bigint;
  /** Native ETH payments only; the denominator for `ethRouted` and `ethFees`. */
  ethTransactions: bigint;
  /** ETH routed to stealth addresses through the router (fees excluded), in wei. */
  ethRouted: bigint;
  /** ETH protocol fees collected, in wei. */
  ethFees: bigint;
  feeVault: Address;
  stealthRouter: Address;
}

/** An incoming payment the agent has detected and can spend. */
export interface StealthPayment {
  stealthAddress: Address;
  /**
   * Private key controlling `stealthAddress`. Treat as a secret. Not enumerable: it is left out of
   * `JSON.stringify` and log output, and out of `{ ...payment }` copies.
   */
  readonly stealthPrivateKey: Hex;
  ephemeralPublicKey: Hex;
  viewTag: number;
  /** `null` = ETH, `undefined` = announcement did not use the standard metadata layout. */
  token: Address | null | undefined;
  /**
   * Amount claimed by the announcement metadata. Announcements are permissionless, so this is
   * sender-supplied and unauthenticated: anyone can re-announce a real stealth address with any
   * number. Use `balance` / `verified` before acting on it.
   */
  amount: bigint | undefined;
  /** On-chain balance of `stealthAddress` in `token` (or ETH) at scan time. */
  balance: bigint;
  /**
   * `true` when the announced token and amount were actually delivered to `stealthAddress`. For
   * ETH: the StealthRouter announced it (it moved the ETH itself), or the address's ETH balance
   * covers the amount. For an ERC-20: only if the token is in `trustedTokens`, and then the router
   * announced it or the balance covers it. Any other token is never verified, because the token
   * contract is the only witness. `balance` says what is there now.
   */
  verified: boolean;
  /** Set when the balance could not be read (the announced token is not a working ERC-20). */
  balanceError: string | undefined;
  /** The announcement was emitted by the StealthRouter (token and amount validated on chain). */
  viaRouter: boolean;
  /**
   * How many announcements pointed at this stealth address in this scan. One is reported: the
   * best-evidenced (delivered, then router-announced, then carrying a memo that decrypts, then the
   * earliest), so a copied or front-run announcement cannot replace the real payment.
   */
  announcements: number;
  memo: Memo | undefined;
  /** Set when a memo was present but could not be decrypted. */
  memoError: string | undefined;
  /** `msg.sender` of `announce` (the router, or the sender for direct announcements). */
  caller: Address;
  transactionHash: Hash;
  blockNumber: bigint;
  logIndex: number;
  metadata: Hex;
}

export interface ScanOptions {
  fromBlock?: bigint | undefined;
  toBlock?: bigint | undefined;
  chunkSize?: bigint | undefined;
  onlyRouter?: boolean | undefined;
  /** Progress callback per chunk. */
  onProgress?: ((info: { fromBlock: bigint; toBlock: bigint; found: number }) => void) | undefined;
}

export interface ScanResult {
  payments: StealthPayment[];
  fromBlock: bigint;
  /** Persist `toBlock + 1n` as the next cursor. */
  toBlock: bigint;
}

export interface WatchOptions {
  onPayment: (payment: StealthPayment) => void;
  onError?: ((error: Error) => void) | undefined;
  fromBlock?: bigint | undefined;
  onlyRouter?: boolean | undefined;
  pollingInterval?: number | undefined;
}

export interface SweepParams {
  from: StealthPayment | Hex;
  to: Address;
  token?: Address | undefined;
  /** Defaults to the full balance (minus gas for ETH). */
  amount?: bigint | undefined;
  wait?: boolean | undefined;
}
