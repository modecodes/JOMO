/**
 * @jomo/sdk — privacy-preserving transactions for autonomous agents on Robinhood Chain.
 *
 * Built on ERC-5564 stealth addresses and the ERC-6538 registry, both deployed at their canonical
 * addresses on Robinhood Chain mainnet (4663) and testnet (46630).
 */
export const SDK_VERSION = "0.1.0";

// High-level client
export { PrivateAgent, createPrivateAgent, quoteFee, assertTransactionSucceeded, DEFAULT_SCAN_CHUNK_SIZE, DEFAULT_SCAN_LOOKBACK, DEFAULT_POLLING_INTERVAL } from "./client/PrivateAgent.js";
export { computeDeploymentAddresses } from "./deployments.js";
export type { DeploymentInputs, DeploymentAddresses } from "./deployments.js";

// Chains
export { robinhood, robinhoodTestnet, supportedChains, chainShortName, isRobinhoodChain } from "./chains.js";

// Keys and meta-addresses
export { StealthKeys, STEALTH_KEYS_DOMAIN, stealthKeyDerivationMessage } from "./crypto/keys.js";
export type { MessageSigner, StealthPrivateKeys, FromSignatureOptions } from "./crypto/keys.js";
export {
  encodeStealthMetaAddress,
  encodeStealthMetaAddressBytes,
  parseStealthMetaAddress,
  isStealthMetaAddress,
  ROBINHOOD_CHAIN_SHORT_NAME,
  ROBINHOOD_TESTNET_SHORT_NAME,
} from "./crypto/metaAddress.js";
export type { StealthMetaAddress } from "./crypto/metaAddress.js";

// ERC-5564 primitives
export {
  SCHEME_ID,
  generateStealthAddress,
  checkStealthAddress,
  computeStealthKey,
  deriveSharedSecret,
  hashSharedSecret,
} from "./crypto/stealth.js";
export type {
  GenerateStealthAddressParams,
  GenerateStealthAddressResult,
  StealthAddressResult,
  CheckStealthAddressParams,
  CheckStealthAddressResult,
  ComputeStealthKeyParams,
  StealthMetaAddressKeys,
} from "./crypto/stealth.js";

// Encrypted memos
export { encryptMemo, decryptMemo, deriveMemoKey, memoAssociatedData, isMemoCiphertext, MEMO_VERSION, MEMO_BUCKETS, MAX_MEMO_BYTES } from "./crypto/memo.js";
export type { Memo, MemoInput, MemoBinding, EncryptMemoParams, DecryptMemoParams } from "./crypto/memo.js";

// Announcement metadata
export {
  encodeAnnouncementMetadata,
  decodeAnnouncementMetadata,
  ETH_TOKEN_PLACEHOLDER,
  STANDARD_METADATA_LENGTH,
} from "./crypto/metadata.js";
export type { AnnouncementMetadata, EncodeMetadataParams } from "./crypto/metadata.js";

// Contracts
export {
  ERC5564_ANNOUNCER_ADDRESS,
  ERC6538_REGISTRY_ADDRESS,
  STEALTH_ROUTER_DEPLOYMENTS,
  STEALTH_ROUTER_FEE_BPS,
  STEALTH_ROUTER_MAX_GAS_STIPEND,
  STEALTH_ROUTER_SALT,
  FEE_VAULT_SINK_DELAY,
  FEE_VAULT_SALT,
  FEE_VAULT_STATS_SELECTOR,
  CREATE2_FACTORY_ADDRESS,
  erc5564AnnouncerAbi,
  erc6538RegistryAbi,
  stealthRouterAbi,
  stealthRouterBytecode,
  feeVaultAbi,
  feeVaultBytecode,
} from "./generated/contracts.js";
export type { StealthRouterDeployment } from "./generated/contracts.js";

// Errors
export {
  JomoError,
  InvalidStealthMetaAddressError,
  InvalidKeyError,
  RecipientNotRegisteredError,
  NoAccountError,
  RouterUnavailableError,
  MemoError,
  InsufficientBalanceError,
} from "./errors.js";

// Types
export type {
  ContractAddresses,
  PrivateAgentConfig,
  ScanDefaults,
  ScanOptions,
  ScanResult,
  SendMode,
  SendParams,
  SendResult,
  BatchPaymentParams,
  SendBatchParams,
  SendBatchResult,
  LayerStats,
  StealthPayment,
  SweepParams,
  WatchOptions,
} from "./types.js";
