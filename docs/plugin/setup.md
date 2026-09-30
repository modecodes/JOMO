# Plugin: overview & setup

> **Status: built and tested** (`packages/mcp`, 16 tests against an Anvil replica of Robinhood Chain).
> Publishing to npm as `@jomo/mcp` needs the `@jomo` scope; until then run it from the repo with
> `pnpm --filter @jomo/mcp build && node packages/mcp/dist/cli.js`.

The plugin is the second door into the privacy layer. It wraps `@jomo/sdk` in an MCP server so
prompt-driven agents — Claude, OpenAI-based assistants, Google Antigravity, and any MCP-capable
client — perform private transactions on Robinhood Chain by calling tools.

```
prompt ──▶ assistant ──▶ MCP client ──▶ jomo MCP server ──▶ @jomo/sdk ──▶ Robinhood Chain
                                        (local process; holds the keys)
```

## What the server enforces, whatever the prompt says

- **Keys never cross the MCP boundary.** Results carry addresses and hashes; `stealthPrivateKey` is
  stripped from every payment before it is returned.
- **The user approves every state-changing call.** With MCP elicitation the server shows the user
  the full summary (whole addresses, exact amounts, the fee) and executes only on approval; the
  model never sees a token. Without elicitation the call is refused (`ELICITATION_REQUIRED`) and
  nothing is sent. `JOMO_CONFIRM=token` is an explicit opt-in for hosts that ask the user before
  every tool call: the first call returns a summary and a one-time token bound to that tool and those
  exact arguments, expiring in two minutes. The Claude Code plugin adds a `PreToolUse` hook that
  keeps Claude Code's own prompt on for the five state-changing tools. There is no auto-approve flag.
- **Autonomous agents run within limits the operator sets.** With `JOMO_CONFIRM=auto`, payments within
  the per-payment and rolling-24-hour limits run at once; past them the user is asked if the client
  can ask, and otherwise the call is refused (`POLICY_LIMIT`). Details below.
- **Sweeps move exactly what was approved.** If the balance drops or gas rises before execution, the
  sweep fails instead of sending a different amount.
- **A wrong block number cannot blind the receive path.** Scans stop at the chain head, an explicit
  `toBlock` never moves the stored cursor, and one scan covers at most 250 000 blocks.
- **Errors never carry RPC credentials.** URLs in error text are cut to their origin.
- **Strict amounts.** `"0.25 ETH"` or `{ "value": "0.25", "unit": "ETH" }`; bare numbers are rejected.
- **Same privacy scope as the SDK.** Send results include a one-line note that amounts and the first-hop
  sender are public, so the model relays honest information.

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
| `JOMO_RPC_URL` | RPC endpoint | chain default |
| `JOMO_KEYSTORE` | path to the encrypted keystore (scrypt + XChaCha20-Poly1305, mode 600) holding the identity key, the scan cursor and detected stealth payments | `~/.jomo/keystore.json` |
| `JOMO_KEYSTORE_PASSPHRASE_CMD` | command that prints the passphrase (keychain lookup; preferred) | — |
| `JOMO_KEYSTORE_PASSPHRASE` | the passphrase itself; prompted on a TTY if neither is set | — |
| `JOMO_CONFIRM` | `elicit` (default), `token`, or `auto` (autonomous within limits) | `elicit` |
| `JOMO_LIMIT_ETH_PER_TX`, `JOMO_LIMIT_ETH_PER_DAY` | autonomous ETH limits, in ETH | — |
| `JOMO_LIMIT_TOKENS` | autonomous token limits, JSON `{"0xToken": {"perTx": "100", "perDay": "1000"}}` | — |
| `JOMO_ALLOWED_RECIPIENTS` / `JOMO_SWEEP_TO` | where autonomous payments and sweeps may go | any / identity |
| `JOMO_AUDIT_LOG` | audit log of every payment and refusal | next to the keystore |
| `JOMO_HTTP_TOKEN` | bearer token for `--http` | random, printed at start |
| `JOMO_PRIVATE_KEY` | in-memory dev key instead of a keystore (testnet only; refused on mainnet) | — |
| `JOMO_SCAN_FROM_BLOCK` | first block to scan when there is no cursor | latest − 100 000 |
| `JOMO_ROUTER` | router address override (a fresh deployment), or `none` to force direct mode | SDK deployments table |

Create the keystore once:

```bash
jomo-mcp init                # generates a key (or --import 0x…), prints the identity address
jomo-mcp address             # identity + stealth meta-address
```

## Claude Code

```bash
claude mcp add jomo -- npx @jomo/mcp
```

or, as a plugin, `.claude-plugin/plugin.json` bundles the server plus an `jomo` skill that teaches
the model the privacy scope and how to phrase confirmations.

## Claude Desktop

```json
{
  "mcpServers": {
    "jomo": {
      "command": "npx",
      "args": ["@jomo/mcp"],
      "env": { "JOMO_CHAIN": "robinhoodTestnet" }
    }
  }
}
```

## OpenAI

Point the Responses API or Agents SDK at the server's streamable-HTTP endpoint:

```json
{
  "type": "mcp",
  "server_label": "jomo",
  "server_url": "http://localhost:8787/mcp",
  "require_approval": "always"
}
```

Clients without MCP support can import the same tools as function-calling schemas from
`@jomo/mcp/schemas`.

## Antigravity and other MCP clients

Any client that speaks MCP over `stdio` or streamable HTTP works with the standard config:

```json
{ "jomo": { "command": "npx", "args": ["@jomo/mcp"] } }
```

## Running the server directly

```bash
npx @jomo/mcp              # stdio
npx @jomo/mcp --http 8787  # local HTTP on 127.0.0.1:8787/mcp; send Authorization: Bearer <JOMO_HTTP_TOKEN>
```

Next: [Tools & prompts](tools.md)
