/**
 * Tool handlers. Each maps onto one SDK method and returns JSON-safe data. Private keys are never
 * included in any result; state-changing tools go through two-phase confirmation.
 */
import { DEFAULT_SCAN_LOOKBACK, RouterUnavailableError, STEALTH_ROUTER_MAX_GAS_STIPEND, isStealthMetaAddress, type SendParams, type StealthPayment } from "@usejomo/sdk";
import { formatUnits, getAddress, isAddress, type Address, type Hex } from "viem";
import type { z } from "zod";
import { AmountFormatError, formatAmount, parseNativeAmount, parseTokenAmount, type AmountInput } from "./amounts.js";
import { ConfirmationRequiredError, scopeOf } from "./confirm.js";
import type { JomoContext } from "./context.js";
import type { StoredPayment } from "./keystore.js";
import type { Outflow, PolicyRequest } from "./policy.js";
import { MEMO_NOTE, MEMO_PREVIEW_CHARS, PRIVACY_SCOPE, SCOPE_NOTE, TOOL_SPECS, type ToolKey } from "./spec.js";

type Args<K extends ToolKey> = z.infer<z.ZodObject<(typeof TOOL_SPECS)[K]["shape"]>>;

export class ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** The default widest window one scan covers (JOMO_SCAN_WINDOW). A longer gap is caught up over several scans (`more: true`). */
export const MAX_SCAN_BLOCKS = 250_000n;

/** How a call was approved, passed by the server: "user" (elicitation), "autonomous", or "token". */
export interface CallMeta {
  approvedBy: string;
}

/** Memo text in a summary: what the user is about to send, quoted and capped. */
function memoForSummary(memo: unknown): string {
  if (memo === undefined) return "Memo: none.";
  const text = typeof memo === "string" ? memo : JSON.stringify(memo);
  const shown = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  return `Memo (encrypted; only the recipient can read it): ${JSON.stringify(shown)}`;
}

/** Recursively stringify bigints so results are JSON-safe. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

interface PreparedPayment {
  to: string;
  toLabel: string;
  amount: bigint;
  amountText: string;
  token: Address | null;
  memo: SendParams["memo"];
  gasStipend: bigint | undefined;
  /** Protocol fee on top (0 in direct mode). */
  fee: bigint;
}

/** The agent's funds a payment spends: amount + fee in its asset, and any ETH gas stipend. */
function outflowsOf(p: PreparedPayment): Outflow[] {
  const out: Outflow[] = [{ asset: p.token ? p.token.toLowerCase() : "ETH", amount: p.amount + p.fee, recipient: p.to }];
  if (p.gasStipend) out.push({ asset: "ETH", amount: p.gasStipend, recipient: p.to });
  return out;
}

export function createHandlers(ctx: JomoContext) {
  const { agent, keystore, confirmations } = ctx;

  const format = async (value: bigint, token: Address | null | undefined): Promise<string> => {
    if (!token) return formatAmount(value, 18, "ETH");
    try {
      const info = await ctx.tokenInfo(token);
      return formatAmount(value, info.decimals, info.symbol);
    } catch {
      // An announced "token" can be any address, including one with no contract.
      return `${value} base units of unrecognised token ${token}`;
    }
  };

  const resolveRecipient = async (to: string): Promise<{ to: string; label: string }> => {
    // Summaries carry the whole recipient: a shortened one hides substitutions.
    if (isStealthMetaAddress(to)) return { to, label: `stealth meta-address ${to}` };
    if (isAddress(to)) {
      const meta = await agent.resolve(getAddress(to));
      if (!meta) throw new ToolError("RECIPIENT_NOT_REGISTERED", `${to} has not registered a stealth meta-address. Ask them to run jomo_register, or pass their st:… meta-address.`);
      return { to: getAddress(to), label: `${getAddress(to)} (registered, meta-address ${meta})` };
    }
    throw new ToolError("INVALID_RECIPIENT", "Recipient must be an identity address (0x…) or a stealth meta-address (st:…).");
  };

  const preparePayment = async (p: { to: string; amount: AmountInput; token?: string | undefined; memo?: unknown; gasStipend?: string | undefined }): Promise<PreparedPayment> => {
    const { to, label } = await resolveRecipient(p.to);
    const token = p.token ? getAddress(p.token) : null;
    const parsed = token ? parseTokenAmount(p.amount, await ctx.tokenInfo(token)) : parseNativeAmount(p.amount);
    const gasStipend = p.gasStipend ? parseNativeAmount(p.gasStipend).value : undefined;
    if (gasStipend !== undefined && !token) throw new ToolError("GAS_STIPEND_NOT_APPLICABLE", "gasStipend only applies to token payments; ETH payments carry their own gas.");
    if (gasStipend !== undefined && gasStipend > STEALTH_ROUTER_MAX_GAS_STIPEND) {
      throw new ToolError("GAS_STIPEND_TOO_LARGE", "gasStipend is capped at 0.01 ETH: it only pays the recipient's gas. Send ETH as its own payment.");
    }
    // The symbol comes from the token contract; the address is what identifies the token.
    const amountText = formatAmount(parsed.value, parsed.decimals, parsed.unit) + (token ? ` (token ${token})` : "");
    return {
      to,
      toLabel: label,
      amount: parsed.value,
      amountText,
      token,
      memo: p.memo as SendParams["memo"],
      gasStipend,
      fee: await agent.quoteFee(parsed.value),
    };
  };

  const feeLine = async (amount: bigint, token: Address | null): Promise<string> => {
    let router: Address | null = null;
    try {
      router = await agent.getRouter();
    } catch (error) {
      if (!(error instanceof RouterUnavailableError)) throw error;
      return "Fee: none (the router is unavailable or stopped by its vault; direct mode, 2–3 transactions, announcement is not atomic).";
    }
    if (!router) return "Fee: none (router not deployed on this chain; direct mode, 2–3 transactions, announcement is not atomic).";
    const fee = await agent.quoteFee(amount);
    return `Fee: ${await format(fee, token)} (1% on top, router mode, atomic).`;
  };

  /**
   * Every state-changing tool runs in two steps: prepare (summary, payload and what it would spend)
   * and execute. A token is bound to the tool and the exact arguments it was issued for. Every
   * execution is recorded against the daily limits and in the audit log, however it was approved.
   */
  const twoPhase = async <T>(
    tool: string,
    args: Record<string, unknown>,
    meta: CallMeta | undefined,
    prepare: () => Promise<{ summary: string; payload: T; request: PolicyRequest }>,
    execute: (payload: T) => Promise<unknown>,
  ): Promise<unknown> => {
    const scope = scopeOf(tool, args);
    const token = args["confirmationToken"];
    if (typeof token === "string" && token) {
      const stored = confirmations.consume<{ payload: T; request: PolicyRequest; summary: string }>(token, scope);
      const result = await execute(stored.payload);
      ctx.recordExecution({ tool, summary: stored.summary, request: stored.request, approvedBy: meta?.approvedBy ?? "token", result });
      return result;
    }
    const { summary, payload, request } = await prepare();
    throw new ConfirmationRequiredError(confirmations.prepare(summary, { payload, request, summary }, scope), summary, request);
  };

  /** Memo text is sender-controlled: quote it, cap it, and label it so the model treats it as data. */
  const memoPreview = (memo: StoredPayment["memo"]): Record<string, unknown> | undefined => {
    if (!memo) return undefined;
    if (memo.kind === "bytes") return { untrusted: true, kind: "bytes" };
    let text = memo.kind === "json" ? JSON.stringify(memo.value) : String(memo.value);
    const truncated = text.length > MEMO_PREVIEW_CHARS;
    if (truncated) text = `${text.slice(0, MEMO_PREVIEW_CHARS)}…`;
    return { untrusted: true, kind: memo.kind, text: JSON.stringify(text), truncated };
  };

  const stripped = async (p: StoredPayment | StealthPayment): Promise<Record<string, unknown>> => {
    const token = p.token ?? null;
    const balance = "balance" in p && p.balance !== undefined ? BigInt(p.balance) : await agent.balanceOf(p.stealthAddress, token ?? undefined);
    const announced = p.amount === undefined ? undefined : BigInt(p.amount);
    return {
      stealthAddress: p.stealthAddress,
      token,
      announcedAmount: announced === undefined ? undefined : await format(announced, token),
      balance: await format(balance, token),
      verified: "verified" in p && p.verified !== undefined ? p.verified : announced === undefined ? balance > 0n : balance >= announced,
      announcements: "announcements" in p ? (p.announcements ?? 1) : 1,
      memo: memoPreview(p.memo),
      transactionHash: p.transactionHash,
      blockNumber: String(p.blockNumber),
      spent: "spent" in p ? p.spent : false,
    };
  };

  const storedPayment = (address: string): StoredPayment => {
    const key = getAddress(address).toLowerCase();
    const entry = Object.values(keystore.state.payments).find((p) => p.stealthAddress.toLowerCase() === key);
    if (!entry) throw new ToolError("UNKNOWN_STEALTH_ADDRESS", `${address} is not a stealth address this agent has detected. Run jomo_scan first.`);
    return entry;
  };

  const chainName = agent.chain.name;
  const identity = agent.address as Address;

  return {
    async register(args: Args<"register">, meta?: CallMeta) {
      return twoPhase(
        "register",
        args,
        meta,
        async () => ({
          summary:
            `Publish stealth meta-address ${agent.stealthMetaAddress} for identity ${identity} on ${chainName} (one transaction).` +
            (ctx.registrationWarning ? `\nThis replaces a different meta-address registered for this identity: ${ctx.registrationWarning}` : ""),
          payload: null,
          request: { tool: "register", outflows: [] },
        }),
        async () => {
          const result = { hash: await agent.register(), metaAddress: agent.stealthMetaAddress, identity };
          ctx.registrationWarning = null;
          return result;
        },
      );
    },

    async resolve(args: Args<"resolve">) {
      const meta = await agent.resolve(getAddress(args.address));
      return { address: getAddress(args.address), metaAddress: meta };
    },

    async send(args: Args<"send">, meta?: CallMeta) {
      return twoPhase(
        "send",
        args,
        meta,
        async () => {
          const p = await preparePayment(args);
          const stipend = p.gasStipend ? ` + ${formatAmount(p.gasStipend, 18, "ETH")} gas stipend` : "";
          return {
            summary: [`Send ${p.amountText}${stipend} privately to ${p.toLabel} from identity ${identity} on ${chainName}.`, await feeLine(p.amount, p.token), memoForSummary(p.memo), `Public on chain: amount, token, your sender wallet. Not linkable: the recipient.`].join("\n"),
            payload: p,
            request: { tool: "send", outflows: outflowsOf(p) },
          };
        },
        async (p) => {
          const r = await agent.send({ to: p.to, amount: p.amount, token: p.token ?? undefined, memo: p.memo, gasStipend: p.gasStipend });
          return {
            stealthAddress: r.stealthAddress,
            hash: r.hash,
            transactionHashes: r.transactionHashes,
            mode: r.mode,
            amount: await format(r.amount, r.token),
            fee: await format(r.fee, r.token),
            note: SCOPE_NOTE,
          };
        },
      );
    },

    async send_batch(args: Args<"send_batch">, meta?: CallMeta) {
      return twoPhase(
        "send_batch",
        args,
        meta,
        async () => {
          if (!(await agent.getRouter())) throw new ToolError("ROUTER_UNAVAILABLE", "Batch sends need the StealthRouter, which is not deployed on this chain. Send payments one by one.");
          const prepared = [];
          for (const p of args.payments) prepared.push(await preparePayment(p));
          const stipendTotal = prepared.reduce((sum, p) => sum + (p.token && p.gasStipend ? p.gasStipend : 0n), 0n);
          if (stipendTotal > STEALTH_ROUTER_MAX_GAS_STIPEND) {
            throw new ToolError("GAS_STIPEND_TOO_LARGE", "The gas stipends of a batch are capped at 0.01 ETH together: they only pay the recipients' gas. Send ETH as its own payment.");
          }
          const lines = prepared.map((p) => `  • ${p.amountText} → ${p.toLabel}${p.memo !== undefined ? `; ${memoForSummary(p.memo)}` : ""}`);
          return {
            summary: [`Send ${prepared.length} private payments in one atomic transaction from identity ${identity} on ${chainName}:`, ...lines, "Fee: 1% on top of each payment, same asset."].join("\n"),
            payload: prepared,
            request: { tool: "send_batch", outflows: prepared.flatMap(outflowsOf) },
          };
        },
        async (prepared) => {
          const r = await agent.sendBatch({ payments: prepared.map((p) => ({ to: p.to, amount: p.amount, token: p.token ?? undefined, memo: p.memo, gasStipend: p.gasStipend })) });
          return { hash: r.hash, transactionHashes: r.transactionHashes, payments: r.payments.map((p) => ({ stealthAddress: p.stealthAddress, token: p.token, amount: p.amount.toString() })), note: SCOPE_NOTE };
        },
      );
    },

    async scan(args: Args<"scan">) {
      // Only a plain incremental scan (no fromBlock, no toBlock) moves the stored cursor; any explicit
      // range is a look and leaves it alone, so no argument can make the receive path skip blocks.
      // The window never passes the chain head and covers at most MAX_SCAN_BLOCKS: a longer gap is
      // caught up by moving the END of the window, over several scans, never by skipping its start.
      const head = await agent.publicClient.getBlockNumber({ cacheTime: 0 });
      const explicit = args.fromBlock !== undefined || args.toBlock !== undefined;
      const cursor = keystore.state.cursor ? BigInt(keystore.state.cursor) : undefined;
      const fromBlock =
        args.fromBlock !== undefined ? BigInt(args.fromBlock) : (cursor ?? ctx.scanFromBlock ?? (head > DEFAULT_SCAN_LOOKBACK ? head - DEFAULT_SCAN_LOOKBACK : 0n));
      let toBlock = args.toBlock !== undefined && BigInt(args.toBlock) < head ? BigInt(args.toBlock) : head;
      const warning = ctx.registrationWarning ?? undefined;
      if (fromBlock > toBlock) {
        if (explicit) throw new ToolError("SCAN_RANGE", `fromBlock ${fromBlock} is past toBlock ${toBlock} (chain head ${head}).`);
        return { payments: [], scanned: { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), head: head.toString() }, more: false, nextCursor: keystore.state.cursor, known: Object.keys(keystore.state.payments).length, warning, note: `Nothing new since the last scan. ${MEMO_NOTE}` };
      }
      let more = false;
      if (toBlock - fromBlock + 1n > ctx.scanWindow) {
        toBlock = fromBlock + ctx.scanWindow - 1n;
        more = true;
      }
      const result = await agent.scan({ fromBlock, toBlock });
      for (const p of result.payments) {
        const key = p.stealthAddress.toLowerCase();
        const existing = keystore.state.payments[key];
        if (existing) {
          // Never overwrite a known payment: a later announcement for the same address is at best a
          // duplicate and at worst a spoof. Keep the stored record and verdict, refresh the balance,
          // count the repeats.
          existing.announcements = (existing.announcements ?? 1) + p.announcements;
          existing.balance = p.balance.toString();
          continue;
        }
        keystore.state.payments[key] = {
          stealthAddress: p.stealthAddress,
          stealthPrivateKey: p.stealthPrivateKey,
          ephemeralPublicKey: p.ephemeralPublicKey,
          token: p.token,
          amount: p.amount === undefined ? undefined : p.amount.toString(),
          memo: p.memo,
          transactionHash: p.transactionHash,
          blockNumber: p.blockNumber.toString(),
          spent: false,
          balance: p.balance.toString(),
          verified: p.verified,
          announcements: p.announcements,
        };
      }
      if (!explicit) keystore.state.cursor = (toBlock + 1n).toString();
      keystore.save();
      // Report one entry per stealth address (from the keystore), not one per announcement.
      const seen = new Set<string>();
      const fresh = result.payments.filter((p) => {
        const key = p.stealthAddress.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return {
        payments: await Promise.all(fresh.map((p) => stripped(keystore.state.payments[p.stealthAddress.toLowerCase()] ?? p))),
        scanned: { fromBlock: result.fromBlock.toString(), toBlock: result.toBlock.toString(), head: head.toString() },
        more,
        nextCursor: keystore.state.cursor,
        known: Object.keys(keystore.state.payments).length,
        warning,
        note: `announcedAmount is sender-supplied; balance is on chain and authoritative. ${MEMO_NOTE}`,
      };
    },

    async forward(args: Args<"forward">, meta?: CallMeta) {
      return twoPhase(
        "forward",
        args,
        meta,
        async () => {
          const from = storedPayment(args.fromStealthAddress);
          const p = await preparePayment({ to: args.to, amount: args.amount, token: from.token ?? undefined, memo: args.memo });
          return {
            summary: [`Forward ${p.amountText} from stealth address ${from.stealthAddress} to ${p.toLabel} on ${chainName}. Your identity wallet does not sign.`, await feeLine(p.amount, p.token), memoForSummary(p.memo)].join("\n"),
            payload: { from, p },
            request: { tool: "forward", outflows: outflowsOf(p) },
          };
        },
        async ({ from, p }) => {
          const r = await agent.send({ from: from.stealthPrivateKey as Hex, to: p.to, amount: p.amount, token: p.token ?? undefined, memo: p.memo });
          return { from: from.stealthAddress, stealthAddress: r.stealthAddress, hash: r.hash, transactionHashes: r.transactionHashes, mode: r.mode, amount: await format(r.amount, r.token), fee: await format(r.fee, r.token), note: "Signed by the stealth address; the identity wallet is not on chain for this hop. Amount and token are public." };
        },
      );
    },

    async sweep(args: Args<"sweep">, meta?: CallMeta) {
      return twoPhase(
        "sweep",
        args,
        meta,
        async () => {
          const from = storedPayment(args.fromStealthAddress);
          const token = args.token ? getAddress(args.token) : undefined;
          const to = getAddress(args.to);
          const balance = await agent.balanceOf(from.stealthAddress, token);
          if (balance === 0n) throw new ToolError("INSUFFICIENT_BALANCE", `${from.stealthAddress} holds no ${token ? "tokens" : "ETH"} to sweep.`);
          // The amount the user approves is the amount that moves. For ETH that is the balance
          // less the gas the transfer itself will cost, estimated now; if the balance or the gas
          // price changes before execution, the SDK refuses rather than sending something else.
          let amount = balance;
          if (!token) {
            const fees = await agent.publicClient.estimateFeesPerGas();
            const gas = await agent.publicClient.estimateGas({ account: from.stealthAddress, to, value: 1n });
            // Twice the current cost is held back, so an ordinary gas rise before execution still fits.
            const cost = ((gas * 12n) / 10n) * fees.maxFeePerGas * 2n;
            amount = balance - cost;
            if (amount <= 0n) throw new ToolError("INSUFFICIENT_BALANCE", `${from.stealthAddress} holds ${formatAmount(balance, 18, "ETH")}, less than the gas a transfer costs.`);
          }
          return {
            summary: `Sweep exactly ${await format(amount, token ?? null)}${token ? ` (token ${token})` : ""} from stealth address ${from.stealthAddress} to ${to} on ${chainName}. This links the two addresses on chain. Exactly this amount moves; if the balance drops or gas rises sharply before execution, the sweep fails instead.`,
            payload: { from, token, to, amount },
            request: { tool: "sweep", outflows: [], sweepTo: to },
          };
        },
        async ({ from, token, to, amount }) => {
          const hash = await agent.sweep({ from: from.stealthPrivateKey as Hex, to, token, amount });
          from.spent = true;
          keystore.save();
          return { hash, from: from.stealthAddress, to, amount: await format(amount, token ?? null) };
        },
      );
    },

    async balance(args: Args<"balance">) {
      const token = args.token ? getAddress(args.token) : undefined;
      const stealth = await Promise.all(
        Object.values(keystore.state.payments).map(async (p) => ({ stealthAddress: p.stealthAddress, balance: await format(await agent.balanceOf(p.stealthAddress, token), token ?? null), spent: p.spent })),
      );
      return { identity: { address: identity, balance: await format(await agent.balanceOf(identity, token), token ?? null) }, stealth, warning: ctx.registrationWarning ?? undefined };
    },

    async privacy_scope() {
      return PRIVACY_SCOPE;
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;

/**
 * Error text goes to the model. viem errors carry the RPC URL, and hosted RPC URLs often carry an
 * API key in the path or query; strip every URL down to its origin before it leaves the server.
 */
export function redactUrls(text: string): string {
  return text.replace(/\b(https?|wss?):\/\/[^\s"'<>)]+/gi, (url) => {
    try {
      return `${new URL(url).origin}/…`;
    } catch {
      return "[url]";
    }
  });
}

/** Normalise any thrown value into a JSON error with a stable code. */
export function toErrorResult(error: unknown): { code: string; message: string; confirmationToken?: string; summary?: string } {
  if (error instanceof ConfirmationRequiredError) return { code: error.code, message: error.message, confirmationToken: error.token, summary: error.summary };
  if (error instanceof ToolError || error instanceof AmountFormatError) return { code: error.code, message: redactUrls(error.message) };
  if (error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return { code: (error as { code: string }).code, message: redactUrls((error as unknown as Error).message) };
  }
  return { code: "INTERNAL", message: redactUrls(error instanceof Error ? error.message : String(error)) };
}

export { formatUnits };
