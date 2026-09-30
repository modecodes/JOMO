/**
 * ERC-5564 announcement metadata.
 *
 * Standard layout (57 bytes), followed by an optional JOMO extension:
 *   [0]      view tag
 *   [1..4]   0xeeeeeeee for native ETH, or the ERC-20 `transfer` selector 0xa9059cbb
 *   [5..24]  token address (0xEeee…EEeE placeholder for ETH)
 *   [25..56] amount (uint256, big-endian)
 *   [57..]   extension — currently an encrypted memo (see memo.ts) or empty
 *
 * Decoding is tolerant: announcements written by other ERC-5564 integrators may carry only the view
 * tag, and everything beyond byte 0 is treated as optional.
 */
import { getAddress, isAddressEqual, type Address, type Hex } from "viem";
import { isMemoCiphertext } from "./memo.js";
import { ERC20_TRANSFER_SELECTOR, ETH_SELECTOR, ETH_TOKEN_PLACEHOLDER, STANDARD_METADATA_LENGTH, encodeStandardPrefix } from "./prefix.js";
import { bytesToBigInt, toBytes, toHex } from "./secp.js";

export { ERC20_TRANSFER_SELECTOR, ETH_SELECTOR, ETH_TOKEN_PLACEHOLDER, STANDARD_METADATA_LENGTH } from "./prefix.js";

export interface EncodeMetadataParams {
  viewTag: number;
  /** ERC-20 token address, or `null` for native ETH. */
  token: Address | null;
  amount: bigint;
  /** Output of `encryptMemo`. */
  memoCiphertext?: Uint8Array | undefined;
}

export interface AnnouncementMetadata {
  viewTag: number;
  /** `null` = native ETH, `undefined` = announcement did not use the standard layout. */
  token: Address | null | undefined;
  amount: bigint | undefined;
  memoCiphertext: Uint8Array | undefined;
  /** Raw bytes after the standard prefix (or after the view tag for short metadata). */
  extension: Uint8Array;
}

export function encodeAnnouncementMetadata(params: EncodeMetadataParams): Hex {
  const memo = params.memoCiphertext ?? new Uint8Array(0);
  const out = new Uint8Array(STANDARD_METADATA_LENGTH + memo.length);
  out.set(encodeStandardPrefix({ viewTag: params.viewTag, token: params.token, amount: params.amount }), 0);
  out.set(memo, STANDARD_METADATA_LENGTH);
  return toHex(out);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function decodeAnnouncementMetadata(metadata: Hex | Uint8Array): AnnouncementMetadata {
  const bytes = toBytes(metadata);
  if (bytes.length === 0) throw new RangeError("metadata must contain at least the view tag");
  const viewTag = bytes[0] ?? 0;

  let token: Address | null | undefined;
  let amount: bigint | undefined;
  let extension: Uint8Array;

  const selector = bytes.subarray(1, 5);
  const isStandard =
    bytes.length >= STANDARD_METADATA_LENGTH &&
    (bytesEqual(selector, ETH_SELECTOR) || bytesEqual(selector, ERC20_TRANSFER_SELECTOR));

  if (isStandard) {
    const tokenAddress = getAddress(toHex(bytes.subarray(5, 25)));
    token = bytesEqual(selector, ETH_SELECTOR) || isAddressEqual(tokenAddress, ETH_TOKEN_PLACEHOLDER) ? null : tokenAddress;
    amount = bytesToBigInt(bytes.subarray(25, STANDARD_METADATA_LENGTH));
    extension = bytes.subarray(STANDARD_METADATA_LENGTH);
  } else {
    extension = bytes.subarray(1);
  }

  const memoCiphertext = isMemoCiphertext(extension) ? extension : undefined;
  return { viewTag, token, amount, memoCiphertext, extension };
}
