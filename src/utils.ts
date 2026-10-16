import { type EVMWalletClient } from "@goat-sdk/wallet-evm";
import { Address, erc20Abi, formatUnits } from "viem";
import type { ChordQuoteResponse } from "./api";
import {
  APPROVE_RESET_FIRST,
  ARC_USDC_ADDRESS,
  CHORD_SUPPORTED_CHAINS,
  HIGH_PRICE_IMPACT_PCT,
  NATIVE_TOKEN_ADDRESS,
  NATIVE_TOKEN_PLACEHOLDER,
} from "./constants";

/**
 * Token details the tools need.
 */
export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
  isNative: boolean;
}

/**
 * Normalizes a token address for the Chord API on a chain.
 *
 * Lowercases it, maps the 0xEeee... placeholder to the zero address, and on Arc maps the zero
 * address to the USDC system contract, which is what the API settles in there.
 *
 * @param chainId - EVM chain id.
 * @param token - Token address from the agent.
 * @returns The address to send to the API.
 */
export function normalizeToken(chainId: number, token: string): Address {
  let address = token.toLowerCase();
  if (address === NATIVE_TOKEN_PLACEHOLDER) address = NATIVE_TOKEN_ADDRESS;
  if (chainId === 5042 && address === NATIVE_TOKEN_ADDRESS) address = ARC_USDC_ADDRESS;
  return address as Address;
}

/**
 * Returns true when the address is the native coin sentinel.
 *
 * @param address - Normalized token address.
 * @returns Whether the address stands for the native coin.
 */
export function isNativeToken(address: string): boolean {
  return address.toLowerCase() === NATIVE_TOKEN_ADDRESS;
}

/**
 * Keeps on-chain token metadata short and free of control characters before it reaches the model.
 *
 * @param value - Raw string read from a token contract or the API.
 * @returns A cleaned string of at most 32 characters.
 */
export function sanitizeMetadata(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[^\p{L}\p{N} ._\-+$()/]/gu, "")
    .trim()
    .slice(0, 32);
}

/**
 * Reads decimals and symbol for a token, or returns the native coin's details.
 *
 * @param wallet - Wallet client used for contract reads.
 * @param chainId - EVM chain id.
 * @param address - Normalized token address.
 * @returns The token details.
 */
export async function getTokenInfo(
  wallet: EVMWalletClient,
  chainId: number,
  address: Address,
): Promise<TokenInfo> {
  if (isNativeToken(address)) {
    return {
      address,
      symbol: CHORD_SUPPORTED_CHAINS[chainId]?.nativeSymbol ?? "native",
      decimals: 18,
      isNative: true,
    };
  }

  let decimals: number;
  try {
    const result = await wallet.read({ address, abi: erc20Abi, functionName: "decimals" });
    decimals = Number(result.value);
  } catch {
    throw new Error(`Could not read decimals of ${address}; it may not be an ERC-20 token`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`Token ${address} reports invalid decimals`);
  }

  let symbol = "";
  try {
    const result = await wallet.read({ address, abi: erc20Abi, functionName: "symbol" });
    symbol = sanitizeMetadata(result.value);
  } catch {
    symbol = "";
  }

  return { address, symbol: symbol || address, decimals, isNative: false };
}

/**
 * Reads the wallet's balance of a token or of the native coin.
 *
 * @param wallet - Wallet client.
 * @param token - Token details.
 * @returns The balance in the token's smallest unit.
 */
export async function getBalance(wallet: EVMWalletClient, token: TokenInfo): Promise<bigint> {
  if (token.isNative) return wallet.getNativeBalance();
  const result = await wallet.read({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet.getAddress() as Address],
  });
  return BigInt(result.value as bigint);
}

/**
 * Reads how much of a token the spender may pull from the wallet.
 *
 * @param wallet - Wallet client.
 * @param token - ERC-20 token address.
 * @param spender - Spender address.
 * @returns The allowance in the token's smallest unit.
 */
export async function getAllowance(
  wallet: EVMWalletClient,
  token: Address,
  spender: Address,
): Promise<bigint> {
  const result = await wallet.read({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet.getAddress() as Address, spender],
  });
  return BigInt(result.value as bigint);
}

/**
 * Returns true when a token must have its allowance reset to zero before a new approval.
 *
 * @param chainId - EVM chain id.
 * @param token - Normalized token address.
 * @returns Whether the token needs `approve(spender, 0)` first.
 */
export function needsApproveReset(chainId: number, token: string): boolean {
  return (APPROVE_RESET_FIRST[chainId] ?? []).includes(token.toLowerCase());
}

/**
 * Turns a Chord quote into the summary the tools return to the agent.
 *
 * @param quote - The `/quote` body.
 * @param from - Input token details.
 * @param to - Output token details.
 * @returns Human-readable amounts, route, fee and warnings.
 */
export function summarizeQuote(
  quote: ChordQuoteResponse,
  from: TokenInfo,
  to: TokenInfo,
): Record<string, unknown> {
  const gross = BigInt(quote.outputAmount);
  const fee = BigInt(quote.feeAmount ?? "0");
  const warnings: string[] = [];

  const impact = Number(quote.priceImpactPct);
  if (Number.isFinite(impact) && impact >= HIGH_PRICE_IMPACT_PCT) {
    warnings.push(
      `Price impact is ${quote.priceImpactPct}%. A smaller amount may get a better rate.`,
    );
  }
  if (typeof quote.valueLossPct === "number" && quote.valueLossPct >= HIGH_PRICE_IMPACT_PCT) {
    warnings.push(
      `The output is worth ${quote.valueLossPct}% less than the input at Chord's reference prices.`,
    );
  }

  return {
    fromToken: {
      address: from.address,
      symbol: from.symbol,
      amount: formatUnits(BigInt(quote.inputAmount), from.decimals),
    },
    toToken: { address: to.address, symbol: to.symbol },
    expectedAmountOut: formatUnits(gross - fee, to.decimals),
    minimumAmountOut: formatUnits(BigInt(quote.otherAmountThreshold), to.decimals),
    priceImpactPct: quote.priceImpactPct,
    feeBps: quote.feeBps ?? 0,
    feeAmount: formatUnits(fee, to.decimals),
    slippageBps: quote.slippageBps,
    route: quote.routePlan.map(leg => ({
      dex: leg.swapInfo.dex,
      percent: leg.percent,
      inputToken: leg.swapInfo.inputMint,
      outputToken: leg.swapInfo.outputMint,
    })),
    gasEstimate: quote.gasEstimate ?? null,
    blockNumber: quote.blockNumber ?? null,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
