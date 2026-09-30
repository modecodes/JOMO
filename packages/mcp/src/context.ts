import { DEFAULT_SCAN_LOOKBACK, type PrivateAgent } from "@jomo/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { erc20Abi, formatUnits, getAddress, isAddress, parseUnits, type Address } from "viem";
import { Confirmations } from "./confirm.js";
import { buildAgent, type JomoServerConfig } from "./config.js";
import type { Keystore } from "./keystore.js";
import type { TokenInfo } from "./amounts.js";
import { record, type AssetLimit, type AutonomyPolicy, type PolicyRequest } from "./policy.js";

/**
 * How state-changing calls are approved.
 * - "elicit": the user approves each call in the client; clients that cannot ask are refused.
 * - "token":  the model relays a summary and a one-time token; for hosts that prompt per call.
 * - "auto":   the server approves calls within the operator's limits; beyond them it asks the user
 *             if the client can ask, and refuses otherwise. For autonomous agents.
 */
export type ConfirmPolicy = "elicit" | "token" | "auto";

export interface Execution {
  tool: string;
  summary: string;
  request: PolicyRequest;
  approvedBy: string;
  result: unknown;
}

/** Shared state behind every server instance: one agent, one keystore, one confirmation registry. */
export interface JomoContext {
  agent: PrivateAgent;
  keystore: Keystore;
  confirmations: Confirmations;
  confirm: ConfirmPolicy;
  autonomy: AutonomyPolicy | null;
  /** First block to scan when the keystore has no cursor. */
  scanFromBlock: bigint | undefined;
  /** Most blocks one scan covers. */
  scanWindow: bigint;
  /** Set when the registry holds a different meta-address for this identity than these keys give. */
  registrationWarning: string | null;
  tokenInfo: (token: Address) => Promise<TokenInfo>;
  /** Every executed state-changing call: recorded against the daily limits and in the audit log. */
  recordExecution: (e: Execution) => void;
  audit: (entry: Record<string, unknown>) => void;
}

/** A token's symbol is written by the token contract: keep it printable and short before it enters a summary. */
export function sanitiseSymbol(symbol: unknown): string {
  const clean = String(symbol ?? "").replace(/[^A-Za-z0-9.$_-]/g, "").slice(0, 12);
  return clean || "TOKEN";
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
}

export async function createContext(config: JomoServerConfig): Promise<JomoContext> {
  const agent = await buildAgent(config);
  const cache = new Map<string, TokenInfo>();
  const tokenInfo = async (token: Address): Promise<TokenInfo> => {
    const key = token.toLowerCase();
    const hit = cache.get(key);
    if (hit) return hit;
    const [symbol, decimals] = await Promise.all([
      agent.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
      agent.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    ]);
    const info = { symbol: sanitiseSymbol(symbol), decimals };
    cache.set(key, info);
    return info;
  };

  const confirm = config.confirm ?? "elicit";
  let autonomy: AutonomyPolicy | null = null;
  if (config.autonomy) {
    const limits = new Map<string, AssetLimit>();
    for (const l of config.autonomy.limits) {
      const info = l.asset === "ETH" ? { symbol: "ETH", decimals: 18 } : await tokenInfo(getAddress(l.asset));
      const perTx = parseUnits(l.perTx, info.decimals);
      const perDay = parseUnits(l.perDay, info.decimals);
      if (perTx <= 0n || perDay <= 0n || perTx > perDay) throw new Error(`Autonomous limit for ${info.symbol}: per payment (${l.perTx}) must be positive and not above the daily limit (${l.perDay})`);
      limits.set(l.asset === "ETH" ? "ETH" : l.asset.toLowerCase(), { perTx, perDay, decimals: info.decimals, symbol: info.symbol });
    }
    const allowedRecipients = config.autonomy.allowedRecipients ? new Set(config.autonomy.allowedRecipients.map((r) => (isAddress(r) ? getAddress(r) : r).toLowerCase())) : null;
    const sweepTo = new Set([...(config.autonomy.sweepTo ?? []), agent.address as string].map((a) => getAddress(a).toLowerCase()));
    autonomy = { limits, allowedRecipients, sweepTo };
  }
  if (confirm === "auto" && (!autonomy || autonomy.limits.size === 0)) {
    throw new Error("JOMO_CONFIRM=auto needs spending limits: set JOMO_LIMIT_ETH_PER_TX and JOMO_LIMIT_ETH_PER_DAY (and JOMO_LIMIT_TOKENS for tokens).");
  }

  // An identity whose registered meta-address differs from the one these keys derive cannot see the
  // payments senders make to the registered one. Say so loudly instead of scanning in silence.
  let registrationWarning: string | null = null;
  try {
    const registered = await agent.resolve(agent.address as Address);
    if (registered && registered.toLowerCase() !== agent.stealthMetaAddress.toLowerCase()) {
      registrationWarning =
        `The registry holds ${registered} for identity ${agent.address}, but this server's keys give ${agent.stealthMetaAddress}. ` +
        "Payments sent to the registered meta-address cannot be detected with these keys; recover them with the keys that produced it, then run jomo_register to publish the current one.";
    }
  } catch {
    /* registry unreachable: checked again on the next start */
  }

  const auditPath = config.auditLog;
  const audit = (entry: Record<string, unknown>): void => {
    if (!auditPath) return;
    mkdirSync(dirname(auditPath), { recursive: true, mode: 0o700 });
    appendFileSync(auditPath, `${JSON.stringify(jsonSafe({ time: new Date().toISOString(), ...entry }))}\n`, { mode: 0o600 });
  };
  const keystore = config.keystore;
  const recordExecution = (e: Execution): void => {
    keystore.state.spendLog = record(keystore.state.spendLog ?? [], e.request, Date.now());
    keystore.save();
    audit({
      event: "executed",
      tool: e.tool,
      approvedBy: e.approvedBy,
      summary: e.summary,
      outflows: e.request.outflows.map((o) => ({ asset: o.asset, amount: o.asset === "ETH" ? `${formatUnits(o.amount, 18)} ETH` : o.amount.toString(), recipient: o.recipient })),
      result: e.result,
    });
  };

  return {
    agent,
    keystore,
    confirmations: new Confirmations(),
    confirm,
    autonomy,
    scanFromBlock: config.scanFromBlock,
    scanWindow: config.scanWindow !== undefined && config.scanWindow > 0n ? config.scanWindow : 250_000n,
    registrationWarning,
    tokenInfo,
    recordExecution,
    audit,
  };
}

export { DEFAULT_SCAN_LOOKBACK };
