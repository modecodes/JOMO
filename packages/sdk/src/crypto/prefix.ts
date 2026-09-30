/**
 * The 57-byte standard ERC-5564 metadata prefix JOMO writes on every announcement:
 *   [0]      view tag
 *   [1..4]   0xeeeeeeee for native ETH, or the ERC-20 `transfer` selector 0xa9059cbb
 *   [5..24]  token address (0xEeee…EEeE placeholder for ETH)
 *   [25..56] amount (uint256, big-endian)
 * Shared by the metadata codec and the memo cipher (which binds a memo to this prefix).
 */
import type { Address } from "viem";
import { toBytes } from "./secp.js";

export const ETH_TOKEN_PLACEHOLDER: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const ETH_SELECTOR = new Uint8Array([0xee, 0xee, 0xee, 0xee]);
export const ERC20_TRANSFER_SELECTOR = new Uint8Array([0xa9, 0x05, 0x9c, 0xbb]);
export const STANDARD_METADATA_LENGTH = 57;

export function bigintToBytes32(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n) throw new RangeError("amount must fit in uint256");
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export interface StandardPrefix {
  viewTag: number;
  /** ERC-20 token address, or `null` for native ETH. */
  token: Address | null;
  amount: bigint;
}

export function encodeStandardPrefix(p: StandardPrefix): Uint8Array {
  if (!Number.isInteger(p.viewTag) || p.viewTag < 0 || p.viewTag > 255) throw new RangeError("viewTag must be a byte");
  const out = new Uint8Array(STANDARD_METADATA_LENGTH);
  out[0] = p.viewTag;
  out.set(p.token === null ? ETH_SELECTOR : ERC20_TRANSFER_SELECTOR, 1);
  out.set(toBytes(p.token ?? ETH_TOKEN_PLACEHOLDER), 5);
  out.set(bigintToBytes32(p.amount), 25);
  return out;
}
