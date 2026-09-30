# Configuration & networks

## `createPrivateAgent(config)`

| Field | Type | Default | Notes |
|---|---|---|---|
| `chain` | `Chain` | required | `robinhood`, `robinhoodTestnet`, or a custom chain |
| `transport` | `Transport` | `http()` | any viem transport; use a dedicated RPC in production |
| `account` | `LocalAccount` | — | needed to register and send; omit for scan-only agents |
| `stealthKeys` | `StealthKeys` | required | see [Keys & identity](keys.md) |
| `contracts.announcer` | `Address` | canonical | override for other chains |
| `contracts.registry` | `Address` | canonical | override for other chains |
| `contracts.router` | `Address \| null` | from `STEALTH_ROUTER_DEPLOYMENTS[chain.id]` | `null` disables the router; in `auto`, a router with no code or one its vault has stopped falls back to direct mode |
| `contracts.previousRouters` | `Address[]` | from the deployment record | earlier router versions: their announcements still count as router announcements when scanning; never used to send |
| `chainShortName` | `string` | from chain id | prefix in `st:<name>:` |
| `scan.fromBlock` | `bigint` | latest − 100 000 | set it |
| `scan.chunkSize` | `bigint` | `5000n` | blocks per `eth_getLogs` |
| `scan.onlyRouter` | `boolean` | `false` | filter by router caller |
| `defaultGasStipend` | `bigint` | `0n` | ETH sent with ERC-20 payments |
| `pollingInterval` | `number` | `2000` | ms, for `watch()` |

```ts
import { createPrivateAgent, robinhood } from "@usejomo/sdk";
import { http } from "viem";

const agent = createPrivateAgent({
  chain: robinhood,
  transport: http("https://robinhood-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_KEY),
  account,
  stealthKeys,
  scan: { fromBlock: 53_000_000n, chunkSize: 2_000n },
  defaultGasStipend: parseEther("0.0003"),
});
```

## Deployments

`STEALTH_ROUTER_DEPLOYMENTS` maps chain id → `{ stealthRouter, feeVault, feeVaultOwner, announcer,
previousStealthRouters }` and is generated from deployments that were verified on chain and wired.
Chains without an entry run in direct mode. To know the addresses before deploying:

```ts
import { computeDeploymentAddresses } from "@usejomo/sdk";

const { feeVault, stealthRouter } = computeDeploymentAddresses({
  feeVaultOwner: "0xMultisig",
}); // same owner address → same contract addresses on every chain; the broadcasting key does not matter
```

Live counters:

```ts
const { transactions, ethTransactions, ethRouted, ethFees } = await agent.getStats(); // reads FeeVault.stats()
```

## Networks

| | Mainnet | Testnet |
|---|---|---|
| Chain id | 4663 | 46630 |
| viem chain | `robinhood` | `robinhoodTestnet` |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` | `https://explorer.testnet.chain.robinhood.com` |
| Faucet | — | `https://faucet.testnet.chain.robinhood.com` |

Robinhood Chain is an Arbitrum-based L2 with ETH as gas. Public RPCs are rate-limited; scanning from
them also reveals your interest patterns to the provider.

## Other EVM chains

Any chain with the ERC-5564 singletons works:

```ts
const agent = createPrivateAgent({
  chain: myChain,
  contracts: { announcer: "0x…", registry: "0x…", router: null },
  chainShortName: "mychain",
  stealthKeys,
});
```

## Local testing

The SDK's integration tests and the demo run against Anvil configured like Robinhood Chain testnet.
Reuse the helper in `packages/sdk/test/helpers/deploy.ts`: it places the canonical singletons at their
real addresses with `anvil_setCode` and deploys the router through the CREATE2 factory, so your code
runs unchanged against the live network.

```bash
anvil --chain-id 46630
```

Next: [Privacy guarantees](privacy.md)
