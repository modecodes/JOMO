import { describe, expect, it } from "vitest";
import { assertTransactionSucceeded } from "../src/client/PrivateAgent.js";
import { TransactionRevertedError } from "../src/errors.js";

describe("mined-but-reverted transactions", () => {
  const hash = `0x${"ab".repeat(32)}` as const;
  it("are reported as failures, never as success", () => {
    expect(() => assertTransactionSucceeded({ status: "success" }, hash, "Payment")).not.toThrow();
    expect(() => assertTransactionSucceeded({ status: "reverted" }, hash, "Payment")).toThrow(TransactionRevertedError);
    try {
      assertTransactionSucceeded({ status: "reverted" }, hash, "Sweep");
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionRevertedError);
      expect((error as TransactionRevertedError).hash).toBe(hash);
      expect((error as TransactionRevertedError).message).toMatch(/Sweep.*reverted/);
    }
  });
});
