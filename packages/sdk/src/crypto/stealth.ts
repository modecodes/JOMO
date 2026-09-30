/**
 * ERC-5564 stealth addresses, scheme 1 (secp256k1 with view tags).
 * https://eips.ethereum.org/EIPS/eip-5564
 *
 * Sender:    S = e · P_view          s_h = keccak256(compress(S))
 *            P_stealth = P_spend + s_h · G        view tag = s_h[0]
 * Recipient: S = p_view · E  (same s_h)          p_stealth = p_spend + s_h  (mod n)
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { isAddressEqual, type Address, type Hex } from "viem";
import {
  Fn,
  Point,
  addressFromPublicKey,
  assertCompressedPublicKey,
  assertPrivateKey,
  bytesToBigInt,
  keccak,
  publicKeyFromPrivate,
  randomPrivateKey,
  scalarToPrivateKey,
  toBytes,
  toHex,
} from "./secp.js";

/** ERC-5564 scheme id for secp256k1 + view tags. */
export const SCHEME_ID = 1n;

export interface StealthMetaAddressKeys {
  /** 33-byte compressed spending public key. */
  spendingPublicKey: Hex | Uint8Array;
  /** 33-byte compressed viewing public key. */
  viewingPublicKey: Hex | Uint8Array;
}

export interface GenerateStealthAddressParams extends StealthMetaAddressKeys {
  /** Optional deterministic ephemeral private key (32 bytes). Random when omitted. */
  ephemeralPrivateKey?: Hex | Uint8Array | undefined;
}

export interface StealthAddressResult {
  stealthAddress: Address;
  /** 33-byte compressed ephemeral public key, published in the announcement. */
  ephemeralPublicKey: Hex;
  /** First byte of the hashed shared secret. */
  viewTag: number;
  /**
   * 33-byte compressed ECDH shared secret. Known only to sender and recipient; used to derive
   * the memo encryption key. Never publish it.
   */
  sharedSecret: Uint8Array;
}

export interface GenerateStealthAddressResult extends StealthAddressResult {
  ephemeralPrivateKey: Hex;
}

/** ECDH: compressed(sk · PK). Both sides compute the same 33 bytes. */
export function deriveSharedSecret(privateKey: Hex | Uint8Array, publicKey: Hex | Uint8Array): Uint8Array {
  const sk = toBytes(privateKey);
  const pk = toBytes(publicKey);
  assertPrivateKey(sk);
  assertCompressedPublicKey(pk);
  return secp256k1.getSharedSecret(sk, pk, true);
}

export function hashSharedSecret(sharedSecret: Uint8Array): Uint8Array {
  return keccak(sharedSecret);
}

function stealthPublicKeyFromHash(spendingPublicKey: Uint8Array, hashedSecret: Uint8Array): Uint8Array {
  const scalar = Fn.create(bytesToBigInt(hashedSecret));
  const point = Point.fromBytes(spendingPublicKey).add(Point.BASE.multiply(scalar));
  return point.toBytes(true);
}

/** Sender side: derive a fresh one-time address for the recipient. */
export function generateStealthAddress(params: GenerateStealthAddressParams): GenerateStealthAddressResult {
  const spendingPublicKey = toBytes(params.spendingPublicKey);
  const viewingPublicKey = toBytes(params.viewingPublicKey);
  assertCompressedPublicKey(spendingPublicKey);
  assertCompressedPublicKey(viewingPublicKey);

  const ephemeralPrivateKey = params.ephemeralPrivateKey ? toBytes(params.ephemeralPrivateKey) : randomPrivateKey();
  assertPrivateKey(ephemeralPrivateKey);
  const ephemeralPublicKey = publicKeyFromPrivate(ephemeralPrivateKey, true);

  const sharedSecret = deriveSharedSecret(ephemeralPrivateKey, viewingPublicKey);
  const hashed = hashSharedSecret(sharedSecret);
  const stealthPublicKey = stealthPublicKeyFromHash(spendingPublicKey, hashed);

  return {
    stealthAddress: addressFromPublicKey(stealthPublicKey),
    ephemeralPublicKey: toHex(ephemeralPublicKey),
    ephemeralPrivateKey: toHex(ephemeralPrivateKey),
    viewTag: hashed[0] ?? 0,
    sharedSecret,
  };
}

export interface CheckStealthAddressParams {
  stealthAddress: Address;
  ephemeralPublicKey: Hex | Uint8Array;
  viewingPrivateKey: Hex | Uint8Array;
  spendingPublicKey: Hex | Uint8Array;
  /** Optional view tag from the announcement metadata; enables the cheap pre-filter. */
  viewTag?: number | undefined;
}

export interface CheckStealthAddressResult {
  matches: boolean;
  /** Present when `matches` is true. */
  sharedSecret?: Uint8Array;
  hashedSharedSecret?: Uint8Array;
}

/** Recipient side: does this announcement belong to me? */
export function checkStealthAddress(params: CheckStealthAddressParams): CheckStealthAddressResult {
  const ephemeralPublicKey = toBytes(params.ephemeralPublicKey);
  if (ephemeralPublicKey.length !== 33) return { matches: false };
  try {
    assertCompressedPublicKey(ephemeralPublicKey);
  } catch {
    return { matches: false };
  }
  const sharedSecret = deriveSharedSecret(params.viewingPrivateKey, ephemeralPublicKey);
  const hashed = hashSharedSecret(sharedSecret);
  if (params.viewTag !== undefined && hashed[0] !== params.viewTag) return { matches: false };
  const candidate = addressFromPublicKey(stealthPublicKeyFromHash(toBytes(params.spendingPublicKey), hashed));
  if (!isAddressEqual(candidate, params.stealthAddress)) return { matches: false };
  return { matches: true, sharedSecret, hashedSharedSecret: hashed };
}

export interface ComputeStealthKeyParams {
  ephemeralPublicKey: Hex | Uint8Array;
  viewingPrivateKey: Hex | Uint8Array;
  spendingPrivateKey: Hex | Uint8Array;
  /** Skip the ECDH when the hashed shared secret is already known (e.g. from checkStealthAddress). */
  hashedSharedSecret?: Uint8Array | undefined;
}

/** Recipient side: the private key that controls the stealth address. */
export function computeStealthKey(params: ComputeStealthKeyParams): Hex {
  const hashed =
    params.hashedSharedSecret ?? hashSharedSecret(deriveSharedSecret(params.viewingPrivateKey, params.ephemeralPublicKey));
  const spending = toBytes(params.spendingPrivateKey);
  assertPrivateKey(spending);
  const scalar = Fn.add(Fn.create(bytesToBigInt(spending)), Fn.create(bytesToBigInt(hashed)));
  return toHex(scalarToPrivateKey(scalar));
}
