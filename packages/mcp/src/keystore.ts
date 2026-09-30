/**
 * Encrypted keystore for the MCP server.
 *
 * Holds the agent's identity private key, the scan cursor, and every stealth payment the agent has
 * detected (including the per-address spending keys needed to forward or sweep). Everything is
 * sealed with XChaCha20-Poly1305 under a key derived from a passphrase with scrypt.
 *
 * The passphrase is used once, to derive the key; the process keeps the derived key and the salt,
 * not the passphrase. Private keys never leave this module except to construct signers; tool
 * results never include them.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/ciphers/utils.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address, Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import type { SpendEntry } from "./policy.js";

export const KEYSTORE_VERSION = 1;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, dkLen: 32 };

/** A detected stealth payment, as stored. Mirrors the SDK's StealthPayment with bigint as string. */
export interface StoredPayment {
  stealthAddress: Address;
  stealthPrivateKey: Hex;
  ephemeralPublicKey: Hex;
  token: Address | null | undefined;
  amount: string | undefined;
  memo: { kind: "json" | "text" | "bytes"; value: unknown } | undefined;
  transactionHash: Hex;
  blockNumber: string;
  spent: boolean;
  /** On-chain balance at the last scan (wei / base units), and whether the announced figures were delivered. */
  balance?: string;
  verified?: boolean;
  /** How many announcements named this address. More than one is a re-announcement (possibly spoofed). */
  announcements?: number;
}

export interface KeystoreState {
  identityPrivateKey: Hex;
  cursor: string | null;
  payments: Record<string, StoredPayment>;
  /** Autonomous spending over the last 24 hours (see policy.ts). */
  spendLog?: SpendEntry[];
}

interface KeystoreFile {
  version: number;
  kdf: "scrypt";
  salt: Hex;
  nonce: Hex;
  ciphertext: Hex;
}

function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
  return scrypt(utf8ToBytes(passphrase), salt, SCRYPT);
}

function seal(state: KeystoreState, key: Uint8Array, salt: Uint8Array): KeystoreFile {
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(JSON.stringify(state)));
  return { version: KEYSTORE_VERSION, kdf: "scrypt", salt: `0x${bytesToHex(salt)}`, nonce: `0x${bytesToHex(nonce)}`, ciphertext: `0x${bytesToHex(ciphertext)}` };
}

function unseal(file: KeystoreFile, key: Uint8Array): KeystoreState {
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(key, hexToBytes(file.nonce.slice(2))).decrypt(hexToBytes(file.ciphertext.slice(2)));
  } catch {
    throw new Error("Keystore passphrase is wrong or the file is corrupt");
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as KeystoreState;
}

/** Storage backend: an encrypted file on disk, or memory (dev mode with JOMO_PRIVATE_KEY). */
export interface Keystore {
  readonly state: KeystoreState;
  save(): void;
  readonly location: string;
}

export class FileKeystore implements Keystore {
  readonly state: KeystoreState;
  private constructor(readonly location: string, private readonly key: Uint8Array, private readonly salt: Uint8Array, state: KeystoreState) {
    this.state = state;
  }

  static exists(path: string): boolean {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  }

  static create(path: string, passphrase: string, identityPrivateKey?: Hex): FileKeystore {
    if (passphrase.length < 12) throw new Error("Keystore passphrase must be at least 12 characters");
    if (FileKeystore.exists(path)) throw new Error(`Keystore already exists at ${path}`);
    const salt = randomBytes(16);
    const store = new FileKeystore(path, deriveKey(passphrase, salt), salt, { identityPrivateKey: identityPrivateKey ?? generatePrivateKey(), cursor: null, payments: {} });
    store.save();
    return store;
  }

  static open(path: string, passphrase: string): FileKeystore {
    const file = JSON.parse(readFileSync(path, "utf8")) as KeystoreFile;
    if (file.version !== KEYSTORE_VERSION || file.kdf !== "scrypt") throw new Error("Unsupported keystore format");
    const salt = hexToBytes(file.salt.slice(2));
    const key = deriveKey(passphrase, salt);
    return new FileKeystore(path, key, salt, unseal(file, key));
  }

  /** Atomic write: a private temp file next to the keystore, then a rename. Never follows a symlink. */
  save(): void {
    mkdirSync(dirname(this.location), { recursive: true, mode: 0o700 });
    const tmp = `${this.location}.${process.pid}.tmp`;
    try {
      unlinkSync(tmp); // a stale temp file or a planted symlink: removed, never followed
    } catch {
      /* none */
    }
    writeFileSync(tmp, JSON.stringify(seal(this.state, this.key, this.salt)), { mode: 0o600, flag: "wx" });
    renameSync(tmp, this.location);
  }
}

export class MemoryKeystore implements Keystore {
  readonly location = "memory";
  readonly state: KeystoreState;
  constructor(identityPrivateKey: Hex) {
    this.state = { identityPrivateKey, cursor: null, payments: {} };
  }
  save(): void {
    /* nothing to persist */
  }
}
