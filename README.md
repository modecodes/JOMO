# JOMO

**The privacy layer for Robinhood Chain.**

```
app / assistant / agent  →  JOMO  →  private transaction  →  Robinhood Chain
```

Private transactions for anything: ETH or any token, any amount, from any app, AI assistant or
autonomous agent. Every transaction lands on a fresh address only the recipient can find, so nobody
can map who sent what to whom, and nothing has to be deployed to use it. Three ways in: the
TypeScript SDK for code, `@jomo/mcp` (an MCP server + Claude Code plugin for Claude, OpenAI,
Antigravity and other MCP clients) for prompts, and the same server in autonomous mode for agents
that run on their own within spending limits. $JOMO, the token attached to the layer: a 1%
protocol fee on every router transaction goes to a vault that can pass fees on only to the contract
that pays $JOMO holders (fee side live on mainnet; payout side pre-launch).

| Package | What it is |
|---|---|
| [`packages/sdk`](packages/sdk) | `@jomo/sdk` — stealth addresses (ERC-5564/6538), encrypted memos, scanning, stealth spending |
| [`packages/mcp`](packages/mcp) | `@jomo/mcp` — the SDK as MCP tools the user approves call by call (elicitation), with an encrypted keystore; Claude Code plugin in `plugin/` |
| [`packages/contracts`](packages/contracts) | Foundry: `StealthRouter` (1% fee) + `FeeVault`, vendored canonical reference contracts, tests, deploy scripts |
| [`apps/web`](apps/web) | Landing page (Vite + TypeScript, no framework, no CSS files) |
| [`examples/agent-to-agent`](examples/agent-to-agent) | Two agents transacting privately on a local Robinhood-like Anvil |
| [`docs/`](docs) | Developer docs, rendered by the web app at `/#/docs`: [Overview](docs/overview.md) · SDK ([getting started](docs/sdk/getting-started.md), [keys](docs/sdk/keys.md), [sending](docs/sdk/sending.md), [receiving](docs/sdk/receiving.md), [configuration](docs/sdk/configuration.md), [privacy](docs/sdk/privacy.md), [API](docs/sdk/api.md)) · Plugin ([setup](docs/plugin/setup.md), [tools](docs/plugin/tools.md)) · [Contracts](docs/reference/contracts.md). Internal design notes: [`docs/internal/`](docs/internal) |

## Quick start

Requirements: Node ≥ 20.19, pnpm 9, [Foundry](https://getfoundry.sh) (forge + anvil).

```bash
pnpm install
pnpm --filter @jomo/contracts build   # compile contracts, export ABIs into the SDK
pnpm test                                  # SDK (vitest + Anvil) and contracts (forge)
pnpm build:sdk
pnpm demo                                  # two agents paying each other privately on Anvil
pnpm dev:web                               # landing page at http://localhost:5173, docs at /#/docs
```

## How it works

1. An agent derives **stealth keys** (spending + viewing) from its wallet and publishes its
   meta-address in the ERC-6538 registry.
2. A payer resolves that meta-address and derives a **fresh one-time address** per payment
   (ECDH + keccak, ERC-5564 scheme 1), attaches an **encrypted memo**, and pays + announces through
   the `StealthRouter` (or directly via the canonical Announcer).
3. The recipient **scans** announcements with its viewing key, recognises its payments, derives the
   spending keys, and can **forward** funds from those addresses so its identity never appears as a
   sender.

Privacy is scoped precisely in [docs/internal/THREAT-MODEL.md](docs/internal/THREAT-MODEL.md): recipient
unlinkability, confidential memos, sender detachment across hops. Amounts and first-hop senders are
public. Nothing here is "untraceable".

## Status

- Contracts: `StealthRouter` v2 (1% protocol fee on top of every payment, reentrancy-guarded) and
  `FeeVault` (fee custody, live counters, fees leave only to a sink behind a two-day delay) pass
  102 Foundry tests and a Slither run with no high-severity findings. **Live on Robinhood Chain
  mainnet (4663) since 2026-09-30**: router `0xDc30aACc6883F3f2b27C6981e4BF641c336dCA30`, vault `0xA01ABBfEaC3540dF18629A8c5bb383e33F448f75`; the SDK uses them
  there and runs in direct, fee-free mode on other chains. No sink is set yet, so fees accumulate
  in the vault.
- SDK: 41 tests pass, including 100 randomized cross-checks against ScopeLift's reference
  ERC-5564 implementation and a full Anvil end-to-end flow with fees and counters.
- Mainnet readiness: see [docs/internal/MAINNET-READINESS.md](docs/internal/MAINNET-READINESS.md).
- `@jomo/mcp` is built and tested (19 tests on an Anvil replica); publishing needs the `@jomo` npm scope.
- $JOMO launches on a Robinhood Chain launchpad. The router's fees reach holders through the vault's
  sink, a payout contract that is designed, not built; nothing token-related is deployed.
- No audit yet. Not affiliated with or endorsed by Robinhood.

## License

SDK and contracts: MIT. Vendored `ERC5564Announcer`/`ERC6538Registry` reference sources: CC0-1.0.
Geist Pixel font: SIL OFL 1.1 (Vercel).

## Deploy the site (Railway)

`railway.json` at the repo root builds the landing page and serves `apps/web/dist` as a static
site (hash routing, so no server rewrites are needed).

1. Railway → New Project → Deploy from GitHub → pick this repo. Leave the root directory at `/`
   (it is a pnpm workspace); Railway reads `railway.json` for the build and start commands.
2. Settings → Networking → Generate Domain (or add your own). The page talks to Robinhood Chain's
   public RPC from the browser, so it needs no other configuration.
3. When $JOMO is live, set one service variable: `JOMO_CA` = the token's contract address
   (`0x` and 40 hex digits). Railway rebuilds the site, which then shows the address, with a copy
   button, in the bar on desktop and in the hero on phones. Until it is set (or if it is not an
   address) the page shows no address at all. To change it, edit the variable and deploy.
4. Pushes redeploy only on changes under `apps/web/`, the SDK's generated module, or the lockfile.

Do not deploy `@jomo/mcp` as a public Railway service: it holds signing keys and its HTTP
transport has no authentication. Run it next to the agent that uses it.
