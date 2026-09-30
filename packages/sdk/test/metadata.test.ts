import { describe, expect, it } from "vitest";
import { StealthKeys } from "../src/crypto/keys.js";
import { encryptMemo } from "../src/crypto/memo.js";
import { ETH_TOKEN_PLACEHOLDER, decodeAnnouncementMetadata, encodeAnnouncementMetadata } from "../src/crypto/metadata.js";
import { generateStealthAddress } from "../src/crypto/stealth.js";

describe("announcement metadata", () => {
  const token = "0x1111111111111111111111111111111111111111" as const;

  it("encodes the 57-byte standard layout for ETH", () => {
    const hex = encodeAnnouncementMetadata({ viewTag: 0xab, token: null, amount: 10n ** 18n });
    expect(hex.length).toBe(2 + 57 * 2);
    expect(hex.slice(2, 4)).toBe("ab");
    expect(hex.slice(4, 12)).toBe("eeeeeeee");
    expect(hex.slice(12, 52).toLowerCase()).toBe(ETH_TOKEN_PLACEHOLDER.slice(2).toLowerCase());
    const decoded = decodeAnnouncementMetadata(hex);
    expect(decoded).toMatchObject({ viewTag: 0xab, token: null, amount: 10n ** 18n, memoCiphertext: undefined });
    expect(decoded.extension.length).toBe(0);
  });

  it("encodes ERC-20 payments with the transfer selector", () => {
    const hex = encodeAnnouncementMetadata({ viewTag: 1, token, amount: 5n });
    expect(hex.slice(4, 12)).toBe("a9059cbb");
    expect(decodeAnnouncementMetadata(hex)).toMatchObject({ viewTag: 1, token, amount: 5n });
  });

  it("carries an encrypted memo in the extension", () => {
    const keys = StealthKeys.generate();
    const sent = generateStealthAddress(keys.publicKeys);
    const memoCiphertext = encryptMemo({ sharedSecret: sent.sharedSecret, stealthAddress: sent.stealthAddress, binding: { chainId: 46630, viewTag: 7, token: null, amount: 1n }, memo: "hi" });
    const hex = encodeAnnouncementMetadata({ viewTag: sent.viewTag, token: null, amount: 1n, memoCiphertext });
    const decoded = decodeAnnouncementMetadata(hex);
    expect(decoded.memoCiphertext).toEqual(memoCiphertext);
  });

  it("tolerates non-standard metadata from other integrators", () => {
    expect(decodeAnnouncementMetadata("0x7f")).toMatchObject({ viewTag: 0x7f, token: undefined, amount: undefined });
    expect(decodeAnnouncementMetadata("0x7f0102")).toMatchObject({ viewTag: 0x7f, extension: new Uint8Array([1, 2]) });
    expect(() => decodeAnnouncementMetadata("0x")).toThrow(RangeError);
    expect(() => encodeAnnouncementMetadata({ viewTag: 256, token: null, amount: 1n })).toThrow(RangeError);
    expect(() => encodeAnnouncementMetadata({ viewTag: 0, token: null, amount: 1n << 256n })).toThrow(RangeError);
  });
});
