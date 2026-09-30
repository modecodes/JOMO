/**
 * Encrypted agent-to-agent memos.
 *
 * The sender already shares an ECDH secret with the recipient (the one used to derive the stealth
 * address). We derive a one-time memo key from it with HKDF-SHA256 and seal the memo with
 * XChaCha20-Poly1305. The associated data binds the ciphertext to the stealth address, the chain
 * and the announced figures (view tag, selector, token, amount), so a memo copied from a real
 * announcement fails to open next to any other amount, token or chain: it cannot be re-announced
 * as evidence for a payment that did not happen.
 *
 *   key        = HKDF-SHA256(ikm = sharedSecret, salt = "jomo/memo/v1", info = stealthAddress, 32)
 *   aad        = stealthAddress(20) || chainId(8, big-endian) || standard metadata prefix(57)
 *   ciphertext = 0x03 || nonce(24) || XChaCha20-Poly1305(key, nonce, plaintext, aad)
 *   plaintext  = kind(1) || len(2) || payload || zero padding to a size bucket
 *                kind: 0x00 bytes | 0x01 utf-8 text | 0x02 JSON
 *
 * Only the recipient's viewing key holder can decrypt. The size *bucket* (64 / 256 / 1024 / 4096 /
 * 8 KiB) is public; the exact length is not.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { Address } from "viem";
import { MemoError } from "../errors.js";
import { encodeStandardPrefix, type StandardPrefix } from "./prefix.js";
import { toBytes } from "./secp.js";

export const MEMO_VERSION = 0x03;
/** Plaintexts are padded to the smallest of these sizes, so only the bucket leaks, not the length. */
export const MEMO_BUCKETS: readonly number[] = [64, 256, 1024, 4096, 8192 + 3];
export const MEMO_NONCE_LENGTH = 24;
export const MEMO_TAG_LENGTH = 16;
/** Ciphertexts below this size cannot be a padded v2 memo. */
export const MEMO_MIN_CIPHERTEXT = 1 + 24 + 64 + 16;
/** Soft cap to keep announcement calldata reasonable. */
export const MAX_MEMO_BYTES = 8192;
const MEMO_SALT = utf8ToBytes("jomo/memo/v1");

const enum MemoKind {
  Bytes = 0x00,
  Text = 0x01,
  Json = 0x02,
}

/** What callers can attach to a payment. Objects/arrays are JSON-encoded (no bigint support). */
export type MemoInput = string | Uint8Array | Record<string, unknown> | unknown[];

export type Memo =
  | { kind: "text"; value: string }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "json"; value: unknown };

export function deriveMemoKey(sharedSecret: Uint8Array, stealthAddress: Address): Uint8Array {
  return hkdf(sha256, sharedSecret, MEMO_SALT, toBytes(stealthAddress), 32);
}

/** What a memo is bound to: the chain it was announced on and the figures announced next to it. */
export interface MemoBinding extends StandardPrefix {
  chainId: number;
}

/** Associated data: stealth address, chain id and the standard metadata prefix the memo travels with. */
export function memoAssociatedData(stealthAddress: Address, binding: MemoBinding): Uint8Array {
  if (!Number.isInteger(binding.chainId) || binding.chainId < 0 || binding.chainId > Number.MAX_SAFE_INTEGER) {
    throw new MemoError("chainId must be a non-negative integer");
  }
  const address = toBytes(stealthAddress);
  const prefix = encodeStandardPrefix(binding);
  const out = new Uint8Array(address.length + 8 + prefix.length);
  out.set(address, 0);
  let id = BigInt(binding.chainId);
  for (let i = 7; i >= 0; i--) {
    out[address.length + i] = Number(id & 0xffn);
    id >>= 8n;
  }
  out.set(prefix, address.length + 8);
  return out;
}

export function encodeMemoPlaintext(memo: MemoInput): Uint8Array {
  let kind: MemoKind;
  let payload: Uint8Array;
  if (memo instanceof Uint8Array) {
    kind = MemoKind.Bytes;
    payload = memo;
  } else if (typeof memo === "string") {
    kind = MemoKind.Text;
    payload = utf8ToBytes(memo);
  } else {
    kind = MemoKind.Json;
    let json: string;
    try {
      json = JSON.stringify(memo);
    } catch (cause) {
      throw new MemoError("Memo object is not JSON-serialisable (bigint values are not supported)", { cause });
    }
    payload = utf8ToBytes(json);
  }
  if (payload.length > MAX_MEMO_BYTES) {
    throw new MemoError(`Memo is ${payload.length} bytes; maximum is ${MAX_MEMO_BYTES}`);
  }
  const raw = 1 + 2 + payload.length;
  const size = MEMO_BUCKETS.find((b) => b >= raw) ?? raw;
  const out = new Uint8Array(size);
  out[0] = kind;
  out[1] = payload.length >> 8;
  out[2] = payload.length & 0xff;
  out.set(payload, 3);
  return out;
}

export function decodeMemoPlaintext(plaintext: Uint8Array): Memo {
  if (plaintext.length < 3) throw new MemoError("Memo plaintext is truncated");
  const kind = plaintext[0];
  const length = ((plaintext[1] ?? 0) << 8) | (plaintext[2] ?? 0);
  if (3 + length > plaintext.length) throw new MemoError("Memo length prefix exceeds plaintext");
  const payload = plaintext.subarray(3, 3 + length);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  switch (kind) {
    case MemoKind.Bytes:
      return { kind: "bytes", value: payload };
    case MemoKind.Text:
      return { kind: "text", value: decoder.decode(payload) };
    case MemoKind.Json: {
      try {
        return { kind: "json", value: JSON.parse(decoder.decode(payload)) as unknown };
      } catch (cause) {
        throw new MemoError("Memo JSON payload is malformed", { cause });
      }
    }
    default:
      throw new MemoError(`Unknown memo kind ${String(kind)}`);
  }
}

export interface EncryptMemoParams {
  sharedSecret: Uint8Array;
  stealthAddress: Address;
  /** The chain and the figures this memo will be announced with; the memo opens only next to them. */
  binding: MemoBinding;
  memo: MemoInput;
  /** Test hook: fixed 24-byte nonce. Never reuse a nonce in production. */
  nonce?: Uint8Array | undefined;
}

export function encryptMemo(params: EncryptMemoParams): Uint8Array {
  const key = deriveMemoKey(params.sharedSecret, params.stealthAddress);
  const nonce = params.nonce ?? randomBytes(MEMO_NONCE_LENGTH);
  if (nonce.length !== MEMO_NONCE_LENGTH) throw new MemoError(`Nonce must be ${MEMO_NONCE_LENGTH} bytes`);
  const aad = memoAssociatedData(params.stealthAddress, params.binding);
  const sealed = xchacha20poly1305(key, nonce, aad).encrypt(encodeMemoPlaintext(params.memo));
  const out = new Uint8Array(1 + MEMO_NONCE_LENGTH + sealed.length);
  out[0] = MEMO_VERSION;
  out.set(nonce, 1);
  out.set(sealed, 1 + MEMO_NONCE_LENGTH);
  return out;
}

export function isMemoCiphertext(bytes: Uint8Array): boolean {
  return bytes.length >= MEMO_MIN_CIPHERTEXT && bytes[0] === MEMO_VERSION;
}

/** A memo in the retired v2 format (not bound to the announced figures). Reported, never decrypted. */
export const LEGACY_MEMO_VERSION = 0x02;
export function isLegacyMemoCiphertext(bytes: Uint8Array): boolean {
  return bytes.length >= MEMO_MIN_CIPHERTEXT && bytes[0] === LEGACY_MEMO_VERSION;
}

export interface DecryptMemoParams {
  sharedSecret: Uint8Array;
  stealthAddress: Address;
  /** The chain the announcement was read from and the figures it carried. */
  binding: MemoBinding;
  ciphertext: Uint8Array;
}

export function decryptMemo(params: DecryptMemoParams): Memo {
  const { ciphertext } = params;
  if (!isMemoCiphertext(ciphertext)) throw new MemoError("Not a JOMO memo ciphertext");
  const key = deriveMemoKey(params.sharedSecret, params.stealthAddress);
  const nonce = ciphertext.subarray(1, 1 + MEMO_NONCE_LENGTH);
  const sealed = ciphertext.subarray(1 + MEMO_NONCE_LENGTH);
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(key, nonce, memoAssociatedData(params.stealthAddress, params.binding)).decrypt(sealed);
  } catch (cause) {
    throw new MemoError("Memo authentication failed (wrong key, wrong address, wrong chain or figures, or tampered data)", { cause });
  }
  return decodeMemoPlaintext(plaintext);
}
