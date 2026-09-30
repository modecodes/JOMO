/**
 * The router's operational controls as the SDK sees them, on a fresh Anvil: the vault's emergency
 * stop (and restart), the gas-stipend cap, allowance resets, and earlier router versions.
 */
import { createWalletClient, getAddress, http, parseEther, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { robinhoodTestnet } from "../src/chains.js";
import { PrivateAgent, createPrivateAgent } from "../src/client/PrivateAgent.js";
import { StealthKeys } from "../src/crypto/keys.js";
import { RouterUnavailableError } from "../src/errors.js";
import {
  ERC5564_ANNOUNCER_ADDRESS,
  FEE_VAULT_SINK_DELAY,
  STEALTH_ROUTER_MAX_GAS_STIPEND,
  feeVaultAbi,
  stealthRouterAbi,
  stealthRouterBytecode,
} from "../src/generated/contracts.js";
import { approveResetErc20Abi, approveResetErc20Bytecode, mockErc20Abi } from "./fixtures/contracts.js";
import { ANVIL_KEYS, startAnvil, type AnvilInstance } from "./helpers/anvil.js";
import { deployFixture, type Fixture } from "./helpers/deploy.js";

let anvil: AnvilInstance;
let chain: Chain;
let fixture: Fixture;
let alice: PrivateAgent;
let bob: PrivateAgent;
const ownerKey = ANVIL_KEYS[4] as Hex;
const owner = privateKeyToAccount(ownerKey);

async function asOwner(functionName: "setRouter", args: readonly [Address, boolean]): Promise<void> {
  const wallet = createWalletClient({ account: owner, chain, transport: http(anvil.rpcUrl) });
  const hash = await wallet.writeContract({ address: fixture.feeVault, abi: feeVaultAbi, functionName, args });
  await alice.publicClient.waitForTransactionReceipt({ hash });
}

async function allowance(token: Address, spender: Address): Promise<bigint> {
  return alice.publicClient.readContract({
    address: token,
    abi: mockErc20Abi,
    functionName: "allowance",
    args: [alice.address as Address, spender],
  });
}

beforeAll(async () => {
  anvil = await startAnvil({ chainId: robinhoodTestnet.id });
  chain = { ...robinhoodTestnet, rpcUrls: { default: { http: [anvil.rpcUrl] } } };
  fixture = await deployFixture(anvil.rpcUrl, chain, ANVIL_KEYS[0] as Hex, owner.address);
  const transport = http(anvil.rpcUrl);
  const make = (key: Hex, seed: string) =>
    createPrivateAgent({
      chain,
      transport,
      account: privateKeyToAccount(key),
      stealthKeys: StealthKeys.fromSeed(seed),
      contracts: { router: fixture.router },
      scan: { fromBlock: 0n },
    });
  alice = make(ANVIL_KEYS[1] as Hex, "controls-alice-seed-0000");
  bob = make(ANVIL_KEYS[2] as Hex, "controls-bob-seed-000000");
  const minter = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[0] as Hex), chain, transport });
  const hash = await minter.writeContract({ address: fixture.token, abi: mockErc20Abi, functionName: "mint", args: [alice.address as Address, parseEther("1000")] });
  await alice.publicClient.waitForTransactionReceipt({ hash });
});

afterAll(() => anvil?.stop());

describe("router controls", () => {
  it("exports the same stipend cap and sink delay the contracts enforce", async () => {
    expect(await alice.publicClient.readContract({ address: fixture.router, abi: stealthRouterAbi, functionName: "MAX_GAS_STIPEND" })).toBe(STEALTH_ROUTER_MAX_GAS_STIPEND);
    expect(await alice.publicClient.readContract({ address: fixture.feeVault, abi: feeVaultAbi, functionName: "SINK_DELAY" })).toBe(FEE_VAULT_SINK_DELAY);
  });

  it("falls back to direct mode while the vault has stopped the router, and returns when it restarts", async () => {
    const before = await alice.send({ to: bob.stealthMetaAddress, amount: parseEther("0.1") });
    expect(before.mode).toBe("router");

    await asOwner("setRouter", [fixture.router, false]);

    const error = await alice.getRouter().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RouterUnavailableError);
    expect((error as RouterUnavailableError).reason).toBe("disabled");
    expect(await alice.quoteFee(parseEther("1"))).toBe(0n);

    const eth = await alice.send({ to: bob.stealthMetaAddress, amount: parseEther("0.2") });
    expect(eth.mode).toBe("direct");
    expect(eth.fee).toBe(0n);

    // No approval is left behind for the stopped router.
    const allowanceBefore = await allowance(fixture.token, fixture.router);
    const token = await alice.send({ to: bob.stealthMetaAddress, token: fixture.token, amount: parseEther("3") });
    expect(token.mode).toBe("direct");
    expect(await allowance(fixture.token, fixture.router)).toBe(allowanceBefore);

    await expect(alice.send({ to: bob.stealthMetaAddress, amount: 1n, mode: "router" })).rejects.toThrow(RouterUnavailableError);
    await expect(alice.sendBatch({ payments: [{ to: bob.stealthMetaAddress, amount: 1n }] })).rejects.toThrow(RouterUnavailableError);

    // The counters stay readable, and what the router announced while it ran still counts as routed.
    const stats = await alice.getStats();
    expect(stats.transactions).toBe(1n);
    const { payments } = await bob.scan();
    const routed = payments.find((p) => p.stealthAddress === before.stealthAddress);
    expect(routed?.viaRouter).toBe(true);
    expect(routed?.verified).toBe(true);

    await asOwner("setRouter", [fixture.router, true]);
    const after = await alice.send({ to: bob.stealthMetaAddress, amount: parseEther("0.1") });
    expect(after.mode).toBe("router");
    expect(after.fee).toBe(parseEther("0.001"));
  });

  it("refuses a gas stipend above the router's cap, and allows it in direct mode", async () => {
    const over = STEALTH_ROUTER_MAX_GAS_STIPEND + 1n;
    await expect(alice.send({ to: bob.stealthMetaAddress, token: fixture.token, amount: parseEther("1"), gasStipend: over })).rejects.toThrow(RangeError);
    await expect(
      alice.sendBatch({ payments: [{ to: bob.stealthMetaAddress, token: fixture.token, amount: parseEther("1"), gasStipend: over }] }),
    ).rejects.toThrow(RangeError);
    const atCap = await alice.send({ to: bob.stealthMetaAddress, token: fixture.token, amount: parseEther("1"), gasStipend: STEALTH_ROUTER_MAX_GAS_STIPEND });
    expect(atCap.mode).toBe("router");
    const direct = await alice.send({ to: bob.stealthMetaAddress, token: fixture.token, amount: parseEther("1"), gasStipend: over, mode: "direct" });
    expect(direct.mode).toBe("direct");
  });

  it("resets a stale allowance first for tokens that refuse to change a non-zero one", async () => {
    const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[0] as Hex), chain, transport: http(anvil.rpcUrl) });
    const deployHash = await deployer.deployContract({ abi: approveResetErc20Abi, bytecode: approveResetErc20Bytecode });
    const usdt = getAddress((await alice.publicClient.waitForTransactionReceipt({ hash: deployHash })).contractAddress as Address);
    let hash = await deployer.writeContract({ address: usdt, abi: approveResetErc20Abi, functionName: "mint", args: [alice.address as Address, 1_000_000_000n] });
    await alice.publicClient.waitForTransactionReceipt({ hash });

    // A stale allowance smaller than the next payment, as a failed earlier send would leave.
    const aliceWallet = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[1] as Hex), chain, transport: http(anvil.rpcUrl) });
    hash = await aliceWallet.writeContract({ address: usdt, abi: approveResetErc20Abi, functionName: "approve", args: [fixture.router, 1n] });
    await alice.publicClient.waitForTransactionReceipt({ hash });

    const result = await alice.send({ to: bob.stealthMetaAddress, token: usdt, amount: 5_000_000n });
    expect(result.mode).toBe("router");
    expect(result.transactionHashes).toHaveLength(3); // reset to zero, approve, send
    expect(await alice.publicClient.readContract({ address: usdt, abi: approveResetErc20Abi, functionName: "balanceOf", args: [result.stealthAddress] })).toBe(5_000_000n);
  });

  it("recognises announcements from earlier router versions after an upgrade", async () => {
    const earlier = await alice.send({ to: bob.stealthMetaAddress, amount: parseEther("0.05") });
    expect(earlier.mode).toBe("router");

    // A new router version on the same vault, allowed next to the old one.
    const deployer = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[0] as Hex), chain, transport: http(anvil.rpcUrl) });
    const deployHash = await deployer.deployContract({ abi: stealthRouterAbi, bytecode: stealthRouterBytecode, args: [ERC5564_ANNOUNCER_ADDRESS, fixture.feeVault] });
    const next = getAddress((await alice.publicClient.waitForTransactionReceipt({ hash: deployHash })).contractAddress as Address);
    await asOwner("setRouter", [next, true]);

    const upgraded = createPrivateAgent({
      chain,
      transport: http(anvil.rpcUrl),
      stealthKeys: StealthKeys.fromSeed("controls-bob-seed-000000"),
      contracts: { router: next, previousRouters: [fixture.router] },
      scan: { fromBlock: 0n, onlyRouter: true },
    });
    const { payments } = await upgraded.scan();
    const found = payments.find((p) => p.stealthAddress === earlier.stealthAddress);
    expect(found?.viaRouter).toBe(true);

    const forgetful = createPrivateAgent({
      chain,
      transport: http(anvil.rpcUrl),
      stealthKeys: StealthKeys.fromSeed("controls-bob-seed-000000"),
      contracts: { router: next, previousRouters: [] },
      scan: { fromBlock: 0n },
    });
    const without = (await forgetful.scan()).payments.find((p) => p.stealthAddress === earlier.stealthAddress);
    expect(without?.viaRouter).toBe(false);
  });
});
