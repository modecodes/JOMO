/**
 * Stealth meta-address encoding (ERC-5564 / ERC-6538).
 *   URI:   st:<chainShortName>:0x<spendingPubKey(33)><viewingPubKey(33)>
 *   bytes: 0x<spendingPubKey(33)><viewingPubKey(33)>   (the ERC-6538 registry format)
 */
import type { Hex } from "viem";
import { InvalidStealthMetaAddressError } from "../errors.js";
import { assertCompressedPublicKey, toBytes, toHex } from "./secp.js";

/** ERC-3770 short name for Robinhood Chain mainnet (chainid.network). */
export const ROBINHOOD_CHAIN_SHORT_NAME = "robinhoodchain";
/** ERC-3770 short name for Robinhood Chain testnet (chainid.network). */
export const ROBINHOOD_TESTNET_SHORT_NAME = "rh-testnet";

export interface StealthMetaAddress {
  spendingPublicKey: Hex;
  viewingPublicKey: Hex;
}

const URI_RE = /^st:([a-z0-9-]+):(0x[0-9a-fA-F]{132})$/i;
const BYTES_RE = /^0x[0-9a-fA-F]{132}$/;

export function encodeStealthMetaAddressBytes(keys: {
  spendingPublicKey: Hex | Uint8Array;
  viewingPublicKey: Hex | Uint8Array;
}): Hex {
  const spend = toBytes(keys.spendingPublicKey);
  const view = toBytes(keys.viewingPublicKey);
  assertCompressedPublicKey(spend);
  assertCompressedPublicKey(view);
  const out = new Uint8Array(66);
  out.set(spend, 0);
  out.set(view, 33);
  return toHex(out);
}

export function encodeStealthMetaAddress(
  keys: { spendingPublicKey: Hex | Uint8Array; viewingPublicKey: Hex | Uint8Array },
  chainShortName: string = ROBINHOOD_CHAIN_SHORT_NAME,
): string {
  if (!/^[a-z0-9-]+$/i.test(chainShortName)) {
    throw new InvalidStealthMetaAddressError(`Invalid chain short name: ${chainShortName}`);
  }
  return `st:${chainShortName}:${encodeStealthMetaAddressBytes(keys)}`;
}

/** Accepts a `st:<chain>:0x…` URI or the raw 66-byte hex form. */
export function parseStealthMetaAddress(input: string): StealthMetaAddress & { chainShortName?: string } {
  const trimmed = input.trim();
  let raw: string;
  let chainShortName: string | undefined;
  const uri = URI_RE.exec(trimmed);
  if (uri) {
    chainShortName = uri[1];
    raw = uri[2] ?? "";
  } else if (BYTES_RE.test(trimmed)) {
    raw = trimmed;
  } else {
    throw new InvalidStealthMetaAddressError(
      `Expected "st:<chain>:0x<132 hex chars>" or "0x<132 hex chars>", got ${JSON.stringify(input)}`,
    );
  }
  const bytes = toBytes(raw as Hex);
  const spending = bytes.subarray(0, 33);
  const viewing = bytes.subarray(33, 66);
  try {
    assertCompressedPublicKey(spending);
    assertCompressedPublicKey(viewing);
  } catch (cause) {
    throw new InvalidStealthMetaAddressError("Stealth meta-address contains an invalid public key");
  }
  const result: StealthMetaAddress & { chainShortName?: string } = {
    spendingPublicKey: toHex(spending),
    viewingPublicKey: toHex(viewing),
  };
  if (chainShortName !== undefined) result.chainShortName = chainShortName;
  return result;
}

export function isStealthMetaAddress(input: unknown): input is string {
  if (typeof input !== "string") return false;
  try {
    parseStealthMetaAddress(input);
    return true;
  } catch {
    return false;
  }
}
