import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { hashMessage, isAddressEqual, type Address, type Hex } from "viem";
import { InvalidKeyError } from "../errors.js";
import { ROBINHOOD_CHAIN_SHORT_NAME, encodeStealthMetaAddress, encodeStealthMetaAddressBytes, type StealthMetaAddress } from "./metaAddress.js";
import { CURVE_ORDER, addressFromPublicKey, assertPrivateKey, bytesToBigInt, bytesToPrivateKey, keccak, publicKeyFromPrivate, randomPrivateKey, toBytes, toHex } from "./secp.js";

/** Domain separator for deterministic key derivation. Changing it changes every derived key. */
export const STEALTH_KEYS_DOMAIN = "jomo/stealth-keys/v1";

/** Message an agent signs with its wallet to derive stealth keys deterministically. */
export function stealthKeyDerivationMessage(chainId: number): string {
  return (
    `JOMO stealth keys v1\n` +
    `Chain ID: ${chainId}\n\n` +
    `Sign this message to derive this agent's stealth spending and viewing keys.\n` +
    `Anyone holding this signature can spend funds sent to your stealth addresses. ` +
    `Only sign it inside software you trust.`
  );
}

export interface StealthPrivateKeys {
  spendingPrivateKey: Hex;
  viewingPrivateKey: Hex;
}

/** Minimal signer surface (satisfied by viem `LocalAccount` and `WalletClient` with an account). */
export interface MessageSigner {
  signMessage(args: { message: string }): Promise<Hex>;
  /** A LocalAccount's address. */
  address?: Address | undefined;
  /** A WalletClient's account. */
  account?: { address: Address } | undefined;
}

/** Real ECDSA r and s are uniform scalars; one below 2^160 is a contract-wallet marker or padding, not a signature. */
const MIN_SIGNATURE_SCALAR = 1n << 160n;

export interface FromSignatureOptions {
  /** The message that was signed. With `signer`, the signature must recover to that address. */
  message?: string | undefined;
  /** The address expected to have produced the signature. Requires `message`. */
  signer?: Address | undefined;
}

/**
 * The two secp256k1 key pairs behind an agent's stealth identity.
 *
 * - spending key: controls funds at every derived stealth address (keep offline where possible)
 * - viewing key:  lets a scanner detect incoming payments and decrypt memos, but not spend
 */
export class StealthKeys {
  readonly spendingPrivateKey: Hex;
  readonly viewingPrivateKey: Hex;
  readonly spendingPublicKey: Hex;
  readonly viewingPublicKey: Hex;

  private constructor(spending: Uint8Array, viewing: Uint8Array) {
    assertPrivateKey(spending);
    assertPrivateKey(viewing);
    this.spendingPrivateKey = toHex(spending);
    this.viewingPrivateKey = toHex(viewing);
    this.spendingPublicKey = toHex(publicKeyFromPrivate(spending, true));
    this.viewingPublicKey = toHex(publicKeyFromPrivate(viewing, true));
  }

  /** Fresh random keys (CSPRNG). Persist them: they cannot be recovered. */
  static generate(): StealthKeys {
    return new StealthKeys(randomPrivateKey(), randomPrivateKey());
  }

  static fromPrivateKeys(keys: { spendingPrivateKey: Hex | Uint8Array; viewingPrivateKey: Hex | Uint8Array }): StealthKeys {
    return new StealthKeys(toBytes(keys.spendingPrivateKey), toBytes(keys.viewingPrivateKey));
  }

  /**
   * Deterministic keys from a 65-byte ECDSA signature: keccak256(r) → spending, keccak256(s) →
   * viewing, each reduced mod n (unchanged since v1, so existing identities keep their
   * meta-addresses). The signature must look like a real secp256k1 signature in canonical (low-s)
   * form, and when the message and the expected signer are given it must recover to that signer.
   * A contract wallet's 65-byte marker (an address padded into r, a small offset in s) is refused.
   */
  static fromSignature(signature: Hex, options: FromSignatureOptions = {}): StealthKeys {
    const bytes = toBytes(signature);
    if (bytes.length !== 65) throw new InvalidKeyError("Expected a 65-byte (r, s, v) signature");
    const r = bytesToBigInt(bytes.subarray(0, 32));
    const s = bytesToBigInt(bytes.subarray(32, 64));
    const vRaw = bytes[64] ?? 0;
    const v = vRaw >= 27 ? vRaw - 27 : vRaw;
    if (r === 0n || r >= CURVE_ORDER || s === 0n || s >= CURVE_ORDER) throw new InvalidKeyError("Signature r and s must be non-zero scalars below the curve order");
    if (s > CURVE_ORDER / 2n) throw new InvalidKeyError("Signature is not canonical (high s); refuse it rather than derive keys that another encoding of the same signature would not");
    if (r < MIN_SIGNATURE_SCALAR || s < MIN_SIGNATURE_SCALAR) throw new InvalidKeyError("This is not an ECDSA signature (contract-wallet signatures cannot derive stealth keys; use StealthKeys.generate())");
    if (v !== 0 && v !== 1) throw new InvalidKeyError("Signature recovery id must be 27, 28, 0 or 1");
    if (options.signer !== undefined && options.message === undefined) throw new InvalidKeyError("Checking the signer requires the signed message");
    if (options.message !== undefined) {
      let recovered: Address;
      try {
        const point = secp256k1.Signature.fromBytes(bytes.subarray(0, 64), "compact").addRecoveryBit(v).recoverPublicKey(toBytes(hashMessage(options.message)));
        recovered = addressFromPublicKey(point.toBytes(false));
      } catch (cause) {
        throw new InvalidKeyError("Signature does not recover to a public key; it is not an ECDSA signature over this message", { cause });
      }
      if (options.signer !== undefined && !isAddressEqual(recovered, options.signer)) {
        throw new InvalidKeyError(`Signature was made by ${recovered}, not by ${options.signer}`);
      }
    }
    const spending = bytesToPrivateKey(keccak(bytes.subarray(0, 32)));
    const viewing = bytesToPrivateKey(keccak(bytes.subarray(32, 64)));
    return new StealthKeys(spending, viewing);
  }

  /** Deterministic keys from any high-entropy seed via HKDF-SHA256. */
  static fromSeed(seed: Hex | Uint8Array | string): StealthKeys {
    const ikm = typeof seed === "string" && !seed.startsWith("0x") ? utf8ToBytes(seed) : toBytes(seed as Hex | Uint8Array);
    if (ikm.length < 16) throw new InvalidKeyError("Seed must be at least 16 bytes");
    const salt = utf8ToBytes(STEALTH_KEYS_DOMAIN);
    const spending = bytesToPrivateKey(hkdf(sha256, ikm, salt, utf8ToBytes("spending"), 32));
    const viewing = bytesToPrivateKey(hkdf(sha256, ikm, salt, utf8ToBytes("viewing"), 32));
    return new StealthKeys(spending, viewing);
  }

  /**
   * Derive keys by signing a fixed message with the agent's wallet. Nothing extra to store — but
   * only safe with a signer that produces deterministic ECDSA signatures (RFC 6979: viem local
   * accounts, MetaMask, Ledger). Signers that use a random nonce (some MPC and hardware wallets)
   * would derive different keys every time and strand earlier funds, so by default the message is
   * signed twice and the two signatures must match. Smart accounts (ERC-1271) are not supported.
   *
   * Phishing note: any site that gets this wallet to sign the same message obtains these keys.
   * Agents with a secrets store should prefer `StealthKeys.generate()` and persist the result.
   */
  static async fromAccount(signer: MessageSigner, options: { chainId: number; verifyDeterministic?: boolean | undefined }): Promise<StealthKeys> {
    const address = signer.address ?? signer.account?.address;
    if (!address) throw new InvalidKeyError("fromAccount needs a signer that exposes its address (a viem LocalAccount, or a WalletClient with an account)");
    const message = stealthKeyDerivationMessage(options.chainId);
    const signature = await signer.signMessage({ message });
    if (options.verifyDeterministic !== false) {
      const again = await signer.signMessage({ message });
      if (again.toLowerCase() !== signature.toLowerCase()) {
        throw new InvalidKeyError(
          "This signer does not produce deterministic signatures; keys derived from it would not be recoverable. Use StealthKeys.generate() and persist the keys instead.",
        );
      }
    }
    // The signature must be a real one over this message, made by this wallet.
    return StealthKeys.fromSignature(signature, { message, signer: address });
  }

  get publicKeys(): StealthMetaAddress {
    return { spendingPublicKey: this.spendingPublicKey, viewingPublicKey: this.viewingPublicKey };
  }

  /** 66-byte form stored in the ERC-6538 registry. */
  get metaAddressBytes(): Hex {
    return encodeStealthMetaAddressBytes(this.publicKeys);
  }

  /** `st:<chain>:0x…` URI form to share with counterparties. */
  metaAddress(chainShortName: string = ROBINHOOD_CHAIN_SHORT_NAME): string {
    return encodeStealthMetaAddress(this.publicKeys, chainShortName);
  }

  /** Explicit export of secrets (never serialised implicitly). */
  toPrivateKeys(): StealthPrivateKeys {
    return { spendingPrivateKey: this.spendingPrivateKey, viewingPrivateKey: this.viewingPrivateKey };
  }

  /** Redacted representation for logs. */
  toJSON(): { spendingPublicKey: Hex; viewingPublicKey: Hex } {
    return this.publicKeys;
  }
}
