import {
  VALID_SCHEME_ID,
  checkStealthAddress as oracleCheck,
  computeStealthKey as oracleComputeKey,
  generateStealthAddress as oracleGenerate,
} from "@scopelift/stealth-address-sdk";
import { isAddressEqual } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { StealthKeys } from "../src/crypto/keys.js";
import { hexToBytesStrict } from "./helpers/bytes.js";
import { checkStealthAddress, computeStealthKey, deriveSharedSecret, generateStealthAddress } from "../src/crypto/stealth.js";
import { toHex } from "../src/crypto/secp.js";

describe("ERC-5564 scheme 1", () => {
  it("round-trips: sender derives, recipient detects and spends", () => {
    const keys = StealthKeys.generate();
    const sent = generateStealthAddress(keys.publicKeys);

    const check = checkStealthAddress({
      stealthAddress: sent.stealthAddress,
      ephemeralPublicKey: sent.ephemeralPublicKey,
      viewingPrivateKey: keys.viewingPrivateKey,
      spendingPublicKey: keys.spendingPublicKey,
      viewTag: sent.viewTag,
    });
    expect(check.matches).toBe(true);
    expect(check.sharedSecret).toEqual(sent.sharedSecret);

    const stealthKey = computeStealthKey({
      ephemeralPublicKey: sent.ephemeralPublicKey,
      viewingPrivateKey: keys.viewingPrivateKey,
      spendingPrivateKey: keys.spendingPrivateKey,
    });
    expect(isAddressEqual(privateKeyToAccount(stealthKey).address, sent.stealthAddress)).toBe(true);
  });

  it("is deterministic for a fixed ephemeral key", () => {
    const keys = StealthKeys.fromSeed("umbra-test-seed-000001");
    const eph = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const a = generateStealthAddress({ ...keys.publicKeys, ephemeralPrivateKey: eph });
    const b = generateStealthAddress({ ...keys.publicKeys, ephemeralPrivateKey: eph });
    expect(a.stealthAddress).toBe(b.stealthAddress);
    expect(a.ephemeralPublicKey).toBe(b.ephemeralPublicKey);
    expect(a.viewTag).toBe(b.viewTag);
  });

  it("does not match with a different viewing key or wrong view tag", () => {
    const keys = StealthKeys.generate();
    const other = StealthKeys.generate();
    const sent = generateStealthAddress(keys.publicKeys);
    expect(
      checkStealthAddress({
        stealthAddress: sent.stealthAddress,
        ephemeralPublicKey: sent.ephemeralPublicKey,
        viewingPrivateKey: other.viewingPrivateKey,
        spendingPublicKey: keys.spendingPublicKey,
      }).matches,
    ).toBe(false);
    expect(
      checkStealthAddress({
        stealthAddress: sent.stealthAddress,
        ephemeralPublicKey: sent.ephemeralPublicKey,
        viewingPrivateKey: keys.viewingPrivateKey,
        spendingPublicKey: keys.spendingPublicKey,
        viewTag: (sent.viewTag + 1) % 256,
      }).matches,
    ).toBe(false);
  });

  it("rejects malformed ephemeral keys without throwing", () => {
    const keys = StealthKeys.generate();
    expect(
      checkStealthAddress({
        stealthAddress: "0x0000000000000000000000000000000000000001",
        ephemeralPublicKey: "0x0102",
        viewingPrivateKey: keys.viewingPrivateKey,
        spendingPublicKey: keys.spendingPublicKey,
      }).matches,
    ).toBe(false);
  });

  it("shared secret is symmetric", () => {
    const keys = StealthKeys.generate();
    const sent = generateStealthAddress(keys.publicKeys);
    const recipientSide = deriveSharedSecret(keys.viewingPrivateKey, sent.ephemeralPublicKey);
    expect(toHex(recipientSide)).toBe(toHex(sent.sharedSecret));
  });

  it("agrees with the ScopeLift reference implementation (100 random cases)", () => {
    for (let i = 0; i < 100; i++) {
      const keys = StealthKeys.generate();
      const ours = generateStealthAddress(keys.publicKeys);
      const ephemeralPrivateKey = hexToBytesStrict(ours.ephemeralPrivateKey);
      const uri = `st:eth:${keys.metaAddressBytes}`;

      const ref = oracleGenerate({ stealthMetaAddressURI: uri, schemeId: VALID_SCHEME_ID.SCHEME_ID_1, ephemeralPrivateKey });
      expect(ref.stealthAddress.toLowerCase()).toBe(ours.stealthAddress.toLowerCase());
      expect(ref.ephemeralPublicKey.toLowerCase()).toBe(ours.ephemeralPublicKey.toLowerCase());
      expect(ref.viewTag.toLowerCase()).toBe(`0x${ours.viewTag.toString(16).padStart(2, "0")}`);

      const refMatches = oracleCheck({
        ephemeralPublicKey: ours.ephemeralPublicKey,
        spendingPublicKey: keys.spendingPublicKey,
        userStealthAddress: ours.stealthAddress,
        viewingPrivateKey: keys.viewingPrivateKey,
        viewTag: ref.viewTag,
        schemeId: VALID_SCHEME_ID.SCHEME_ID_1,
      });
      expect(refMatches).toBe(true);

      const refKey = oracleComputeKey({
        ephemeralPublicKey: ours.ephemeralPublicKey,
        spendingPrivateKey: keys.spendingPrivateKey,
        viewingPrivateKey: keys.viewingPrivateKey,
        schemeId: VALID_SCHEME_ID.SCHEME_ID_1,
      });
      const ourKey = computeStealthKey({
        ephemeralPublicKey: ours.ephemeralPublicKey,
        spendingPrivateKey: keys.spendingPrivateKey,
        viewingPrivateKey: keys.viewingPrivateKey,
      });
      expect(refKey.toLowerCase()).toBe(ourKey.toLowerCase());
    }
  });
});
