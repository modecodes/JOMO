/**
 * Strict amount parsing. The model must state a unit; bare numbers are rejected so "0.25" can never
 * silently become 0.25 wei or 0.25 ETH by accident.
 *
 *   "0.25 ETH"                 native
 *   { value: "40", unit: "USDC" }  token (unit must match the token's on-chain symbol, case-insensitive)
 *   "40 tokens"                token (generic unit, decimals from the token)
 */
import { formatUnits, parseUnits } from "viem";

export interface ParsedAmount {
  value: bigint;
  unit: string;
  decimals: number;
}

export type AmountInput = string | { value: string | number; unit: string };

export class AmountFormatError extends Error {
  readonly code = "AMOUNT_FORMAT";
  constructor(message: string) {
    super(message);
    this.name = "AmountFormatError";
  }
}

const NATIVE_UNITS = new Set(["eth", "ether"]);
const GENERIC_TOKEN_UNITS = new Set(["token", "tokens"]);

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

function split(input: AmountInput): { value: string; unit: string } {
  if (typeof input === "string") {
    const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s+([A-Za-z][A-Za-z0-9.-]{0,15})\s*$/.exec(input);
    if (!m || !m[1] || !m[2]) {
      throw new AmountFormatError(`Amount must be "<number> <unit>", e.g. "0.25 ETH" or "40 USDC"; got ${JSON.stringify(input)}`);
    }
    return { value: m[1], unit: m[2] };
  }
  if (input && typeof input === "object" && "unit" in input) {
    // A JSON number above 2^53, or one written in exponent form, has already lost digits before it
    // arrives: refuse it rather than pay a rounded amount.
    const digits = typeof input.value === "number" ? String(input.value).replace(/^-|\./g, "").replace(/^0+/, "").length : 0;
    if (typeof input.value === "number" && (!Number.isFinite(input.value) || Math.abs(input.value) >= 2 ** 53 || /e/i.test(String(input.value)) || digits > 15)) {
      throw new AmountFormatError(`Amount ${String(input.value)} cannot be represented exactly as a number; pass it as a string, e.g. { "value": "12345678901234567890", "unit": "${input.unit}" }`);
    }
    const value = typeof input.value === "number" ? String(input.value) : input.value;
    if (typeof value !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) throw new AmountFormatError(`Amount value must be a decimal string; got ${JSON.stringify(input.value)}`);
    if (typeof input.unit !== "string" || !input.unit) throw new AmountFormatError("Amount unit is required");
    return { value, unit: input.unit };
  }
  throw new AmountFormatError("Amount must be a string like \"0.25 ETH\" or an object { value, unit }");
}

/** Parse a native ETH amount. */
export function parseNativeAmount(input: AmountInput): ParsedAmount {
  const { value, unit } = split(input);
  if (!NATIVE_UNITS.has(unit.toLowerCase())) throw new AmountFormatError(`Native amounts must be in ETH; got unit "${unit}". Pass a token address to pay in a token.`);
  const wei = parseUnits(value, 18);
  if (wei <= 0n) throw new AmountFormatError("Amount must be positive");
  return { value: wei, unit: "ETH", decimals: 18 };
}

/** Parse a token amount against the token's on-chain symbol and decimals. */
export function parseTokenAmount(input: AmountInput, token: TokenInfo): ParsedAmount {
  const { value, unit } = split(input);
  const u = unit.toLowerCase();
  if (NATIVE_UNITS.has(u)) throw new AmountFormatError(`This payment is in ${token.symbol}; the amount unit "${unit}" is ETH. Remove the token to pay in ETH.`);
  if (!GENERIC_TOKEN_UNITS.has(u) && u !== token.symbol.toLowerCase()) {
    throw new AmountFormatError(`Amount unit "${unit}" does not match the token symbol "${token.symbol}"`);
  }
  const base = parseUnits(value, token.decimals);
  if (base <= 0n) throw new AmountFormatError("Amount must be positive");
  return { value: base, unit: token.symbol, decimals: token.decimals };
}

export function formatAmount(value: bigint, decimals: number, unit: string): string {
  return `${formatUnits(value, decimals)} ${unit}`;
}
