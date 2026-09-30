import type { Chain } from "viem";
import { robinhood, robinhoodTestnet } from "viem/chains";
import { ROBINHOOD_CHAIN_SHORT_NAME, ROBINHOOD_TESTNET_SHORT_NAME } from "./crypto/metaAddress.js";

/**
 * Robinhood Chain (Arbitrum L2, chain id 4663). Public RPC: https://rpc.mainnet.chain.robinhood.com
 * The public endpoint is rate-limited; use a dedicated provider in production.
 */
export { robinhood, robinhoodTestnet };

/** Robinhood Chain Testnet (chain id 46630). Faucet: https://faucet.testnet.chain.robinhood.com */
export const supportedChains: readonly Chain[] = [robinhood, robinhoodTestnet];

const SHORT_NAMES: Record<number, string> = {
  [robinhood.id]: ROBINHOOD_CHAIN_SHORT_NAME,
  [robinhoodTestnet.id]: ROBINHOOD_TESTNET_SHORT_NAME,
};

/** ERC-3770 short name used in `st:<shortName>:0x…` meta-addresses. */
export function chainShortName(chainId: number): string {
  return SHORT_NAMES[chainId] ?? `chain${chainId}`;
}

export function isRobinhoodChain(chainId: number): boolean {
  return chainId === robinhood.id || chainId === robinhoodTestnet.id;
}
