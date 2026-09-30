import { describe, expect, it } from "vitest";
import { AmountFormatError, formatAmount, parseNativeAmount, parseTokenAmount } from "../src/amounts.js";

const usdc = { symbol: "USDC", decimals: 6 };

describe("amount parsing", () => {
  it("parses native amounts with a unit", () => {
    expect(parseNativeAmount("0.25 ETH").value).toBe(250_000_000_000_000_000n);
    expect(parseNativeAmount({ value: "1", unit: "ether" }).value).toBe(10n ** 18n);
    expect(parseNativeAmount({ value: 0.5, unit: "ETH" }).value).toBe(5n * 10n ** 17n);
  });

  it("rejects bare numbers, missing units and wrong units", () => {
    expect(() => parseNativeAmount("0.25")).toThrow(AmountFormatError);
    expect(() => parseNativeAmount("0.25 USDC")).toThrow(AmountFormatError);
    expect(() => parseNativeAmount("0 ETH")).toThrow(AmountFormatError);
    expect(() => parseNativeAmount("-1 ETH")).toThrow(AmountFormatError);
    expect(() => parseNativeAmount({ value: "abc", unit: "ETH" })).toThrow(AmountFormatError);
    expect(() => parseNativeAmount(42 as unknown as string)).toThrow(AmountFormatError);
  });

  it("parses token amounts against symbol and decimals", () => {
    expect(parseTokenAmount("40 USDC", usdc).value).toBe(40_000_000n);
    expect(parseTokenAmount("40 usdc", usdc).value).toBe(40_000_000n);
    expect(parseTokenAmount("40 tokens", usdc).value).toBe(40_000_000n);
    expect(() => parseTokenAmount("40 ETH", usdc)).toThrow(AmountFormatError);
    expect(() => parseTokenAmount("40 DAI", usdc)).toThrow(AmountFormatError);
  });

  it("formats", () => {
    expect(formatAmount(250_000_000_000_000_000n, 18, "ETH")).toBe("0.25 ETH");
    expect(formatAmount(40_000_000n, 6, "USDC")).toBe("40 USDC");
  });
});
