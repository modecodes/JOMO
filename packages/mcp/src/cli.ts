/**
 * jomo-mcp — run the JOMO MCP server.
 *
 *   jomo-mcp                    stdio (Claude Code, Claude Desktop, Antigravity, …)
 *   jomo-mcp --http 8787        streamable HTTP on 127.0.0.1:8787, bearer token required (local clients only)
 *   jomo-mcp init [--import 0x…] create the encrypted keystore (generates a key unless imported)
 *   jomo-mcp address            print the identity address and stealth meta-address
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { StealthKeys } from "@usejomo/sdk";
import { chainFromName, configFromEnv, defaultKeystorePath, ENV, passphraseFromEnv } from "./config.js";
import { createContext } from "./context.js";
import { assertLoopbackHost, startHttp } from "./http.js";
import { FileKeystore } from "./keystore.js";
import { createJomoServer } from "./server.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function promptPassphrase(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`Set ${ENV.passphrase} (no TTY to prompt).`);
  const muted = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write(label);
  return new Promise((resolve) =>
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer);
    }),
  );
}

async function passphrase(): Promise<string> {
  return passphraseFromEnv() ?? promptPassphrase("Keystore passphrase: ");
}

async function init(): Promise<void> {
  const path = process.env[ENV.keystore] ?? defaultKeystorePath();
  const imported = arg("--import") as Hex | undefined;
  const pass = await passphrase();
  if (!process.env[ENV.passphrase]) {
    const again = await promptPassphrase("Repeat passphrase: ");
    if (again !== pass) throw new Error("Passphrases do not match");
  }
  const store = FileKeystore.create(path, pass, imported);
  const account = privateKeyToAccount(store.state.identityPrivateKey);
  process.stderr.write(`Keystore written to ${path} (mode 600).\nIdentity address: ${account.address}\nFund it on ${chainFromName(process.env[ENV.chain]).name}, then run jomo_register from your assistant.\n`);
  process.stderr.write(
    `\nGive the server the passphrase without putting it in a shell profile: store it in your keychain and set\n` +
      `  ${ENV.passphraseCommand}='security find-generic-password -s jomo-mcp -w'   (macOS; add it with: security add-generic-password -s jomo-mcp -a $USER -w)\n` +
      `  ${ENV.passphraseCommand}='secret-tool lookup service jomo-mcp'              (Linux libsecret)\n` +
      `  ${ENV.passphraseCommand}='pass show jomo/mcp'                               (pass)\n`,
  );
}

async function address(): Promise<void> {
  const config = configFromEnv({ ...process.env, [ENV.passphrase]: process.env[ENV.passphrase] ?? (process.env[ENV.privateKey] ? undefined : await passphrase()) });
  const account = privateKeyToAccount(config.keystore.state.identityPrivateKey);
  const keys = await StealthKeys.fromAccount(account, { chainId: config.chain.id });
  process.stdout.write(`${JSON.stringify({ chain: config.chain.name, chainId: config.chain.id, identity: account.address, metaAddress: keys.metaAddress(config.chain.id === 4663 ? "robinhoodchain" : "rh-testnet"), keystore: config.keystore.location }, null, 2)}\n`);
}

/** Build the context, then drop the passphrase from this process's environment. */
async function start(): Promise<Awaited<ReturnType<typeof createContext>>> {
  const ctx = await createContext(configFromEnv());
  delete process.env[ENV.passphrase];
  const mode = ctx.confirm === "auto" ? "autonomous within limits" : ctx.confirm === "token" ? "token approval" : "user approval";
  process.stderr.write(`jomo-mcp · ${ctx.agent.chain.name} · identity ${ctx.agent.address} · ${mode}\n`);
  if (ctx.registrationWarning) process.stderr.write(`WARNING: ${ctx.registrationWarning}\n`);
  return ctx;
}

async function runStdio(): Promise<void> {
  const ctx = await start();
  const server = createJomoServer(ctx);
  await server.connect(new StdioServerTransport());
  process.stderr.write("jomo-mcp ready on stdio\n");
}

async function runHttp(port: number): Promise<void> {
  const ctx = await start();
  const token = process.env[ENV.httpToken] ?? randomBytes(24).toString("base64url");
  await startHttp(ctx, { port, token });
  process.stderr.write(`jomo-mcp ready at http://127.0.0.1:${port}/mcp · ${ctx.agent.chain.name} · identity ${ctx.agent.address}\n`);
  if (!process.env[ENV.httpToken]) process.stderr.write(`Bearer token for this run (set ${ENV.httpToken} to choose your own): ${token}\n`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "init") return init();
  if (cmd === "address") return address();
  const port = arg("--http");
  if (port) {
    assertLoopbackHost(arg("--host"));
    return runHttp(Number(port));
  }
  return runStdio();
}

main().catch((error: unknown) => {
  process.stderr.write(`jomo-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
