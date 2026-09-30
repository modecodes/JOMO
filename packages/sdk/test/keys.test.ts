import { secp256k1 } from "@noble/curves/secp256k1.js";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { StealthKeys, stealthKeyDerivationMessage } from "../src/crypto/keys.js";
import { InvalidKeyError } from "../src/errors.js";

const ACCOUNT = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const MESSAGE = stealthKeyDerivationMessage(4663);
/** This wallet's meta-address on 46630 under the v1 derivation, computed independently of the SDK. */
const PINNED_META_ADDRESS =
  "st:rh-testnet:0x03cafabc85554b6a2d749c7ed5664b11417ad8d2a5c478bf384d3b56142ca2a46b02d4b2725e37c707abfd22a1903cec669f87e276060ebed6c39ec67fdbcbc53550";

describe("StealthKeys", () => {
  it("generates distinct valid key pairs", () => {
    const a = StealthKeys.generate();
    const b = StealthKeys.generate();
    expect(a.spendingPrivateKey).not.toBe(b.spendingPrivateKey);
    expect(a.spendingPublicKey).toMatch(/^0x0[23][0-9a-f]{64}$/);
    expect(a.viewingPublicKey).toMatch(/^0x0[23][0-9a-f]{64}$/);
  });

  it("derives deterministically from a real signature and from a seed", async () => {
    const sig = await ACCOUNT.signMessage({ message: MESSAGE });
    expect(StealthKeys.fromSignature(sig).spendingPrivateKey).toBe(StealthKeys.fromSignature(sig).spendingPrivateKey);
    expect(StealthKeys.fromSignature(sig, { message: MESSAGE, signer: ACCOUNT.address }).viewingPrivateKey).toBe(StealthKeys.fromSignature(sig).viewingPrivateKey);
    expect(StealthKeys.fromSeed("seed-number-one-0000").viewingPrivateKey).toBe(StealthKeys.fromSeed("seed-number-one-0000").viewingPrivateKey);
    expect(StealthKeys.fromSeed("seed-number-one-0000").viewingPrivateKey).not.toBe(StealthKeys.fromSeed("seed-number-two-0000").viewingPrivateKey);
    expect(() => StealthKeys.fromSignature("0x1234")).toThrow(InvalidKeyError);
    expect(() => StealthKeys.fromSeed("short")).toThrow(InvalidKeyError);
  });

  it("derives the same keys as v1 for an existing wallet, so registered meta-addresses stay valid", async () => {
    // Pinned from the v1 derivation (keccak(r) → spending, keccak(s) → viewing). If this changes,
    // every agent that already registered would stop seeing its payments.
    const keys = await StealthKeys.fromAccount(ACCOUNT, { chainId: 46630 });
    expect(keys.metaAddress("rh-testnet")).toBe(PINNED_META_ADDRESS);
  });

  it("refuses a contract wallet's 65-byte marker even without the message", () => {
    // Safe-style contract signature: owner address padded into r, a small offset in s, v = 0 or 27.
    const padded = `${"00".repeat(12)}${ACCOUNT.address.slice(2).toLowerCase()}`;
    for (const v of ["00", "1b"]) {
      const marker = `0x${padded}${"00".repeat(31)}41${v}` as const;
      expect(() => StealthKeys.fromSignature(marker)).toThrow(/not an ECDSA signature/);
    }
  });

  it("refuses signatures that are not canonical ECDSA signatures over the message", async () => {
    const sig = await ACCOUNT.signMessage({ message: MESSAGE });
    const bytes = Buffer.from(sig.slice(2), "hex");
    // The same signature with s replaced by n - s (and the recovery bit flipped) is the same
    // statement in a different encoding; it must be refused, not silently turned into other keys.
    const n = secp256k1.Point.Fn.ORDER;
    const s = BigInt(`0x${bytes.subarray(32, 64).toString("hex")}`);
    const high = Buffer.concat([bytes.subarray(0, 32), Buffer.from((n - s).toString(16).padStart(64, "0"), "hex"), Buffer.from([bytes[64] === 27 ? 28 : 27])]);
    expect(() => StealthKeys.fromSignature(`0x${high.toString("hex")}`)).toThrow(/canonical/);
    // A different wallet's signature over the same message must not pass as this wallet's.
    const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    const theirs = await other.signMessage({ message: MESSAGE });
    expect(() => StealthKeys.fromSignature(theirs, { message: MESSAGE, signer: ACCOUNT.address })).toThrow(/not by/);
    // A contract wallet's 65-byte marker (an address padded into r, a tiny s) is not a signature.
    const marker = `0x${"00".repeat(12)}${ACCOUNT.address.slice(2).toLowerCase()}${"00".repeat(31)}011b` as const;
    expect(() => StealthKeys.fromSignature(marker, { message: MESSAGE, signer: ACCOUNT.address })).toThrow(InvalidKeyError);
    // The signer cannot be checked without the message.
    expect(() => StealthKeys.fromSignature(sig, { signer: ACCOUNT.address })).toThrow(InvalidKeyError);
    // Signatures of the wrong length or recovery id are refused.
    expect(() => StealthKeys.fromSignature(`0x${bytes.subarray(0, 64).toString("hex")}05`)).toThrow(InvalidKeyError);
  });

  it("derives from a wallet signature (same wallet + chain → same keys), checking the signer", async () => {
    const account = ACCOUNT;
    const a = await StealthKeys.fromAccount(account, { chainId: 4663 });
    const b = await StealthKeys.fromAccount(account, { chainId: 4663 });
    const c = await StealthKeys.fromAccount(account, { chainId: 46630 });
    expect(a.spendingPrivateKey).toBe(b.spendingPrivateKey);
    expect(a.spendingPrivateKey).not.toBe(c.spendingPrivateKey);
    expect(stealthKeyDerivationMessage(4663)).toContain("Chain ID: 4663");
  });

  it("round-trips private keys and redacts them from JSON", () => {
    const keys = StealthKeys.generate();
    const again = StealthKeys.fromPrivateKeys(keys.toPrivateKeys());
    expect(again.metaAddressBytes).toBe(keys.metaAddressBytes);
    expect(JSON.stringify(keys)).not.toContain(keys.spendingPrivateKey.slice(2));
    expect(JSON.parse(JSON.stringify(keys))).toEqual(keys.publicKeys);
  });
});

describe("StealthKeys.fromAccount determinism and identity checks", () => {
  it("refuses a signer whose signatures differ between calls", async () => {
    let n = 0;
    const flaky = { address: ACCOUNT.address, signMessage: async () => `0x${(n++).toString(16).padStart(128, "a")}1b` as `0x${string}` };
    await expect(StealthKeys.fromAccount(flaky, { chainId: 4663 })).rejects.toThrow(/deterministic/);
  });

  it("checks the signer for a WalletClient-shaped signer, and refuses a signer with no address", async () => {
    const walletLike = { account: { address: ACCOUNT.address }, signMessage: (args: { message: string }) => ACCOUNT.signMessage(args) };
    const viaWallet = await StealthKeys.fromAccount(walletLike, { chainId: 46630 });
    expect(viaWallet.metaAddress("rh-testnet")).toBe(PINNED_META_ADDRESS);
    const anonymous = { signMessage: (args: { message: string }) => ACCOUNT.signMessage(args) };
    await expect(StealthKeys.fromAccount(anonymous, { chainId: 46630 })).rejects.toThrow(/exposes its address/);
    const lying = { account: { address: "0x000000000000000000000000000000000000dEaD" as const }, signMessage: (args: { message: string }) => ACCOUNT.signMessage(args) };
    await expect(StealthKeys.fromAccount(lying, { chainId: 46630 })).rejects.toThrow(/not by/);
  });

  it("refuses a signer that hands back a signature made by someone else, or no signature at all", async () => {
    const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
    const impostor = { address: ACCOUNT.address, signMessage: (args: { message: string }) => other.signMessage(args) };
    await expect(StealthKeys.fromAccount(impostor, { chainId: 4663 })).rejects.toThrow(/not by/);
    const junk = { address: ACCOUNT.address, signMessage: async () => `0x${"a".repeat(128)}1b` as `0x${string}` };
    await expect(StealthKeys.fromAccount(junk, { chainId: 4663 })).rejects.toThrow(InvalidKeyError);
  });
});
