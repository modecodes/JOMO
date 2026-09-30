import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  isAddress,
  isAddressEqual,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainShortName as defaultShortName } from "../chains.js";
import type { StealthKeys } from "../crypto/keys.js";
import { decryptMemo, encryptMemo, isLegacyMemoCiphertext } from "../crypto/memo.js";
import { ROBINHOOD_CHAIN_SHORT_NAME, ROBINHOOD_TESTNET_SHORT_NAME, isStealthMetaAddress, parseStealthMetaAddress, type StealthMetaAddress } from "../crypto/metaAddress.js";
import { decodeAnnouncementMetadata, encodeAnnouncementMetadata } from "../crypto/metadata.js";
import { toBytes, toHex } from "../crypto/secp.js";
import { checkStealthAddress, computeStealthKey, generateStealthAddress, SCHEME_ID } from "../crypto/stealth.js";
import {
  InsufficientBalanceError,
  InvalidStealthMetaAddressError,
  NoAccountError,
  RecipientNotRegisteredError,
  RouterUnavailableError,
  TransactionRevertedError,
  TransferNotDeliveredError,
} from "../errors.js";
import {
  ERC5564_ANNOUNCER_ADDRESS,
  ERC6538_REGISTRY_ADDRESS,
  STEALTH_ROUTER_DEPLOYMENTS,
  STEALTH_ROUTER_FEE_BPS,
  STEALTH_ROUTER_MAX_GAS_STIPEND,
  erc5564AnnouncerAbi,
  erc6538RegistryAbi,
  feeVaultAbi,
  stealthRouterAbi,
} from "../generated/contracts.js";
import type {
  BatchPaymentParams,
  ContractAddresses,
  LayerStats,
  PrivateAgentConfig,
  ScanOptions,
  ScanResult,
  SendBatchParams,
  SendBatchResult,
  SendParams,
  SendResult,
  StealthPayment,
  SweepParams,
  WatchOptions,
} from "../types.js";

/** Blocks scanned by default when no `fromBlock` is configured (≈ 2.8 h at 100 ms blocks). */
export const DEFAULT_SCAN_LOOKBACK = 100_000n;

const BPS = 10_000n;

/** A router token payment may forward at most `STEALTH_ROUTER_MAX_GAS_STIPEND` (0.01 ETH) for gas. */
function assertStipendWithinCap(gasStipend: bigint): void {
  if (gasStipend > STEALTH_ROUTER_MAX_GAS_STIPEND) {
    throw new RangeError(
      `gasStipend ${gasStipend} wei is above the router's cap of ${STEALTH_ROUTER_MAX_GAS_STIPEND} wei (0.01 ETH). A stipend only pays the recipient's gas; send ETH as its own payment.`,
    );
  }
}

/** Protocol fee for a router payment of `amount`: 1%, rounded up (mirrors `StealthRouter.quoteFee`). */
export function quoteFee(amount: bigint): bigint {
  if (amount <= 0n) return 0n;
  return (amount * STEALTH_ROUTER_FEE_BPS + BPS - 1n) / BPS;
}
export const DEFAULT_SCAN_CHUNK_SIZE = 5_000n;
export const DEFAULT_POLLING_INTERVAL = 2_000;

/** A mined transaction that reverted did nothing; report it instead of returning its hash as success. */
export function assertTransactionSucceeded(receipt: { status: "success" | "reverted" }, hash: Hash, what: string): void {
  if (receipt.status !== "success") throw new TransactionRevertedError(hash, what);
}

type Unverified = Omit<StealthPayment, "balance" | "verified" | "viaRouter" | "announcements" | "balanceError">;

/** How strongly an announcement is evidenced; among announcements of one address the highest wins. */
function evidence(p: StealthPayment): number {
  return (p.verified ? 4 : 0) + (p.viaRouter ? 2 : 0) + (p.memo !== undefined ? 1 : 0);
}

/**
 * The stealth private key stays readable (`payment.stealthPrivateKey`) but is not enumerable, so
 * `JSON.stringify`, structured loggers and `console.log` do not write it out. Copying a payment with
 * spread syntax drops it; pass the payment object itself to `send({ from })` or `sweep({ from })`.
 */
function hideSecret(payment: StealthPayment): StealthPayment {
  const key = payment.stealthPrivateKey;
  Object.defineProperty(payment, "stealthPrivateKey", { value: key, enumerable: false, writable: false, configurable: false });
  return payment;
}

/** Structural view of an `Announcement` log (works for both getLogs and watch results). */
interface AnnouncementLog {
  args: {
    schemeId?: bigint | undefined;
    stealthAddress?: Address | undefined;
    caller?: Address | undefined;
    ephemeralPubKey?: Hex | undefined;
    metadata?: Hex | undefined;
  };
  transactionHash: Hash | null;
  blockNumber: bigint | null;
  logIndex: number | null;
}

interface PreparedPayment {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag: number;
  metadata: Hex;
  token: Address | null;
  amount: bigint;
  gasStipend: bigint;
}

function ethKey(token: Address | null): string {
  return token ?? "ETH";
}

/**
 * High-level client: one object per agent. Wraps a viem public client, the agent's stealth keys and
 * (optionally) its identity wallet.
 */
export class PrivateAgent {
  readonly chain: Chain;
  readonly publicClient: PublicClient;
  readonly keys: StealthKeys;
  readonly account: LocalAccount | undefined;
  readonly contracts: Readonly<ContractAddresses>;

  private readonly transport: Transport;
  private readonly shortName: string;
  private readonly scanDefaults: { fromBlock: bigint | undefined; chunkSize: bigint; onlyRouter: boolean };
  private readonly defaultGasStipend: bigint;
  private readonly pollingInterval: number;
  private readonly trustedTokens: ReadonlySet<string>;
  /** The configured router's code check and its (immutable) vault, cached once they succeed. */
  private routerInfoPromise: Promise<{ router: Address; feeVault: Address }> | undefined;

  constructor(config: PrivateAgentConfig) {
    this.chain = config.chain;
    this.transport = config.transport ?? http();
    this.pollingInterval = config.pollingInterval ?? DEFAULT_POLLING_INTERVAL;
    // cacheTime 0: agents scan in tight loops and must always see the true head block.
    this.publicClient = createPublicClient({
      chain: config.chain,
      transport: this.transport,
      pollingInterval: this.pollingInterval,
      cacheTime: 0,
    });
    this.keys = config.stealthKeys;
    this.account = config.account;
    const deployment = STEALTH_ROUTER_DEPLOYMENTS[config.chain.id];
    this.contracts = {
      announcer: config.contracts?.announcer ?? ERC5564_ANNOUNCER_ADDRESS,
      registry: config.contracts?.registry ?? ERC6538_REGISTRY_ADDRESS,
      router: config.contracts?.router === undefined ? (deployment?.stealthRouter ?? null) : config.contracts.router,
      previousRouters: config.contracts?.previousRouters ?? deployment?.previousStealthRouters ?? [],
    };
    this.shortName = config.chainShortName ?? defaultShortName(config.chain.id);
    this.scanDefaults = {
      fromBlock: config.scan?.fromBlock,
      chunkSize: config.scan?.chunkSize ?? DEFAULT_SCAN_CHUNK_SIZE,
      onlyRouter: config.scan?.onlyRouter ?? false,
    };
    this.defaultGasStipend = config.defaultGasStipend ?? 0n;
    this.trustedTokens = new Set((config.trustedTokens ?? []).map((t) => t.toLowerCase()));
  }

  // ---------------------------------------------------------------------------------------
  // Identity
  // ---------------------------------------------------------------------------------------

  /** The agent's identity wallet address, if configured. */
  get address(): Address | undefined {
    return this.account?.address;
  }

  /** `st:<chain>:0x…` meta-address to share with counterparties. */
  get stealthMetaAddress(): string {
    return this.keys.metaAddress(this.shortName);
  }

  /** Publish the meta-address in the ERC-6538 registry so others can pay `agent.address` privately. */
  async register(options: { wait?: boolean | undefined } = {}): Promise<Hash> {
    const wallet = this.walletFor(undefined);
    const hash = await wallet.writeContract({
      address: this.contracts.registry,
      abi: erc6538RegistryAbi,
      functionName: "registerKeys",
      args: [SCHEME_ID, this.keys.metaAddressBytes],
      chain: this.chain,
      account: wallet.account,
    });
    if (options.wait !== false) assertTransactionSucceeded(await this.publicClient.waitForTransactionReceipt({ hash }), hash, "Registration");
    return hash;
  }

  /** Look up a registrant's meta-address (scheme 1). `null` when unregistered. */
  async resolve(registrant: Address): Promise<string | null> {
    const bytes = await this.publicClient.readContract({
      address: this.contracts.registry,
      abi: erc6538RegistryAbi,
      functionName: "stealthMetaAddressOf",
      args: [registrant, SCHEME_ID],
    });
    if (!bytes || bytes === "0x") return null;
    return `st:${this.shortName}:${bytes}`;
  }

  /**
   * The StealthRouter to send through: `null` when none is configured for this chain. Throws
   * `RouterUnavailableError` when one is configured but unusable: no code at the address
   * (`reason: "missing"`), or its FeeVault has stopped it (`reason: "disabled"`, the emergency
   * stop). The code check is cached once it succeeds; whether the vault still allows the router is
   * read on every call, so a stop takes effect at once and a restart is picked up the same way.
   */
  async getRouter(): Promise<Address | null> {
    if (this.contracts.router === null) return null;
    const { router, feeVault } = await this.routerInfo();
    const allowed = await this.publicClient.readContract({ address: feeVault, abi: feeVaultAbi, functionName: "isRouter", args: [router] });
    if (!allowed) throw new RouterUnavailableError(this.chain.id, router, "disabled");
    return router;
  }

  /** The configured router (with code) and its vault, whether or not the vault currently allows it. */
  private routerInfo(): Promise<{ router: Address; feeVault: Address }> {
    if (this.routerInfoPromise) return this.routerInfoPromise;
    const configured = this.contracts.router;
    if (configured === null) return Promise.reject(new RouterUnavailableError(this.chain.id, "0x0000000000000000000000000000000000000000"));
    const promise = (async () => {
      const code = await this.publicClient.getCode({ address: configured });
      if (!code || code === "0x") throw new RouterUnavailableError(this.chain.id, configured);
      const feeVault = await this.publicClient.readContract({ address: configured, abi: stealthRouterAbi, functionName: "FEE_VAULT" });
      return { router: configured, feeVault };
    })();
    this.routerInfoPromise = promise;
    promise.catch(() => {
      this.routerInfoPromise = undefined;
    });
    return promise;
  }

  /** Every router whose announcements count as router announcements on this chain. */
  private knownRouters(): Address[] {
    return [...(this.contracts.router ? [this.contracts.router] : []), ...this.contracts.previousRouters];
  }

  /** Protocol fee a send of `amount` would pay now: 1% (rounded up) through the router, `0n` in direct mode or while the router is stopped. */
  async quoteFee(amount: bigint): Promise<bigint> {
    try {
      return (await this.getRouter()) ? quoteFee(amount) : 0n;
    } catch (error) {
      if (error instanceof RouterUnavailableError) return 0n;
      throw error;
    }
  }

  /** Live usage counters from the FeeVault (native ETH). Throws `RouterUnavailableError` without a deployment. */
  async getStats(): Promise<LayerStats> {
    const { router, feeVault } = await this.routerInfo();
    const [transactions, ethTransactions, ethRouted, ethFees] = await this.publicClient.readContract({ address: feeVault, abi: feeVaultAbi, functionName: "stats" });
    return { transactions, ethTransactions, ethRouted, ethFees, feeVault, stealthRouter: router };
  }

  // ---------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------

  /** Pay a counterparty privately. Resolves the recipient, derives a fresh stealth address, encrypts the memo, pays and announces. */
  async send(params: SendParams): Promise<SendResult> {
    const signer = this.walletFor(params.from);
    const prepared = await this.prepare(params);
    const mode = params.mode ?? "auto";
    let router: Address | null = null;
    if (mode !== "direct") {
      try {
        router = await this.getRouter();
      } catch (error) {
        if (mode === "router" || !(error instanceof RouterUnavailableError)) throw error;
        router = null; // configured router missing on chain: fall back to direct mode
      }
    }
    if (mode === "router" && router === null) {
      throw new RouterUnavailableError(this.chain.id, this.contracts.router ?? "0x0000000000000000000000000000000000000000");
    }
    const fee = router ? quoteFee(prepared.amount) : 0n;
    if (router) assertStipendWithinCap(prepared.gasStipend);

    const hashes: Hash[] = [];
    let nonce = await this.publicClient.getTransactionCount({ address: signer.account.address, blockTag: "pending" });
    const wait = params.wait !== false;

    if (router) {
      if (prepared.token) {
        const approvals = await this.ensureAllowance(signer, prepared.token, router, prepared.amount + fee, nonce);
        hashes.push(...approvals);
        nonce += approvals.length;
        hashes.push(
          await signer.writeContract({
            address: router,
            abi: stealthRouterAbi,
            functionName: "sendToken",
            args: [prepared.token, prepared.stealthAddress, prepared.amount, prepared.ephemeralPublicKey, prepared.metadata],
            value: prepared.gasStipend,
            nonce,
            chain: this.chain,
            account: signer.account,
          }),
        );
      } else {
        hashes.push(
          await signer.writeContract({
            address: router,
            abi: stealthRouterAbi,
            functionName: "sendEth",
            args: [prepared.stealthAddress, prepared.amount, prepared.ephemeralPublicKey, prepared.metadata],
            value: prepared.amount + fee,
            nonce,
            chain: this.chain,
            account: signer.account,
          }),
        );
      }
    } else {
      // Direct mode is several transactions. The announcement goes out only after the transfer is
      // mined, succeeded and actually delivered, so a failed transfer is never announced.
      if (prepared.token) {
        const transfer = await signer.writeContract({
          address: prepared.token,
          abi: erc20Abi,
          functionName: "transfer",
          args: [prepared.stealthAddress, prepared.amount],
          nonce: nonce++,
          chain: this.chain,
          account: signer.account,
        });
        hashes.push(transfer);
        if (prepared.gasStipend > 0n) {
          hashes.push(
            await signer.sendTransaction({
              to: prepared.stealthAddress,
              value: prepared.gasStipend,
              nonce: nonce++,
              chain: this.chain,
              account: signer.account,
            }),
          );
        }
      } else {
        hashes.push(
          await signer.sendTransaction({
            to: prepared.stealthAddress,
            value: prepared.amount,
            nonce: nonce++,
            chain: this.chain,
            account: signer.account,
          }),
        );
      }
      await this.waitAll(hashes);
      if (prepared.token) {
        const delivered = await this.balanceOf(prepared.stealthAddress, prepared.token);
        if (delivered < prepared.amount) {
          throw new TransferNotDeliveredError(hashes[0] as Hash, `The token reported success but ${prepared.stealthAddress} holds ${delivered} of the ${prepared.amount} sent`);
        }
      }
      hashes.push(
        await signer.writeContract({
          address: this.contracts.announcer,
          abi: erc5564AnnouncerAbi,
          functionName: "announce",
          args: [SCHEME_ID, prepared.stealthAddress, prepared.ephemeralPublicKey, prepared.metadata],
          nonce,
          chain: this.chain,
          account: signer.account,
        }),
      );
    }

    if (wait) await this.waitAll(router ? hashes : hashes.slice(-1));
    const hash = hashes[hashes.length - 1] as Hash;
    return {
      hash,
      fee,
      transactionHashes: hashes,
      stealthAddress: prepared.stealthAddress,
      ephemeralPublicKey: prepared.ephemeralPublicKey,
      viewTag: prepared.viewTag,
      mode: router ? "router" : "direct",
      from: signer.account.address,
      token: prepared.token,
      amount: prepared.amount,
      gasStipend: prepared.gasStipend,
    };
  }

  /** Spend from a stealth address the agent controls to another counterparty's fresh stealth address (a private hop). */
  forward(params: SendParams & { from: StealthPayment | Hex }): Promise<SendResult> {
    return this.send(params);
  }

  /** Several payments in one atomic transaction via the StealthRouter. */
  async sendBatch(params: SendBatchParams): Promise<SendBatchResult> {
    const router = await this.getRouter();
    if (router === null) throw new RouterUnavailableError(this.chain.id, this.contracts.router ?? "0x0000000000000000000000000000000000000000");
    const signer = this.walletFor(params.from);
    const prepared: PreparedPayment[] = [];
    for (const p of params.payments) prepared.push(await this.prepare(p));
    for (const p of prepared) assertStipendWithinCap(p.gasStipend);
    const stipendTotal = prepared.reduce((sum, p) => sum + (p.token ? p.gasStipend : 0n), 0n);
    if (stipendTotal > STEALTH_ROUTER_MAX_GAS_STIPEND) {
      throw new RangeError(
        `the batch's gas stipends add up to ${stipendTotal} wei, above the router's cap of ${STEALTH_ROUTER_MAX_GAS_STIPEND} wei (0.01 ETH) per transaction. Stipends only pay the recipients' gas; send ETH as its own payment.`,
      );
    }

    const hashes: Hash[] = [];
    let nonce = await this.publicClient.getTransactionCount({ address: signer.account.address, blockTag: "pending" });

    const fees: Record<string, bigint> = {};
    const perToken = new Map<Address, bigint>();
    for (const p of prepared) {
      const fee = quoteFee(p.amount);
      fees[ethKey(p.token)] = (fees[ethKey(p.token)] ?? 0n) + fee;
      if (p.token) perToken.set(p.token, (perToken.get(p.token) ?? 0n) + p.amount + fee);
    }
    for (const [token, total] of perToken) {
      const approvals = await this.ensureAllowance(signer, token, router, total, nonce);
      hashes.push(...approvals);
      nonce += approvals.length;
    }

    const value = prepared.reduce((sum, p) => sum + (p.token ? p.gasStipend : p.amount + quoteFee(p.amount)), 0n);
    const hash = await signer.writeContract({
      address: router,
      abi: stealthRouterAbi,
      functionName: "sendBatch",
      args: [
        prepared.map((p) => ({
          stealthAddress: p.stealthAddress,
          token: p.token ?? ("0x0000000000000000000000000000000000000000" as Address),
          amount: p.amount,
          gasStipend: p.token ? p.gasStipend : 0n,
          ephemeralPubKey: p.ephemeralPublicKey,
          metadata: p.metadata,
        })),
      ],
      value,
      nonce,
      chain: this.chain,
      account: signer.account,
    });
    hashes.push(hash);
    if (params.wait !== false) await this.waitAll(hashes);

    return {
      hash,
      transactionHashes: hashes,
      from: signer.account.address,
      fees,
      payments: prepared.map((p) => ({
        stealthAddress: p.stealthAddress,
        ephemeralPublicKey: p.ephemeralPublicKey,
        viewTag: p.viewTag,
        token: p.token,
        amount: p.amount,
        fee: quoteFee(p.amount),
        gasStipend: p.gasStipend,
      })),
    };
  }

  // ---------------------------------------------------------------------------------------
  // Receiving
  // ---------------------------------------------------------------------------------------

  /** Scan announcements for payments addressed to this agent. */
  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const latest = await this.publicClient.getBlockNumber({ cacheTime: 0 });
    const toBlock = options.toBlock ?? latest;
    const fromBlock =
      options.fromBlock ?? this.scanDefaults.fromBlock ?? (toBlock > DEFAULT_SCAN_LOOKBACK ? toBlock - DEFAULT_SCAN_LOOKBACK : 0n);
    const chunkSize = options.chunkSize ?? this.scanDefaults.chunkSize;
    if (chunkSize <= 0n) throw new RangeError("scan chunkSize must be at least 1 block");
    const args = await this.announcementFilter(options.onlyRouter ?? this.scanDefaults.onlyRouter);

    // One entry per stealth address: the best-evidenced announcement is the payment, the rest only
    // raise its count (see `evidence`).
    const seen = new Map<string, StealthPayment>();
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      const end = start + chunkSize - 1n < toBlock ? start + chunkSize - 1n : toBlock;
      const logs = await this.publicClient.getContractEvents({
        address: this.contracts.announcer,
        abi: erc5564AnnouncerAbi,
        eventName: "Announcement",
        args,
        fromBlock: start,
        toBlock: end,
        strict: true,
      });
      let found = 0;
      for (const log of logs) {
        const matched = this.matchAnnouncement(log);
        if (!matched) continue;
        const key = matched.stealthAddress.toLowerCase();
        const payment = await this.verifyPayment(matched);
        const current = seen.get(key);
        if (!current) {
          seen.set(key, payment);
          found++;
          continue;
        }
        const count = current.announcements + 1;
        if (evidence(payment) > evidence(current)) seen.set(key, payment);
        (seen.get(key) as StealthPayment).announcements = count;
      }
      options.onProgress?.({ fromBlock: start, toBlock: end, found });
    }
    return { payments: [...seen.values()], fromBlock, toBlock };
  }

  /** Subscribe to new payments. Returns an unsubscribe function. */
  watch(options: WatchOptions): () => void {
    let unwatch: (() => void) | undefined;
    let stopped = false;
    const seen = new Set<string>();
    void this.announcementFilter(options.onlyRouter ?? this.scanDefaults.onlyRouter).then((args) => {
      if (stopped) return;
      unwatch = this.publicClient.watchContractEvent({
        address: this.contracts.announcer,
        abi: erc5564AnnouncerAbi,
        eventName: "Announcement",
        args,
        strict: true,
        poll: true,
        pollingInterval: options.pollingInterval ?? this.pollingInterval,
        ...(options.fromBlock !== undefined ? { fromBlock: options.fromBlock } : {}),
        onLogs: (logs) => {
          // Within a batch, the best-evidenced announcement per address is the payment; an address
          // already reported is never reported again.
          const batch = new Map<string, Unverified[]>();
          for (const log of logs) {
            const matched = this.matchAnnouncement(log);
            if (!matched) continue;
            const key = matched.stealthAddress.toLowerCase();
            if (seen.has(key)) continue;
            batch.set(key, [...(batch.get(key) ?? []), matched]);
          }
          for (const [key, group] of batch) {
            seen.add(key);
            Promise.all(group.map((m) => this.verifyPayment(m))).then(
              (verified) => {
                const best = verified.reduce((a, b) => (evidence(b) > evidence(a) ? b : a));
                best.announcements = verified.length;
                options.onPayment(best);
              },
              (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error))),
            );
          }
        },
        onError: (error) => options.onError?.(error),
      });
    }, (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error))));
    return () => {
      stopped = true;
      unwatch?.();
    };
  }

  /** A viem account that can sign from a stealth address the agent controls. */
  stealthAccount(payment: StealthPayment | Hex): LocalAccount {
    return privateKeyToAccount(typeof payment === "string" ? payment : payment.stealthPrivateKey);
  }

  /** Move funds out of a stealth address to any address (e.g. consolidation). */
  async sweep(params: SweepParams): Promise<Hash> {
    const signer = this.walletFor(params.from);
    const from = signer.account.address;
    let hash: Hash;
    if (params.token) {
      const balance = await this.balanceOf(from, params.token);
      const amount = params.amount ?? balance;
      if (amount === 0n || amount > balance) {
        throw new InsufficientBalanceError(`Stealth address ${from} holds ${balance} of ${params.token}, requested ${amount}`);
      }
      hash = await signer.writeContract({
        address: params.token,
        abi: erc20Abi,
        functionName: "transfer",
        args: [params.to, amount],
        chain: this.chain,
        account: signer.account,
      });
    } else {
      const balance = await this.publicClient.getBalance({ address: from });
      const fees = await this.publicClient.estimateFeesPerGas();
      const gas = await this.publicClient.estimateGas({ account: from, to: params.to, value: 1n });
      const gasLimit = (gas * 12n) / 10n;
      const cost = gasLimit * fees.maxFeePerGas;
      const amount = params.amount ?? balance - cost;
      if (amount <= 0n || amount + cost > balance) {
        throw new InsufficientBalanceError(`Stealth address ${from} holds ${balance} wei; cannot send ${amount} plus ${cost} gas`);
      }
      hash = await signer.sendTransaction({
        to: params.to,
        value: amount,
        gas: gasLimit,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        chain: this.chain,
        account: signer.account,
      });
    }
    if (params.wait !== false) assertTransactionSucceeded(await this.publicClient.waitForTransactionReceipt({ hash }), hash, "Sweep");
    return hash;
  }

  /** ETH (or ERC-20) balance of any address. */
  async balanceOf(address: Address, token?: Address): Promise<bigint> {
    if (!token) return this.publicClient.getBalance({ address });
    return this.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------

  private walletFor(from: StealthPayment | Hex | undefined): WalletClient<Transport, Chain, LocalAccount> {
    const account = from !== undefined ? this.stealthAccount(from) : this.account;
    if (!account) throw new NoAccountError();
    return createWalletClient({ account, chain: this.chain, transport: this.transport });
  }

  private async resolveRecipient(to: string): Promise<StealthMetaAddress> {
    if (isStealthMetaAddress(to)) {
      const parsed = parseStealthMetaAddress(to);
      const prefix = parsed.chainShortName;
      if (prefix && prefix !== this.shortName && (prefix === ROBINHOOD_CHAIN_SHORT_NAME || prefix === ROBINHOOD_TESTNET_SHORT_NAME)) {
        throw new InvalidStealthMetaAddressError(
          `Meta-address is for "${prefix}" but this agent is on ${this.chain.name} ("${this.shortName}"). Use the recipient's ${this.shortName} meta-address.`,
        );
      }
      return parsed;
    }
    if (isAddress(to)) {
      const meta = await this.resolve(to);
      if (!meta) throw new RecipientNotRegisteredError(to);
      return parseStealthMetaAddress(meta);
    }
    throw new InvalidStealthMetaAddressError(
      `Recipient must be a stealth meta-address (st:… or 0x-hex) or a registered address, got ${JSON.stringify(to)}`,
    );
  }

  private async prepare(params: SendParams | BatchPaymentParams): Promise<PreparedPayment> {
    if (params.amount <= 0n) throw new RangeError("amount must be positive");
    const recipient = await this.resolveRecipient(params.to);
    const stealth = generateStealthAddress({ ...recipient, ephemeralPrivateKey: params.ephemeralPrivateKey });
    const token = params.token ?? null;
    const memoCiphertext =
      params.memo !== undefined
        ? encryptMemo({
            sharedSecret: stealth.sharedSecret,
            stealthAddress: stealth.stealthAddress,
            binding: { chainId: this.chain.id, viewTag: stealth.viewTag, token, amount: params.amount },
            memo: params.memo,
          })
        : undefined;
    const metadata = encodeAnnouncementMetadata({ viewTag: stealth.viewTag, token, amount: params.amount, memoCiphertext });
    return {
      stealthAddress: stealth.stealthAddress,
      ephemeralPublicKey: stealth.ephemeralPublicKey,
      viewTag: stealth.viewTag,
      metadata,
      token,
      amount: params.amount,
      gasStipend: token ? (params.gasStipend ?? this.defaultGasStipend) : 0n,
    };
  }

  /**
   * Approve `spender` for `amount` when the current allowance is short. A stale non-zero allowance
   * is reset to zero first, because some tokens (USDT on Ethereum, for one) refuse to change one
   * non-zero allowance into another. Returns the approval transactions sent, in nonce order.
   */
  private async ensureAllowance(
    signer: WalletClient<Transport, Chain, LocalAccount>,
    token: Address,
    spender: Address,
    amount: bigint,
    nonce: number,
  ): Promise<Hash[]> {
    const owner = signer.account.address;
    const allowance = await this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    });
    if (allowance >= amount) return [];
    const approve = (value: bigint, n: number): Promise<Hash> =>
      signer.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, value],
        nonce: n,
        chain: this.chain,
        account: signer.account,
      });
    if (allowance === 0n) return [await approve(amount, nonce)];
    const reset = await approve(0n, nonce);
    return [reset, await approve(amount, nonce + 1)];
  }

  private async waitAll(hashes: Hash[]): Promise<void> {
    for (const hash of hashes) assertTransactionSucceeded(await this.publicClient.waitForTransactionReceipt({ hash }), hash, "Payment");
  }

  private async announcementFilter(onlyRouter: boolean): Promise<{ schemeId: bigint; caller?: Address[] }> {
    if (!onlyRouter) return { schemeId: SCHEME_ID };
    // Every router version counts, stopped or not: what it announced while running was checked on chain.
    const routers = this.knownRouters();
    if (routers.length === 0) throw new RouterUnavailableError(this.chain.id, "0x0000000000000000000000000000000000000000");
    return { schemeId: SCHEME_ID, caller: routers };
  }

  /**
   * Attach the on-chain balance and decide whether the announced figures were really delivered.
   * A router announcement was checked on chain by the router. A direct announcement is only the
   * announcer's word: ETH can be checked against the chain's own balance, a listed token against
   * its balance, and any other token not at all.
   */
  private async verifyPayment(payment: Unverified): Promise<StealthPayment> {
    // Anyone can announce any token address; one that is not a working ERC-20 must not stop the scan.
    let balance = 0n;
    let balanceError: string | undefined;
    try {
      balance = await this.balanceOf(payment.stealthAddress, payment.token ?? undefined);
    } catch (error) {
      balanceError = `Could not read the balance of the announced token: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
    }
    const viaRouter = this.knownRouters().some((router) => isAddressEqual(payment.caller, router));
    const covered = payment.amount === undefined ? balance > 0n : balance >= payment.amount;
    let verified: boolean;
    if (balanceError !== undefined) verified = false;
    else if (payment.token === null) verified = viaRouter || covered;
    else if (payment.token !== undefined && this.trustedTokens.has(payment.token.toLowerCase())) verified = viaRouter || covered;
    else verified = false;
    return hideSecret({ ...payment, balance, balanceError, verified, viaRouter, announcements: 1 });
  }

  /** Decide whether an announcement is ours and, if so, derive everything needed to spend it. */
  private matchAnnouncement(log: AnnouncementLog): Unverified | null {
    const { stealthAddress, ephemeralPubKey, metadata, caller, schemeId } = log.args;
    if (!stealthAddress || !ephemeralPubKey || !metadata || !caller) return null;
    if (schemeId !== undefined && schemeId !== SCHEME_ID) return null;
    if (log.transactionHash === null || log.blockNumber === null || log.logIndex === null) return null;

    let decoded;
    try {
      decoded = decodeAnnouncementMetadata(metadata);
    } catch {
      return null;
    }

    const check = checkStealthAddress({
      stealthAddress,
      ephemeralPublicKey: ephemeralPubKey,
      viewingPrivateKey: this.keys.viewingPrivateKey,
      spendingPublicKey: this.keys.spendingPublicKey,
      viewTag: decoded.viewTag,
    });
    if (!check.matches || !check.sharedSecret || !check.hashedSharedSecret) return null;

    const stealthPrivateKey = computeStealthKey({
      ephemeralPublicKey: ephemeralPubKey,
      viewingPrivateKey: this.keys.viewingPrivateKey,
      spendingPrivateKey: this.keys.spendingPrivateKey,
      hashedSharedSecret: check.hashedSharedSecret,
    });

    let memo: StealthPayment["memo"];
    let memoError: string | undefined;
    if (!decoded.memoCiphertext && isLegacyMemoCiphertext(decoded.extension)) {
      memoError = "Memo uses the retired v2 format, which is not bound to the announced figures; it is not decrypted";
    } else if (decoded.memoCiphertext) {
      if (decoded.token === undefined || decoded.amount === undefined) {
        memoError = "Memo is not bound to standard metadata; JOMO never writes one without it";
      } else {
        try {
          memo = decryptMemo({
            sharedSecret: check.sharedSecret,
            stealthAddress,
            binding: { chainId: this.chain.id, viewTag: decoded.viewTag, token: decoded.token, amount: decoded.amount },
            ciphertext: decoded.memoCiphertext,
          });
        } catch (error) {
          memoError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    return {
      stealthAddress,
      stealthPrivateKey,
      ephemeralPublicKey: ephemeralPubKey,
      viewTag: decoded.viewTag,
      token: decoded.token,
      amount: decoded.amount,
      memo,
      memoError,
      caller,
      transactionHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      metadata,
    };
  }
}

/** Create a `PrivateAgent`. */
export function createPrivateAgent(config: PrivateAgentConfig): PrivateAgent {
  return new PrivateAgent(config);
}

export { toBytes, toHex };
