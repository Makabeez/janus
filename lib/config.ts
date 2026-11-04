import { getChain, getOracle, getTokens } from "@rome-protocol/registry";
import type { Hex } from "viem";

/** Everything the two lanes need — resolved from @rome-protocol/registry, no hardcoding. */
export interface RomeConfig {
  chainId: number;
  proxyUrl: string; // EVM JSON-RPC + the Solana-lane composer
  solanaRpc: string; // Solana RPC (the Solana lane submits + confirms here)
  solanaCluster: string; // the Solana cluster the chain settles on ("devnet", "mainnet", ...)
  programId: string; // rome-evm program id
  wusdc: Hex; // the ERC20SPL wrapper — the token both lanes spend
  usdcMint: string; // the underlying Circle USDC SPL mint (Solana side)
  explorerUrl: string;
  btcFeedAdapter: Hex; // Oracle Gateway BookFeedAdapter for BTC/USD (a view over the PriceBook)
}

/** Rome Hadrian (testnet) — the default chain. */
export const DEFAULT_CHAIN_ID = 200010;

/**
 * The BTC feed Janus prices against. Measured on Hadrian on 4 Nov 2026: every plain feed
 * (`BTC/USD`, ...) reverted StalePriceFeed() and every `-CACHED*` feed reverted
 * UninitializedPriceFeed(); only the PriceBook-backed `-BOOK` feeds served a price.
 */
export const BTC_FEED_KEY = "BTC/USD-BOOK";

export function loadConfig(overrides: { chainId?: number; proxyUrl?: string; solanaRpc?: string } = {}): RomeConfig {
  const chainId = overrides.chainId ?? DEFAULT_CHAIN_ID;
  const chain = getChain(chainId);
  if (!chain) throw new Error(`chain ${chainId} not found in @rome-protocol/registry`);
  // The gas token (kind "gas") names the USDC mint; wUSDC is the spl_wrapper over that same mint.
  const tokens = getTokens(chainId) ?? [];
  const gas = tokens.find((t: any) => t.kind === "gas");
  const usdc = tokens.find((t: any) => t.kind === "spl_wrapper" && t.mintId === gas?.mintId);
  if (!usdc) throw new Error(`no wUSDC wrapper (spl_wrapper over the gas-token mint) for chain ${chainId} in the registry`);
  const feed = getOracle(chainId)?.feeds?.[BTC_FEED_KEY];
  if (!feed || feed.status === "retired") throw new Error(`no live ${BTC_FEED_KEY} feed for chain ${chainId} in the registry`);
  return {
    chainId,
    proxyUrl: overrides.proxyUrl || chain.rpcUrl,
    solanaRpc: overrides.solanaRpc || chain.solana.rpc,
    solanaCluster: chain.solana.cluster,
    programId: chain.romeEvmProgramId,
    wusdc: usdc.address as Hex,
    usdcMint: usdc.mintId,
    explorerUrl: chain.explorerUrl,
    btcFeedAdapter: feed.address as Hex,
  };
}

/** Env → config for the Node scripts (deploy, keeper, demo). */
export function configFromEnv(): RomeConfig {
  return loadConfig({
    chainId: process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : undefined,
    proxyUrl: process.env.PROXY_URL,
    solanaRpc: process.env.SOLANA_RPC,
  });
}
