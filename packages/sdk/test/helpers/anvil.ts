import { spawn, type ChildProcess } from "node:child_process";
import type { Hex } from "viem";

/** Anvil's default mnemonic accounts. */
export const ANVIL_KEYS: readonly Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
];

export interface AnvilInstance {
  rpcUrl: string;
  chainId: number;
  stop: () => void;
}

export async function startAnvil(options: { chainId?: number } = {}): Promise<AnvilInstance> {
  const chainId = options.chainId ?? 46630;
  const port = 30000 + Math.floor(Math.random() * 10000);
  const child: ChildProcess = spawn("anvil", ["--port", String(port), "--chain-id", String(chainId), "--silent"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited early: ${stderr}`);
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const json = (await res.json()) as { result?: string };
      if (json.result && Number(json.result) === chainId) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { rpcUrl, chainId, stop: () => child.kill("SIGTERM") };
}
