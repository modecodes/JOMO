/**
 * Autonomous mode: the server approves state-changing calls itself, within limits the operator set.
 *
 * There is no person in the loop for an autonomous agent, so the rules the model cannot change live
 * here: a cap per payment and per rolling 24 hours for each asset the agent may spend (native ETH or
 * a listed token; a token with no limit cannot be spent autonomously at all), an optional list of
 * recipients, and the addresses sweeps may go to. Anything outside the limits is asked of a human if
 * the client can ask, and refused otherwise. Only the operator sets limits (environment), never a tool.
 */
import { formatUnits } from "viem";

/** One outflow of the agent's funds that a call would make. `asset` is "ETH" or a lowercase token address. */
export interface Outflow {
  asset: string;
  amount: bigint;
  recipient?: string | undefined;
}

export interface PolicyRequest {
  tool: string;
  outflows: Outflow[];
  /** For sweeps: where the funds go. */
  sweepTo?: string | undefined;
}

export interface AssetLimit {
  perTx: bigint;
  perDay: bigint;
  decimals: number;
  symbol: string;
}

export interface AutonomyPolicy {
  /** Keyed by "ETH" or a lowercase token address. */
  limits: Map<string, AssetLimit>;
  /** Lowercase addresses or meta-addresses; `null` = any recipient. */
  allowedRecipients: Set<string> | null;
  /** Lowercase addresses sweeps may go to (the identity is always included). */
  sweepTo: Set<string>;
}

/** What the agent spent, persisted in the keystore so a restart does not reset the day. */
export interface SpendEntry {
  t: number;
  asset: string;
  amount: string;
}

export const DAY_MS = 86_400_000;

function show(limit: AssetLimit, value: bigint): string {
  return `${formatUnits(value, limit.decimals)} ${limit.symbol}`;
}

/** Whether the policy lets this call run without a person approving it. */
export function evaluate(policy: AutonomyPolicy, request: PolicyRequest, ledger: readonly SpendEntry[], now: number): { ok: true } | { ok: false; reason: string } {
  if (request.sweepTo !== undefined && !policy.sweepTo.has(request.sweepTo.toLowerCase())) {
    return { ok: false, reason: `Sweeps may only go to the identity or an address in JOMO_SWEEP_TO; ${request.sweepTo} is not one of them.` };
  }
  const totals = new Map<string, bigint>();
  for (const out of request.outflows) {
    const limit = policy.limits.get(out.asset);
    if (!limit) return { ok: false, reason: `No autonomous limit is set for ${out.asset === "ETH" ? "ETH" : `token ${out.asset}`}, so it cannot be spent without a person approving.` };
    if (out.amount > limit.perTx) return { ok: false, reason: `${show(limit, out.amount)} is over the per-payment limit of ${show(limit, limit.perTx)}.` };
    if (policy.allowedRecipients && out.recipient !== undefined && !policy.allowedRecipients.has(out.recipient.toLowerCase())) {
      return { ok: false, reason: `${out.recipient} is not in JOMO_ALLOWED_RECIPIENTS.` };
    }
    totals.set(out.asset, (totals.get(out.asset) ?? 0n) + out.amount);
  }
  for (const [asset, amount] of totals) {
    const limit = policy.limits.get(asset) as AssetLimit;
    const spent = ledger.filter((e) => e.asset === asset && now - e.t < DAY_MS).reduce((sum, e) => sum + BigInt(e.amount), 0n);
    if (spent + amount > limit.perDay) {
      return { ok: false, reason: `This would bring the last 24 hours to ${show(limit, spent + amount)}, over the daily limit of ${show(limit, limit.perDay)} (${show(limit, spent)} already spent).` };
    }
  }
  return { ok: true };
}

/** The ledger after a call executed: its outflows added, entries older than a day dropped. */
export function record(ledger: readonly SpendEntry[], request: PolicyRequest, now: number): SpendEntry[] {
  return [...ledger.filter((e) => now - e.t < DAY_MS), ...request.outflows.filter((o) => o.amount > 0n).map((o) => ({ t: now, asset: o.asset, amount: o.amount.toString() }))];
}
