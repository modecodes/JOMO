/**
 * End-to-end flows on a local Anvil configured like Robinhood Chain Testnet (chain id 46630) with the
 * canonical Announcer/Registry singletons and the StealthRouter at their real addresses.
 */
import { http, isAddressEqual, parseEther, type Address, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { robinhoodTestnet } from "../src/chains.js";
import { encodeAnnouncementMetadata } from "../src/crypto/metadata.js";
import { generateStealthAddress } from "../src/crypto/stealth.js";
import { TransactionRevertedError, TransferNotDeliveredError } from "../src/errors.js";
import { erc5564AnnouncerAbi } from "../src/generated/contracts.js";
import { InvalidStealthMetaAddressError } from "../src/errors.js";
import { PrivateAgent, createPrivateAgent } from "../src/client/PrivateAgent.js";
import { StealthKeys } from "../src/crypto/keys.js";
import { RecipientNotRegisteredError, RouterUnavailableError } from "../src/errors.js";
import { mockErc20Abi } from "./fixtures/contracts.js";
import { ANVIL_KEYS, startAnvil, type AnvilInstance } from "./helpers/anvil.js";
import { deployFixture, type Fixture } from "./helpers/deploy.js";

let anvil: AnvilInstance;
let chain: Chain;
let fixture: Fixture;
let alice: PrivateAgent; // sender with funds
let bob: PrivateAgent; // recipient
let carol: PrivateAgent; // second-hop recipient

beforeAll(async () => {
  anvil = await startAnvil({ chainId: robinhoodTestnet.id });
  chain = { ...robinhoodTestnet, rpcUrls: { default: { http: [anvil.rpcUrl] } } };
  fixture = await deployFixture(anvil.rpcUrl, chain, ANVIL_KEYS[0] as `0x${string}`, privateKeyToAccount(ANVIL_KEYS[4] as `0x${string}`).address);

  const transport = http(anvil.rpcUrl);
  const make = (key: `0x${string}`, seed: string) =>
    createPrivateAgent({
      chain,
      transport,
      account: privateKeyToAccount(key),
      stealthKeys: StealthKeys.fromSeed(seed),
      contracts: { router: fixture.router },
      scan: { fromBlock: 0n },
      pollingInterval: 100,
    });
  alice = make(ANVIL_KEYS[1] as `0x${string}`, "alice-agent-seed-000000");
  bob = make(ANVIL_KEYS[2] as `0x${string}`, "bob-agent-seed-00000000");
  carol = make(ANVIL_KEYS[3] as `0x${string}`, "carol-agent-seed-000000");

  // Mint test tokens to Alice.
  const { createWalletClient } = await import("viem");
  const minter = createWalletClient({ account: privateKeyToAccount(ANVIL_KEYS[0] as `0x${string}`), chain, transport });
  const hash = await minter.writeContract({
    address: fixture.token,
    abi: mockErc20Abi,
    functionName: "mint",
    args: [alice.address as Address, parseEther("1000")],
  });
  await alice.publicClient.waitForTransactionReceipt({ hash });
});

afterAll(() => anvil?.stop());

describe("PrivateAgent on a Robinhood-Chain-like Anvil", () => {
  it("detects the router at its computed address and quotes the 1% fee", async () => {
    expect(await alice.getRouter()).toBe(fixture.router);
    expect(await alice.quoteFee(parseEther("1"))).toBe(parseEther("0.01"));
    const stats = await alice.getStats();
    expect(stats.transactions).toBe(0n);
    expect(stats.feeVault).toBe(fixture.feeVault);
  });

  it("registers and resolves stealth meta-addresses via ERC-6538", async () => {
    await expect(alice.resolve(bob.address as Address)).resolves.toBeNull();
    await bob.register();
    await carol.register();
    const meta = await alice.resolve(bob.address as Address);
    expect(meta).toBe(bob.stealthMetaAddress);
    expect(meta?.startsWith("st:rh-testnet:0x")).toBe(true);
  });

  it("sends ETH privately with an encrypted memo; only Bob can detect and spend it", async () => {
    const result = await alice.send({
      to: bob.address as Address, // resolved through the registry
      amount: parseEther("1"),
      memo: { intent: "pay-for-task", taskId: "task-1" },
    });
    expect(result.mode).toBe("router");
    expect(result.fee).toBe(parseEther("0.01"));
    expect(result.transactionHashes).toHaveLength(1);
    expect(await bob.balanceOf(result.stealthAddress)).toBe(parseEther("1"));
    expect(await bob.balanceOf(fixture.feeVault)).toBe(parseEther("0.01"));
    const stats = await alice.getStats();
    expect(stats.transactions).toBe(1n);
    expect(stats.ethRouted).toBe(parseEther("1"));
    expect(stats.ethFees).toBe(parseEther("0.01"));
    // The stealth address is fresh: it is not Bob's identity wallet.
    expect(isAddressEqual(result.stealthAddress, bob.address as Address)).toBe(false);

    const bobScan = await bob.scan();
    expect(bobScan.payments).toHaveLength(1);
    const payment = bobScan.payments[0]!;
    expect(payment.stealthAddress).toBe(result.stealthAddress);
    expect(payment.token).toBeNull();
    expect(payment.amount).toBe(parseEther("1"));
    expect(payment.memo).toEqual({ kind: "json", value: { intent: "pay-for-task", taskId: "task-1" } });
    expect(payment.caller).toBe(fixture.router);
    expect(bob.stealthAccount(payment).address).toBe(result.stealthAddress);

    // Carol (a different viewing key) sees nothing.
    expect((await carol.scan()).payments).toHaveLength(0);
  });

  it("sends ERC-20 with a gas stipend through the router (approve + send)", async () => {
    const result = await alice.send({
      to: bob.stealthMetaAddress, // direct meta-address, no registry lookup
      token: fixture.token,
      amount: parseEther("25"),
      gasStipend: parseEther("0.01"),
      memo: "settlement for job #7",
    });
    expect(result.mode).toBe("router");
    expect(result.fee).toBe(parseEther("0.25"));
    expect(result.transactionHashes).toHaveLength(2); // approve (amount + fee), sendToken
    expect(await bob.balanceOf(result.stealthAddress, fixture.token)).toBe(parseEther("25"));
    expect(await bob.balanceOf(fixture.feeVault, fixture.token)).toBe(parseEther("0.25"));
    expect(await bob.balanceOf(result.stealthAddress)).toBe(parseEther("0.01"));

    const { payments } = await bob.scan();
    const tokenPayment = payments.find((p) => p.stealthAddress === result.stealthAddress);
    expect(tokenPayment?.token).toBe(fixture.token);
    expect(tokenPayment?.amount).toBe(parseEther("25"));
    expect(tokenPayment?.memo).toEqual({ kind: "text", value: "settlement for job #7" });
  });

  it("lets Bob forward from a stealth address to Carol without touching his identity wallet", async () => {
    const { payments } = await bob.scan();
    const ethPayment = payments.find((p) => p.token === null)!;
    const bobIdentityBalanceBefore = await bob.balanceOf(bob.address as Address);

    const hop = await bob.forward({
      from: ethPayment,
      to: carol.address as Address,
      amount: parseEther("0.4"),
      memo: "subcontract: 40%",
    });
    expect(hop.from).toBe(ethPayment.stealthAddress);
    const tx = await bob.publicClient.getTransaction({ hash: hop.hash });
    expect(isAddressEqual(tx.from, ethPayment.stealthAddress)).toBe(true);
    expect(await bob.balanceOf(bob.address as Address)).toBe(bobIdentityBalanceBefore);

    const carolScan = await carol.scan();
    expect(carolScan.payments).toHaveLength(1);
    expect(carolScan.payments[0]!.amount).toBe(parseEther("0.4"));
    expect(carolScan.payments[0]!.memo).toEqual({ kind: "text", value: "subcontract: 40%" });
    expect(await carol.balanceOf(carolScan.payments[0]!.stealthAddress)).toBe(parseEther("0.4"));
  });

  it("falls back to direct ERC-5564 transactions when the router is disabled", async () => {
    const direct = createPrivateAgent({
      chain,
      transport: http(anvil.rpcUrl),
      account: alice.account,
      stealthKeys: alice.keys,
      contracts: { router: null },
    });
    const result = await direct.send({ to: carol.stealthMetaAddress, amount: parseEther("0.2"), memo: "direct mode" });
    expect(result.mode).toBe("direct");
    expect(result.fee).toBe(0n);
    expect(result.transactionHashes).toHaveLength(2); // transfer, announce

    const tokenResult = await direct.send({
      to: carol.stealthMetaAddress,
      token: fixture.token,
      amount: parseEther("3"),
      gasStipend: parseEther("0.001"),
    });
    expect(tokenResult.transactionHashes).toHaveLength(3); // transfer, stipend, announce

    const { payments } = await carol.scan();
    const found = payments.filter((p) => p.stealthAddress === result.stealthAddress || p.stealthAddress === tokenResult.stealthAddress);
    expect(found).toHaveLength(2);
    expect(found.every((p) => isAddressEqual(p.caller, alice.address as Address))).toBe(true);
    await expect(direct.sendBatch({ payments: [{ to: carol.stealthMetaAddress, amount: 1n }] })).rejects.toThrow(RouterUnavailableError);
  });

  it("batches several payments atomically", async () => {
    const before = (await carol.scan()).payments.length;
    const batch = await alice.sendBatch({
      payments: [
        { to: carol.stealthMetaAddress, amount: parseEther("0.1"), memo: "batch-1" },
        { to: bob.stealthMetaAddress, token: fixture.token, amount: parseEther("2"), gasStipend: parseEther("0.002") },
        { to: carol.stealthMetaAddress, amount: parseEther("0.3") },
      ],
    });
    expect(batch.payments).toHaveLength(3);
    expect(batch.fees["ETH"]).toBe(parseEther("0.004"));
    expect(batch.fees[fixture.token]).toBe(parseEther("0.02"));
    const carolScan = await carol.scan();
    expect(carolScan.payments.length).toBe(before + 2);
    expect(await bob.balanceOf(batch.payments[1]!.stealthAddress, fixture.token)).toBe(parseEther("2"));
  });

  it("watches for new payments in real time", async () => {
    const received: Address[] = [];
    const unwatch = carol.watch({ onPayment: (p) => received.push(p.stealthAddress), fromBlock: await carol.publicClient.getBlockNumber() });
    await new Promise((r) => setTimeout(r, 300));
    const sent = await alice.send({ to: carol.stealthMetaAddress, amount: parseEther("0.05") });
    const deadline = Date.now() + 10_000;
    while (!received.includes(sent.stealthAddress) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    unwatch();
    expect(received).toContain(sent.stealthAddress);
  });

  it("sweeps a stealth address to any destination", async () => {
    const { payments } = await carol.scan();
    const eth = payments.find((p) => p.token === null && p.amount === parseEther("0.4"))!;
    const destination = "0x000000000000000000000000000000000000dEaD" as Address;
    await carol.sweep({ from: eth, to: destination });
    expect(await carol.balanceOf(destination)).toBeGreaterThan(parseEther("0.39"));
    // EIP-1559 sweeps leave a little gas dust (unused gas limit × fee cap) behind.
    expect(await carol.balanceOf(eth.stealthAddress)).toBeLessThan(parseEther("0.0001"));

    const tok = payments.find((p) => p.token === fixture.token)!;
    await carol.sweep({ from: tok, to: destination, token: fixture.token });
    expect(await carol.balanceOf(destination, fixture.token)).toBe(parseEther("3"));
  });

  it("falls back to direct mode when a configured router is missing on chain (auto), but not when forced", async () => {
    const ghost = createPrivateAgent({
      chain,
      transport: http(anvil.rpcUrl),
      account: alice.account,
      stealthKeys: alice.keys,
      contracts: { router: "0x00000000000000000000000000000000000000B1" },
    });
    const result = await ghost.send({ to: carol.stealthMetaAddress, amount: 1n });
    expect(result.mode).toBe("direct");
    await expect(ghost.send({ to: carol.stealthMetaAddress, amount: 1n, mode: "router" })).rejects.toThrow(RouterUnavailableError);
    await expect(ghost.getStats()).rejects.toThrow(RouterUnavailableError);
  });

  it("gives clear errors for unregistered recipients and cursors for incremental scans", async () => {
    await expect(alice.send({ to: "0x00000000000000000000000000000000000000A1", amount: 1n })).rejects.toThrow(RecipientNotRegisteredError);
    const first = await bob.scan();
    const next = await bob.scan({ fromBlock: first.toBlock + 1n });
    expect(next.payments).toHaveLength(0);
    expect(next.fromBlock).toBe(first.toBlock + 1n);
  });
});

describe("adversarial announcements and meta-address hygiene", () => {
  it("marks a spoofed re-announcement as unverified without hiding real funds", async () => {
    const real = await alice.send({ to: bob.stealthMetaAddress, amount: parseEther("0.3") });
    const { createWalletClient: mk } = await import("viem");
    const attacker = mk({ account: privateKeyToAccount(ANVIL_KEYS[4] as `0x${string}`), chain, transport: http(anvil.rpcUrl) });
    const hash = await attacker.writeContract({
      address: fixture.announcer,
      abi: erc5564AnnouncerAbi,
      functionName: "announce",
      args: [1n, real.stealthAddress, real.ephemeralPublicKey, encodeAnnouncementMetadata({ viewTag: real.viewTag, token: null, amount: parseEther("50") })],
    });
    await bob.publicClient.waitForTransactionReceipt({ hash });

    const { payments } = await bob.scan();
    const mine = payments.filter((p) => p.stealthAddress === real.stealthAddress);
    // One payment per stealth address: the router's announcement came first and is the one
    // reported; the attacker's re-announcement only shows up in the count.
    expect(mine).toHaveLength(1);
    const genuine = mine[0]!;
    expect(genuine.amount).toBe(parseEther("0.3"));
    expect(genuine.verified).toBe(true);
    expect(genuine.viaRouter).toBe(true);
    expect(genuine.announcements).toBe(2);
    expect(genuine.balance).toBe(parseEther("0.3"));
    expect(genuine.caller.toLowerCase()).toBe(fixture.router.toLowerCase());
  });

  it("keeps stealth keys out of JSON and refuses a zero scan chunk", async () => {
    const { payments } = await bob.scan();
    const p = payments[0]!;
    expect(p.stealthPrivateKey).toMatch(/^0x[0-9a-f]{64}$/);
    const json = JSON.stringify(p, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(json).not.toContain(p.stealthPrivateKey.slice(2));
    expect(Object.keys(p)).not.toContain("stealthPrivateKey");
    expect(bob.stealthAccount(p).address.toLowerCase()).toBe(p.stealthAddress.toLowerCase());
    await expect(bob.scan({ chunkSize: 0n })).rejects.toThrow(/chunkSize/);
  });

  it("verifies direct ERC-20 announcements only for trusted tokens, and direct ETH against the chain's balance", async () => {
    const direct = createPrivateAgent({ chain, transport: http(anvil.rpcUrl), account: alice.account, stealthKeys: alice.keys, contracts: { router: null } });
    const eth = await direct.send({ to: carol.stealthMetaAddress, amount: parseEther("0.11") });
    const token = await direct.send({ to: carol.stealthMetaAddress, token: fixture.token, amount: parseEther("2") });
    const found = (await carol.scan()).payments;
    const ethPayment = found.find((p) => p.stealthAddress === eth.stealthAddress)!;
    const tokenPayment = found.find((p) => p.stealthAddress === token.stealthAddress)!;
    expect(ethPayment.viaRouter).toBe(false);
    expect(ethPayment.verified).toBe(true);
    expect(tokenPayment.viaRouter).toBe(false);
    expect(tokenPayment.verified).toBe(false); // the token contract is the only witness
    expect(tokenPayment.balance).toBe(parseEther("2"));
    const trusting = createPrivateAgent({ chain, transport: http(anvil.rpcUrl), account: carol.account, stealthKeys: carol.keys, contracts: { router: fixture.router }, scan: { fromBlock: 0n }, trustedTokens: [fixture.token] });
    const trusted = (await trusting.scan()).payments.find((p) => p.stealthAddress === token.stealthAddress)!;
    expect(trusted.verified).toBe(true);
  });

  it("rejects a meta-address that names the other Robinhood network", async () => {
    const wrongNetwork = bob.keys.metaAddress("robinhoodchain"); // agents here run on rh-testnet
    await expect(alice.send({ to: wrongNetwork, amount: 1n })).rejects.toThrow(InvalidStealthMetaAddressError);
    await expect(alice.send({ to: bob.keys.metaAddress("eth"), amount: parseEther("0.001") })).resolves.toMatchObject({ amount: parseEther("0.001") });
  });
});

describe("review findings: evidence, halting, delivery and receipts", () => {
  const announce = async (stealthAddress: Address, ephemeralPublicKey: `0x${string}`, metadata: `0x${string}`) => {
    const { createWalletClient: mk } = await import("viem");
    const attacker = mk({ account: privateKeyToAccount(ANVIL_KEYS[4] as `0x${string}`), chain, transport: http(anvil.rpcUrl) });
    const hash = await attacker.writeContract({ address: fixture.announcer, abi: erc5564AnnouncerAbi, functionName: "announce", args: [1n, stealthAddress, ephemeralPublicKey, metadata] });
    await bob.publicClient.waitForTransactionReceipt({ hash });
  };
  const toBob = (ephemeralPrivateKey: `0x${string}`) => generateStealthAddress({ ...bob.keys.publicKeys, ephemeralPrivateKey });

  it("does not verify an ERC-20 through the router unless the token is trusted", async () => {
    const sent = await alice.send({ to: bob.stealthMetaAddress, token: fixture.token, amount: parseEther("4") });
    const plain = (await bob.scan()).payments.find((p) => p.stealthAddress === sent.stealthAddress)!;
    expect(plain.viaRouter).toBe(true);
    expect(plain.verified).toBe(false);
    const trusting = createPrivateAgent({ chain, transport: http(anvil.rpcUrl), stealthKeys: bob.keys, contracts: { router: fixture.router }, scan: { fromBlock: 0n }, trustedTokens: [fixture.token] });
    expect((await trusting.scan()).payments.find((p) => p.stealthAddress === sent.stealthAddress)!.verified).toBe(true);
  });

  it("keeps scanning past an announcement that names a token with no contract", async () => {
    const s = toBob(`0x${"41".repeat(32)}`);
    await announce(s.stealthAddress, s.ephemeralPublicKey, encodeAnnouncementMetadata({ viewTag: s.viewTag, token: "0x000000000000000000000000000000000000c0DE", amount: 5n }));
    const { payments } = await bob.scan();
    const bad = payments.find((p) => p.stealthAddress === s.stealthAddress)!;
    expect(bad.verified).toBe(false);
    expect(bad.balanceError).toMatch(/Could not read/);
    expect(payments.length).toBeGreaterThan(1);
  });

  it("reports the real payment even when a forged announcement for its address lands first", async () => {
    const ek = `0x${"42".repeat(32)}` as const;
    const s = toBob(ek);
    await announce(s.stealthAddress, s.ephemeralPublicKey, encodeAnnouncementMetadata({ viewTag: s.viewTag, token: fixture.token, amount: 1n }));
    await alice.send({ to: bob.stealthMetaAddress, amount: parseEther("5"), memo: "invoice 8", ephemeralPrivateKey: ek });
    const found = (await bob.scan()).payments.filter((p) => p.stealthAddress === s.stealthAddress);
    expect(found).toHaveLength(1);
    expect(found[0]!.token).toBeNull();
    expect(found[0]!.amount).toBe(parseEther("5"));
    expect(found[0]!.viaRouter).toBe(true);
    expect(found[0]!.verified).toBe(true);
    expect(found[0]!.memo).toEqual({ kind: "text", value: "invoice 8" });
    expect(found[0]!.announcements).toBe(2);
  });

  it("reports a memo in the retired format instead of dropping it silently", async () => {
    const s = toBob(`0x${"43".repeat(32)}`);
    const legacy = new Uint8Array(1 + 24 + 64 + 16);
    legacy[0] = 0x02;
    await announce(s.stealthAddress, s.ephemeralPublicKey, encodeAnnouncementMetadata({ viewTag: s.viewTag, token: null, amount: 1n, memoCiphertext: legacy }));
    const p = (await bob.scan()).payments.find((x) => x.stealthAddress === s.stealthAddress)!;
    expect(p.memo).toBeUndefined();
    expect(p.memoError).toMatch(/retired v2/);
  });

  it("never announces a direct token transfer that did not arrive", async () => {
    // A token whose every call returns 32 zero bytes: transfer() "succeeds" with false, balanceOf is 0.
    const { createWalletClient: mk } = await import("viem");
    const deployer = mk({ account: privateKeyToAccount(ANVIL_KEYS[0] as `0x${string}`), chain, transport: http(anvil.rpcUrl) });
    const hash = await deployer.deployContract({ abi: [], bytecode: "0x6005600c60003960056000f360206000f3" });
    const liar = (await alice.publicClient.waitForTransactionReceipt({ hash })).contractAddress as Address;
    const direct = createPrivateAgent({ chain, transport: http(anvil.rpcUrl), account: alice.account, stealthKeys: alice.keys, contracts: { router: null } });
    const before = (await carol.scan()).payments.length;
    await expect(direct.send({ to: carol.stealthMetaAddress, token: liar, amount: 7n })).rejects.toThrow(TransferNotDeliveredError);
    expect((await carol.scan()).payments.length).toBe(before);
  });

  it("reports a mined-but-reverted transaction as a failure from register, send and sweep", async () => {
    const agent = createPrivateAgent({ chain, transport: http(anvil.rpcUrl), account: alice.account, stealthKeys: alice.keys, contracts: { router: fixture.router } });
    const real = agent.publicClient.waitForTransactionReceipt.bind(agent.publicClient);
    (agent.publicClient as { waitForTransactionReceipt: unknown }).waitForTransactionReceipt = async (args: { hash: `0x${string}` }) => ({ ...(await real(args)), status: "reverted" });
    await expect(agent.register()).rejects.toThrow(TransactionRevertedError);
    await expect(agent.send({ to: bob.stealthMetaAddress, amount: 1n })).rejects.toThrow(TransactionRevertedError);
    const paid = await alice.send({ to: alice.stealthMetaAddress, amount: parseEther("0.01") });
    const mine = (await alice.scan()).payments.find((p) => p.stealthAddress === paid.stealthAddress)!;
    await expect(agent.sweep({ from: mine, to: bob.address as Address })).rejects.toThrow(TransactionRevertedError);
  });
});

