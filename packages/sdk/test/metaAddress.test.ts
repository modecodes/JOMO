import { describe, expect, it } from "vitest";
import { StealthKeys } from "../src/crypto/keys.js";
import {
  ROBINHOOD_CHAIN_SHORT_NAME,
  encodeStealthMetaAddress,
  encodeStealthMetaAddressBytes,
  isStealthMetaAddress,
  parseStealthMetaAddress,
} from "../src/crypto/metaAddress.js";
import { InvalidStealthMetaAddressError } from "../src/errors.js";

describe("stealth meta-address", () => {
  const keys = StealthKeys.fromSeed("umbra-meta-address-test");

  it("encodes the ERC-6538 byte form (66 bytes)", () => {
    const bytes = encodeStealthMetaAddressBytes(keys.publicKeys);
    expect(bytes).toMatch(/^0x[0-9a-f]{132}$/);
    expect(bytes).toBe(`${keys.spendingPublicKey}${keys.viewingPublicKey.slice(2)}`);
  });

  it("encodes and parses the URI form", () => {
    const uri = encodeStealthMetaAddress(keys.publicKeys);
    expect(uri.startsWith(`st:${ROBINHOOD_CHAIN_SHORT_NAME}:0x`)).toBe(true);
    const parsed = parseStealthMetaAddress(uri);
    expect(parsed.spendingPublicKey).toBe(keys.spendingPublicKey);
    expect(parsed.viewingPublicKey).toBe(keys.viewingPublicKey);
    expect(parsed.chainShortName).toBe(ROBINHOOD_CHAIN_SHORT_NAME);
  });

  it("parses the raw byte form and custom chain names", () => {
    expect(parseStealthMetaAddress(keys.metaAddressBytes).spendingPublicKey).toBe(keys.spendingPublicKey);
    expect(parseStealthMetaAddress(keys.metaAddress("rh-testnet")).chainShortName).toBe("rh-testnet");
    expect(keys.metaAddress("rh-testnet")).toBe(`st:rh-testnet:${keys.metaAddressBytes}`);
  });

  it("rejects malformed input", () => {
    expect(() => parseStealthMetaAddress("st:eth:0x1234")).toThrow(InvalidStealthMetaAddressError);
    expect(() => parseStealthMetaAddress("0x" + "00".repeat(66))).toThrow(InvalidStealthMetaAddressError);
    expect(() => parseStealthMetaAddress("0x1234567890123456789012345678901234567890")).toThrow(InvalidStealthMetaAddressError);
    expect(() => encodeStealthMetaAddress(keys.publicKeys, "bad chain")).toThrow(InvalidStealthMetaAddressError);
    expect(isStealthMetaAddress(keys.metaAddress())).toBe(true);
    expect(isStealthMetaAddress("0x1234567890123456789012345678901234567890")).toBe(false);
    expect(isStealthMetaAddress(42)).toBe(false);
  });
});
