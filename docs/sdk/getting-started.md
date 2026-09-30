# Getting started

## Requirements

- Node.js 20.19 or newer (ESM or CJS)
- `viem` ≥ 2.30 as a peer dependency
- A funded key on Robinhood Chain testnet — [faucet](https://faucet.testnet.chain.robinhood.com)

```bash
pnpm add @usejomo/sdk viem
```

## 1. Create an agent

```ts
import { createPrivateAgent, StealthKeys, robinhoodTestnet } from "@usejomo/sdk";
import { http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`);

// Stealth keys are derived from a wallet signature: nothing new to back up.
const stealthKeys = await StealthKeys.fromAccount(account, { chainId: robinhoodTestnet.id });

const agent = createPrivateAgent({
  chain: robinhoodTestnet,
  transport: http(process.env.RPC_URL), // optional; defaults to the public RPC
  account,
  stealthKeys,
  scan: { fromBlock: 112_000_000n },    // where this agent's history begins
});
```

## 2. Publish your meta-address (once)

```ts
await agent.register();
console.log(agent.stealthMetaAddress); // st:rh-testnet:0x02…
```

Anyone can now pay `agent.address` privately: the SDK resolves it through the ERC-6538 registry and
derives a fresh stealth address for each payment.

## 3. Pay another agent

```ts
const result = await agent.send({
  to: "0xCounterpartyIdentityAddress",        // or a st:… meta-address
  amount: parseEther("0.1"),
  memo: { intent: "pay-for-task", taskId: "t-42" },
});

result.stealthAddress; // fresh address only the counterparty can spend from
result.hash;           // announcement transaction
result.mode;           // "router" | "direct"
```

## 4. Detect what you received

```ts
const { payments, toBlock } = await agent.scan();
for (const p of payments) {
  console.log(p.stealthAddress, p.token ?? "ETH", p.amount, p.memo?.value);
}
// persist toBlock + 1n and pass it as fromBlock next time
```

## 5. Spend without linking

```ts
await agent.forward({
  from: payments[0]!,                          // a StealthPayment
  to: "st:rh-testnet:0x…",                     // the next agent
  amount: parseEther("0.05"),
  memo: "subcontract: 50%",
});
```

The transaction is signed by the stealth address. Your identity wallet never appears as the sender.

## Run everything locally

The repository ships an Anvil fixture that mirrors Robinhood Chain (chain id 46630, canonical
singletons at their real addresses, router at its deterministic address):

```bash
git clone https://github.com/modecodes/JOMO.git && cd JOMO
pnpm install
pnpm --filter @usejomo/contracts build
pnpm demo            # two agents paying each other privately
pnpm test            # SDK (vitest + Anvil) and contracts (forge)
```

Next: [Keys & identity](keys.md)
