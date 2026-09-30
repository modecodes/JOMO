import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes as nobleHexToBytes } from "@noble/hashes/utils.js";
import { getAddress, type Address, type Hex } from "viem";
import { InvalidKeyError } from "../errors.js";

/** secp256k1 projective point constructor. */
export const Point = secp256k1.Point;
/** Scalar field (integers mod curve order n). */
export const Fn = secp256k1.Point.Fn;
/** Curve order n. */
export const CURVE_ORDER: bigint = Fn.ORDER;

export const PRIVATE_KEY_LENGTH = 32;
export const COMPRESSED_PUBLIC_KEY_LENGTH = 33;

export function toBytes(value: Hex | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const stripped = value.startsWith("0x") ? value.slice(2) : value;
  // Never echo the value: it may be a private key.
  if (stripped.length % 2 !== 0) throw new InvalidKeyError(`Odd-length hex string (${stripped.length} hex characters)`);
  try {
    return nobleHexToBytes(stripped);
  } catch {
    throw new InvalidKeyError(`Invalid hex string (${stripped.length} hex characters)`);
  }
}

export function toHex(bytes: Uint8Array): Hex {
  return `0x${bytesToHex(bytes)}`;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(toHex(bytes));
}

/** Encodes a scalar (mod n) as a 32-byte big-endian private key. */
export function scalarToPrivateKey(scalar: bigint): Uint8Array {
  const reduced = Fn.create(scalar);
  if (reduced === 0n) throw new InvalidKeyError("Derived scalar is zero");
  return Fn.toBytes(reduced);
}

/** Reduces arbitrary 32 bytes (e.g. a hash) into a valid non-zero scalar and returns it as a key. */
export function bytesToPrivateKey(bytes: Uint8Array): Uint8Array {
  return scalarToPrivateKey(bytesToBigInt(bytes));
}

export function assertPrivateKey(key: Uint8Array): void {
  if (key.length !== PRIVATE_KEY_LENGTH || !secp256k1.utils.isValidSecretKey(key)) {
    throw new InvalidKeyError("Private key must be 32 bytes in the range [1, n-1]");
  }
}

export function assertCompressedPublicKey(key: Uint8Array): void {
  if (key.length !== COMPRESSED_PUBLIC_KEY_LENGTH || (key[0] !== 0x02 && key[0] !== 0x03)) {
    throw new InvalidKeyError("Public key must be a 33-byte compressed secp256k1 point");
  }
  try {
    Point.fromBytes(key);
  } catch (cause) {
    throw new InvalidKeyError("Public key is not a valid secp256k1 point");
  }
}

export function randomPrivateKey(): Uint8Array {
  return secp256k1.utils.randomSecretKey();
}

export function publicKeyFromPrivate(privateKey: Uint8Array, compressed = true): Uint8Array {
  assertPrivateKey(privateKey);
  return secp256k1.getPublicKey(privateKey, compressed);
}

export function keccak(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes);
}

/** Ethereum address of a (compressed or uncompressed) secp256k1 public key. */
export function addressFromPublicKey(publicKey: Uint8Array): Address {
  const uncompressed = Point.fromBytes(publicKey).toBytes(false); // 0x04 || x || y
  const hash = keccak(uncompressed.subarray(1));
  return getAddress(toHex(hash.subarray(12)));
}
