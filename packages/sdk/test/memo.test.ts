import { describe, expect, it } from "vitest";
import { StealthKeys } from "../src/crypto/keys.js";
import { MAX_MEMO_BYTES, decryptMemo, encryptMemo, isMemoCiphertext, type MemoBinding } from "../src/crypto/memo.js";
import { generateStealthAddress } from "../src/crypto/stealth.js";
import { MemoError } from "../src/errors.js";

describe("encrypted memo", () => {
  const keys = StealthKeys.fromSeed("umbra-memo-test-seed-0");
  const sent = generateStealthAddress({
    ...keys.publicKeys,
    ephemeralPrivateKey: "0x2222222222222222222222222222222222222222222222222222222222222222",
  });
  const binding: MemoBinding = { chainId: 4663, viewTag: sent.viewTag, token: null, amount: 250000000000000000n };
  const ctx = { sharedSecret: sent.sharedSecret, stealthAddress: sent.stealthAddress, binding };

  it("round-trips text, bytes and JSON", () => {
    const text = encryptMemo({ ...ctx, memo: "invoice #42 — thanks" });
    expect(isMemoCiphertext(text)).toBe(true);
    expect(decryptMemo({ ...ctx, ciphertext: text })).toEqual({ kind: "text", value: "invoice #42 — thanks" });

    const bytes = encryptMemo({ ...ctx, memo: new Uint8Array([1, 2, 3]) });
    expect(decryptMemo({ ...ctx, ciphertext: bytes })).toEqual({ kind: "bytes", value: new Uint8Array([1, 2, 3]) });

    const json = encryptMemo({ ...ctx, memo: { intent: "settle", taskId: "t-9", items: [1, 2] } });
    expect(decryptMemo({ ...ctx, ciphertext: json })).toEqual({ kind: "json", value: { intent: "settle", taskId: "t-9", items: [1, 2] } });
  });

  it("uses fresh nonces and never leaks plaintext", () => {
    const a = encryptMemo({ ...ctx, memo: "same" });
    const b = encryptMemo({ ...ctx, memo: "same" });
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
    expect(Buffer.from(a).toString("utf8")).not.toContain("same");
  });

  it("fails on tampering, wrong address or wrong secret", () => {
    const ct = encryptMemo({ ...ctx, memo: "secret" });
    const tampered = new Uint8Array(ct);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    expect(() => decryptMemo({ ...ctx, ciphertext: tampered })).toThrow(MemoError);
    expect(() => decryptMemo({ ...ctx, stealthAddress: "0x0000000000000000000000000000000000000001", ciphertext: ct })).toThrow(MemoError);
    const other = StealthKeys.generate();
    const otherSecret = generateStealthAddress({ ...other.publicKeys, ephemeralPrivateKey: "0x3333333333333333333333333333333333333333333333333333333333333333" }).sharedSecret;
    expect(() => decryptMemo({ sharedSecret: otherSecret, stealthAddress: ctx.stealthAddress, binding, ciphertext: ct })).toThrow(MemoError);
    expect(() => decryptMemo({ ...ctx, ciphertext: new Uint8Array([0x09, 1, 2]) })).toThrow(MemoError);
  });

  it("is bound to the chain and the announced figures: a copied memo fails next to any other amount, token, tag or chain", () => {
    const ct = encryptMemo({ ...ctx, memo: "paid in full" });
    expect(decryptMemo({ ...ctx, ciphertext: ct })).toEqual({ kind: "text", value: "paid in full" });
    const other = (patch: Partial<typeof binding>) => decryptMemo({ ...ctx, binding: { ...binding, ...patch }, ciphertext: ct });
    expect(() => other({ amount: 50000000000000000000n })).toThrow(MemoError);
    expect(() => other({ token: "0x1111111111111111111111111111111111111111" })).toThrow(MemoError);
    expect(() => other({ viewTag: (binding.viewTag + 1) & 0xff })).toThrow(MemoError);
    expect(() => other({ chainId: 46630 })).toThrow(MemoError);
  });

  it("enforces the size cap and JSON constraints", () => {
    expect(() => encryptMemo({ ...ctx, memo: new Uint8Array(MAX_MEMO_BYTES + 1) })).toThrow(MemoError);
    expect(() => encryptMemo({ ...ctx, memo: { amount: 1n } })).toThrow(MemoError);
  });
});

describe("memo padding", () => {
  const keys = StealthKeys.fromSeed("umbra-memo-padding-seed-0");
  const sent = generateStealthAddress({ ...keys.publicKeys, ephemeralPrivateKey: "0x4444444444444444444444444444444444444444444444444444444444444444" });
  const ctx = { sharedSecret: sent.sharedSecret, stealthAddress: sent.stealthAddress, binding: { chainId: 46630, viewTag: sent.viewTag, token: null, amount: 1n } };
  const overhead = 1 + 24 + 16; // version + nonce + tag

  it("pads plaintexts to size buckets so only the bucket is visible", () => {
    expect(encryptMemo({ ...ctx, memo: "hi" }).length).toBe(overhead + 64);
    expect(encryptMemo({ ...ctx, memo: "x".repeat(61) }).length).toBe(overhead + 64);
    expect(encryptMemo({ ...ctx, memo: "x".repeat(62) }).length).toBe(overhead + 256);
    expect(encryptMemo({ ...ctx, memo: "x".repeat(1000) }).length).toBe(overhead + 1024);
    expect(decryptMemo({ ...ctx, ciphertext: encryptMemo({ ...ctx, memo: "x".repeat(62) }) })).toEqual({ kind: "text", value: "x".repeat(62) });
    expect(decryptMemo({ ...ctx, ciphertext: encryptMemo({ ...ctx, memo: new Uint8Array(0) }) })).toEqual({ kind: "bytes", value: new Uint8Array(0) });
  });
});
