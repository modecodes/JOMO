# @jomo/mcp

JOMO as MCP tools: private transactions on Robinhood Chain from Claude, OpenAI-based assistants,
Google Antigravity or any MCP client, approved by you or, for an autonomous agent, by spending limits
you set. Wraps `@jomo/sdk` one-to-one.

```bash
npx @jomo/mcp init                       # create the encrypted keystore, print the identity address
JOMO_KEYSTORE_PASSPHRASE_CMD='security find-generic-password -s jomo-mcp -w' npx @jomo/mcp   # stdio server
npx @jomo/mcp --http 8787                # local HTTP on 127.0.0.1:8787/mcp, bearer token required
```

| Tool | Does | Confirms |
|---|---|---|
| `jomo_register` | publish the stealth meta-address | yes |
| `jomo_resolve` | look up a registered agent | no |
| `jomo_send` | private payment with encrypted memo (1% fee in router mode) | yes |
| `jomo_send_batch` | many payments, one atomic transaction | yes |
| `jomo_scan` | detect incoming payments (viewing key), remember them | no |
| `jomo_forward` | pay onward from a stealth address; identity never signs | yes |
| `jomo_sweep` | consolidate a stealth address anywhere | yes |
| `jomo_balance` | identity and stealth balances | no |
| `jomo_privacy_scope` | what is private, what is not | no |

**The user approves every state-changing call.** With a client that supports MCP elicitation, the
server shows the user the full summary (whole addresses, exact amounts, the fee) and executes only
on approval; the model never sees a token. A client without elicitation is refused
(`ELICITATION_REQUIRED`) and nothing is sent. Set `JOMO_CONFIRM=token` only for a host that itself
asks the user before every tool call: the first call then returns the summary and a one-time token
bound to that tool and those exact arguments. The Claude Code plugin also ships a `PreToolUse` hook
that keeps Claude Code's own prompt on for these five tools, even if they are auto-allowed.

**Autonomous agents.** Run with `JOMO_CONFIRM=auto` and spending limits; see below.

**Keys never cross the MCP boundary.** The identity key and every stealth spending key live in an
encrypted keystore (scrypt + XChaCha20-Poly1305, file mode 600). Results carry addresses and hashes.

**Amounts carry units.** `"0.25 ETH"`, `"40 USDC"`, or `{ "value": "40", "unit": "USDC" }`. Bare numbers are rejected.

## Autonomous agents

An agent with no person in the loop (an OpenClaw-style agent, a trading bot, a backend service) runs
the server in autonomous mode. The operator sets the limits; the model can never change them.

```bash
JOMO_CONFIRM=auto \
JOMO_LIMIT_ETH_PER_TX=0.05 JOMO_LIMIT_ETH_PER_DAY=0.5 \
JOMO_LIMIT_TOKENS='{"0xUSDC…": {"perTx": "100", "perDay": "1000"}}' \
JOMO_ALLOWED_RECIPIENTS=0xSupplier…,st:robinhoodchain:0x… \
JOMO_SWEEP_TO=0xTreasury… \
npx @jomo/mcp
```

- A payment within the limits runs at once. The fee and any gas stipend count toward them.
- Past a limit, the server asks the user if the client can ask, and otherwise refuses with
  `POLICY_LIMIT`. Nothing is sent.
- A token with no limit is never spent autonomously. Sweeps go only to the identity or `JOMO_SWEEP_TO`.
  `JOMO_ALLOWED_RECIPIENTS`, when set, restricts who can be paid.
- The daily limit is a rolling 24 hours, kept in the encrypted keystore so a restart does not reset it.
- Every payment, refusal and decline is appended to `audit.log` next to the keystore (`JOMO_AUDIT_LOG`
  to move it). It holds summaries and transaction hashes, never keys.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `JOMO_CHAIN` | `robinhood` or `robinhoodTestnet` | `robinhoodTestnet` |
| `JOMO_RPC_URL` | RPC endpoint | chain public RPC |
| `JOMO_KEYSTORE` | keystore path | `~/.jomo/keystore.json` |
| `JOMO_KEYSTORE_PASSPHRASE_CMD` | a command that prints the passphrase, e.g. a keychain lookup (preferred) | — |
| `JOMO_KEYSTORE_PASSPHRASE` | the passphrase itself (use the command instead where you can) | — |
| `JOMO_CONFIRM` | `elicit` (default: ask the user, refuse clients that cannot ask), `token`, or `auto` (autonomous within limits) | `elicit` |
| `JOMO_LIMIT_ETH_PER_TX`, `JOMO_LIMIT_ETH_PER_DAY` | autonomous ETH limits, in ETH | — |
| `JOMO_LIMIT_TOKENS` | autonomous token limits, JSON `{"0xToken": {"perTx": "100", "perDay": "1000"}}` | — |
| `JOMO_ALLOWED_RECIPIENTS` | comma-separated addresses or meta-addresses autonomous payments may go to | any |
| `JOMO_SWEEP_TO` | comma-separated addresses autonomous sweeps may go to (the identity always may) | identity |
| `JOMO_AUDIT_LOG` | audit log path | `audit.log` next to the keystore |
| `JOMO_SCAN_WINDOW` | most blocks one scan covers | 250 000 |
| `JOMO_HTTP_TOKEN` | bearer token for `--http` (a random one is printed if unset) | — |
| `JOMO_PRIVATE_KEY` | in-memory dev key instead of a keystore | — |
| `JOMO_SCAN_FROM_BLOCK` | first block to scan when there is no cursor | latest − 100 000 |

## Clients

- **Claude Code:** `claude mcp add jomo -- npx -y @jomo/mcp`, or install the bundled plugin in `plugin/` (server config + a skill that teaches confirmations and the privacy scope).
- **Claude Desktop:** add the `plugin/.mcp.json` server block to `claude_desktop_config.json`.
- **OpenAI:** point the Responses API / Agents SDK MCP tool at `http://127.0.0.1:8787/mcp`, or import `jomoToolSchemas` from `@jomo/mcp/schemas` for function calling.
- **Antigravity and others:** any MCP client over stdio or streamable HTTP.

`--http` listens on loopback only, requires the bearer token (`JOMO_HTTP_TOKEN`, or the one printed at
start) on every request, and rejects requests whose Host header is not loopback. To reach it from
another machine, put it behind a proxy that adds TLS; the token still applies.

## Development

```bash
pnpm --filter @jomo/mcp test    # vitest, spawns Anvil configured like Robinhood Chain testnet
pnpm --filter @jomo/mcp build   # tsup → dist (ESM + CJS + types), bin jomo-mcp
```
