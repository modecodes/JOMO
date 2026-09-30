import { describe, expect, it } from "vitest";
import { toBytes } from "../src/crypto/secp.js";
import { InvalidKeyError } from "../src/errors.js";

describe("secret hygiene", () => {
  it("never echoes a malformed hex value, which may be a private key", () => {
    const almostAKey = `0x${"ab".repeat(31)}c` as const;
    expect(() => toBytes(almostAKey)).toThrow(InvalidKeyError);
    try {
      toBytes(almostAKey);
    } catch (error) {
      expect((error as Error).message).not.toContain("abab");
    }
    try {
      toBytes(`0x${"zz".repeat(32)}`);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidKeyError);
      expect((error as Error).message).not.toContain("zz");
    }
  });
});
