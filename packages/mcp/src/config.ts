import { robinhood, robinhoodTestnet, StealthKeys, createPrivateAgent, type PrivateAgent } from "@jomo/sdk";
import { spawnSync } from "node:child_process";
import { http, type Address, type Chain, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ConfirmPolicy } from "./context.js";
import { FileKeystore, MemoryKeystore, type Keystore } from "./keystore.js";

export interface JomoServerConfig {
  chain: Chain;
  transport?: Transport | undefined;
  keystore: Keystore;
  /** First block to scan when the keystore has no cursor yet. */
  scanFromBlock?: bigint | undefined;
  /** Most blocks one scan covers (default 250 000); a longer gap is caught up over several scans. */
  scanWindow?: bigint | undefined;
  contracts?: { announcer?: Address; registry?: Address; router?: Address | null } | undefined;
  /** ETH forwarded with ERC-20 payments so the recipient can pay gas. */
  defaultGasStipend?: bigint | undefined;
  /** Approval policy. Default "elicit": ask the user, refuse clients that cannot ask. */
  confirm?: ConfirmPolicy | undefined;
  /** Limits for `confirm: "auto"`. Amounts are decimal strings in the asset's own units. */
  autonomy?: AutonomyConfig | undefined;
  /** Append-only log of every state-changing action and refusal (no secrets). */
  auditLog?: string | undefined;
}

export interface AutonomyConfig {
  limits: { asset: "ETH" | Address; perTx: string; perDay: string }[];
  allowedRecipients?: string[] | undefined;
  sweepTo?: string[] | undefined;
}

export const ENV = {
  chain: "JOMO_CHAIN",
  rpcUrl: "JOMO_RPC_URL",
  keystore: "JOMO_KEYSTORE",
  passphrase: "JOMO_KEYSTORE_PASSPHRASE",
  passphraseCommand: "JOMO_KEYSTORE_PASSPHRASE_CMD",
  confirm: "JOMO_CONFIRM",
  httpToken: "JOMO_HTTP_TOKEN",
  limitEthPerTx: "JOMO_LIMIT_ETH_PER_TX",
  limitEthPerDay: "JOMO_LIMIT_ETH_PER_DAY",
  limitTokens: "JOMO_LIMIT_TOKENS",
  allowedRecipients: "JOMO_ALLOWED_RECIPIENTS",
  sweepTo: "JOMO_SWEEP_TO",
  auditLog: "JOMO_AUDIT_LOG",
  privateKey: "JOMO_PRIVATE_KEY",
  scanFromBlock: "JOMO_SCAN_FROM_BLOCK",
  scanWindow: "JOMO_SCAN_WINDOW",
  router: "JOMO_ROUTER",
  announcer: "JOMO_ANNOUNCER",
  registry: "JOMO_REGISTRY",
} as const;

export function chainFromName(name: string | undefined): Chain {
  switch ((name ?? "robinhoodTestnet").toLowerCase()) {
    case "robinhood":
    case "mainnet":
    case "4663":
      return robinhood;
    case "robinhoodtestnet":
    case "testnet":
    case "46630":
      return robinhoodTestnet;
    default:
      throw new Error(`${ENV.chain} must be "robinhood" or "robinhoodTestnet"; got "${name}"`);
  }
}

export function defaultKeystorePath(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  return `${home}/.jomo/keystore.json`;
}

/**
 * The keystore passphrase, from the least to the most exposed source: a command that prints it
 * (an OS keychain or a password manager), the environment variable, nothing.
 */
export function passphraseFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const command = env[ENV.passphraseCommand];
  if (command) {
    const run = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env, stdio: ["ignore", "pipe", "inherit"] });
    if (run.status !== 0) throw new Error(`${ENV.passphraseCommand} exited with status ${run.status}`);
    const out = run.stdout.replace(/\r?\n$/, "");
    if (!out) throw new Error(`${ENV.passphraseCommand} printed nothing`);
    return out;
  }
  return env[ENV.passphrase];
}

export function confirmPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ConfirmPolicy {
  const v = (env[ENV.confirm] ?? "elicit").toLowerCase();
  if (v === "elicit" || v === "token" || v === "auto") return v;
  throw new Error(`${ENV.confirm} must be "elicit" (default), "token" or "auto"; got "${env[ENV.confirm]}"`);
}

const list = (v: string | undefined): string[] | undefined => {
  const items = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
};

/** Autonomous-mode limits from the environment; `undefined` when none are set. */
export function autonomyFromEnv(env: NodeJS.ProcessEnv = process.env): AutonomyConfig | undefined {
  const limits: AutonomyConfig["limits"] = [];
  const perTx = env[ENV.limitEthPerTx];
  const perDay = env[ENV.limitEthPerDay];
  if (perTx || perDay) {
    if (!perTx || !perDay) throw new Error(`Set both ${ENV.limitEthPerTx} and ${ENV.limitEthPerDay}`);
    limits.push({ asset: "ETH", perTx, perDay });
  }
  const tokens = env[ENV.limitTokens];
  if (tokens) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(tokens);
    } catch {
      throw new Error(`${ENV.limitTokens} must be JSON like {"0xToken…": {"perTx": "100", "perDay": "1000"}}`);
    }
    for (const [token, v] of Object.entries(parsed as Record<string, { perTx?: unknown; perDay?: unknown }>)) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error(`${ENV.limitTokens}: "${token}" is not a token address`);
      if (typeof v?.perTx !== "string" || typeof v?.perDay !== "string") throw new Error(`${ENV.limitTokens}: ${token} needs "perTx" and "perDay" as decimal strings`);
      limits.push({ asset: token as Address, perTx: v.perTx, perDay: v.perDay });
    }
  }
  const allowedRecipients = list(env[ENV.allowedRecipients]);
  const sweepTo = list(env[ENV.sweepTo]);
  if (!limits.length && !allowedRecipients && !sweepTo) return undefined;
  return { limits, allowedRecipients, sweepTo };
}

/** Build a config from environment variables (used by the CLI). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): JomoServerConfig {
  const chain = chainFromName(env[ENV.chain]);
  const rpc = env[ENV.rpcUrl];
  const privateKey = env[ENV.privateKey] as Hex | undefined;
  let keystore: Keystore;
  if (privateKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error(`${ENV.privateKey} must be a 32-byte hex private key`);
    if (chain.id === robinhood.id) throw new Error(`${ENV.privateKey} is for development only; on ${chain.name} use the keystore (jomo-mcp init)`);
    keystore = new MemoryKeystore(privateKey);
  } else {
    const path = env[ENV.keystore] ?? defaultKeystorePath();
    const passphrase = passphraseFromEnv(env);
    if (!passphrase) {
      throw new Error(
        `No passphrase for the keystore at ${path}. Set ${ENV.passphraseCommand} to a command that prints it (for example a keychain lookup), or ${ENV.passphrase}. Create a keystore with: jomo-mcp init`,
      );
    }
    keystore = FileKeystore.open(path, passphrase);
  }
  const fromBlock = env[ENV.scanFromBlock];
  const addr = (name: string): Address | undefined => {
    const v = env[name];
    if (!v) return undefined;
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`${name} must be a 20-byte hex address`);
    return v as Address;
  };
  // Contract overrides: a router deployed before the SDK's deployments table records it, or "none" to force direct mode.
  const routerEnv = env[ENV.router];
  const contracts: NonNullable<JomoServerConfig["contracts"]> = {};
  const announcer = addr(ENV.announcer);
  const registry = addr(ENV.registry);
  if (announcer) contracts.announcer = announcer;
  if (registry) contracts.registry = registry;
  if (routerEnv?.toLowerCase() === "none") contracts.router = null;
  else if (addr(ENV.router)) contracts.router = addr(ENV.router) as Address;
  return {
    chain,
    transport: rpc ? http(rpc) : undefined,
    keystore,
    scanFromBlock: fromBlock ? BigInt(fromBlock) : undefined,
    scanWindow: env[ENV.scanWindow] ? BigInt(env[ENV.scanWindow] as string) : undefined,
    contracts: Object.keys(contracts).length ? contracts : undefined,
    confirm: confirmPolicyFromEnv(env),
    autonomy: autonomyFromEnv(env),
    auditLog: env[ENV.auditLog] ?? (keystore.location === "memory" ? undefined : `${keystore.location.replace(/[^/\\]+$/, "")}audit.log`),
  };
}

/** The SDK agent behind the server, built from the keystore's identity key. */
export async function buildAgent(config: JomoServerConfig): Promise<PrivateAgent> {
  const account = privateKeyToAccount(config.keystore.state.identityPrivateKey);
  const stealthKeys = await StealthKeys.fromAccount(account, { chainId: config.chain.id });
  const cursor = config.keystore.state.cursor;
  return createPrivateAgent({
    chain: config.chain,
    transport: config.transport,
    account,
    stealthKeys,
    contracts: config.contracts,
    scan: { fromBlock: cursor ? BigInt(cursor) : config.scanFromBlock },
    defaultGasStipend: config.defaultGasStipend,
  });
}
