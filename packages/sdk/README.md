# @jomo/sdk

The privacy layer for **Robinhood Chain**: private transactions for ETH and any token, from any app,
assistant or agent.

Built on [ERC-5564](https://eips.ethereum.org/EIPS/eip-5564) stealth addresses and the
[ERC-6538](https://eips.ethereum.org/EIPS/eip-6538) registry — both live at their canonical addresses
on Robinhood Chain mainnet (4663) and testnet (46630) — plus encrypted memos and a
small router contract for atomic pay-and-announce with gas stipends.

```ts
import { createPrivateAgent, StealthKeys, robinhoodTestnet } from "@jomo/sdk";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`);
const agent = createPrivateAgent({
  chain: robinhoodTestnet,
  account,
  stealthKeys: await StealthKeys.fromAccount(account, { chainId: robinhoodTestnet.id }),
});

await agent.register();                                            // publish meta-address once
await agent.send({ to: counterparty, amount: parseEther("0.1"), memo: { taskId: "t-42" } });

const { payments } = await agent.scan();                           // detect incoming payments
await agent.forward({ from: payments[0]!, to: nextAgent, amount: parseEther("0.05") }); // private hop
```

What you get: recipient unlinkability, encrypted memos, and sender detachment on onward hops.
What you don't: amount privacy or first-hop sender privacy. Read the
[privacy guarantees](https://usejomo.com/#/docs/privacy) before making claims.

- [Getting started](https://usejomo.com/#/docs/getting-started)
- [API reference](https://usejomo.com/#/docs/api)
- [Architecture](https://usejomo.com/#/docs/architecture)
- [Contracts & addresses](https://usejomo.com/#/docs/contracts)

## Development

```bash
pnpm install
pnpm --filter @jomo/contracts build   # forge build + export ABIs into src/generated
pnpm --filter @jomo/sdk test          # vitest: unit + Anvil integration (needs foundry)
pnpm --filter @jomo/sdk build         # tsup → dist (ESM + CJS + d.ts)
```
