import { Tool } from "@goat-sdk/core";
import { EVMWalletClient } from "@goat-sdk/wallet-evm";
import { Address, encodeFunctionData, erc20Abi, formatUnits, Hex, parseUnits } from "viem";
import { ChordApiClient, ChordApiError, ChordQuoteResponse, ChordSwapTransaction } from "./api";
import {
  CHORD_API_BASE_URL,
  CHORD_ROUTER_ADDRESS,
  CHORD_SUPPORTED_CHAINS,
  DEFAULT_SLIPPAGE_BPS,
} from "./constants";
import { SearchTokensParameters, SwapParameters } from "./parameters";
import {
  getAllowance,
  getBalance,
  getTokenInfo,
  needsApproveReset,
  normalizeToken,
  sanitizeMetadata,
  summarizeQuote,
  TokenInfo,
} from "./utils";

/**
 * Options for the Chord plugin.
 */
export interface ChordPluginOptions {
  /**
   * Optional Chord API key, sent as `X-API-Key`. Quotes and swaps work without one at the public
   * rate limit. Falls back to the `CHORD_API_KEY` environment variable.
   */
  apiKey?: string;

  /**
   * Base URL of the Chord API. Defaults to https://api.getchord.xyz/v1.
   */
  baseUrl?: string;
}

/**
 * An unsigned transaction for the wallet to sign.
 */
export interface UnsignedTransaction {
  to: Address;
  data: Hex;
  value: string;
  chainId: number;
}

const SUPPORTED_CHAIN_LIST = Object.entries(CHORD_SUPPORTED_CHAINS)
  .map(([id, chain]) => `${chain.name} (${id})`)
  .join(", ");

const AMOUNT_NOTE = "Use the amount exactly as given in whole units; do not convert it to wei.";
const NATIVE_NOTE =
  "The native coin (ETH, BNB, AVAX, MON) is 0x0000000000000000000000000000000000000000. On Arc it stands for USDC.";
const ADDRESS_NOTE =
  "Never assume a token address: addresses differ between chains, so use chord_search_tokens or ask.";

/**
 * Tools that quote and execute swaps through Chord (https://getchord.xyz).
 */
export class ChordService {
  readonly #client: ChordApiClient;

  /**
   * Creates the service.
   *
   * @param options - Optional API key and base URL.
   */
  constructor(options: ChordPluginOptions = {}) {
    this.#client = new ChordApiClient({
      baseUrl: options.baseUrl ?? CHORD_API_BASE_URL,
      apiKey: options.apiKey ?? process.env.CHORD_API_KEY,
    });
  }

  /**
   * Searches Chord's token index on the wallet's chain.
   *
   * @param wallet - The wallet client; only its chain is used.
   * @param parameters - The search query.
   * @returns Matching tokens.
   */
  @Tool({
    name: "chord_search_tokens",
    description: `Search Chord's token index on the wallet's current chain by symbol, name or address. Returns up to 10 tokens with address, symbol, name, decimals and a verified flag. verified: false means the index found the token but it is not on the chain's curated list, so confirm the address before trading it. Several tokens can share a symbol. Supported chains: ${SUPPORTED_CHAIN_LIST}.`,
  })
  async searchTokens(wallet: EVMWalletClient, parameters: SearchTokensParameters) {
    try {
      const chainId = chainIdOf(wallet);
      const tokens = await this.#client.searchTokens({
        chainId,
        query: parameters.query,
        limit: 10,
      });
      return {
        success: true,
        chainId,
        tokens: tokens.map(token => ({
          address: token.address,
          symbol: sanitizeMetadata(token.symbol),
          name: sanitizeMetadata(token.name),
          decimals: token.decimals,
          verified: token.verified,
          ...(token.tags && token.tags.length > 0 ? { tags: token.tags } : {}),
        })),
      };
    } catch (error) {
      return { success: false, error: `Error searching tokens: ${errorMessage(error)}` };
    }
  }

  /**
   * Gets the best route and expected output for a swap without sending anything.
   *
   * @param wallet - The wallet client; used for its chain and token metadata reads.
   * @param parameters - Tokens, amount and slippage.
   * @returns The quote summary.
   */
  @Tool({
    name: "chord_get_swap_quote",
    description: `Get the best swap route from Chord on the wallet's current chain, across the chain's DEXs. Sends nothing. expectedAmountOut is what the wallet receives after Chord's fee; minimumAmountOut is the floor the transaction enforces. ${NATIVE_NOTE} ${AMOUNT_NOTE} ${ADDRESS_NOTE} Supported chains: ${SUPPORTED_CHAIN_LIST}.`,
  })
  async getSwapQuote(wallet: EVMWalletClient, parameters: SwapParameters) {
    try {
      const chainId = chainIdOf(wallet);
      const { from, to, amountIn } = await this.#resolve(wallet, chainId, parameters);
      const quote = await this.#quote(chainId, from, to, amountIn, parameters.slippageBps);
      if (!hasRoute(quote)) return noRoute(quote, from, to, parameters.amount);
      return {
        success: true,
        network: CHORD_SUPPORTED_CHAINS[chainId].name,
        chainId,
        ...summarizeQuote(quote, from, to),
      };
    } catch (error) {
      return { success: false, error: `Error fetching quote: ${errorMessage(error)}` };
    }
  }

  /**
   * Builds the unsigned transactions for a swap from the wallet without sending them.
   *
   * @param wallet - The wallet client; its address is the sender and recipient.
   * @param parameters - Tokens, amount and slippage.
   * @returns The approvals still needed, the swap transaction and, when no approval is pending, a
   * simulation of it from the wallet.
   */
  @Tool({
    name: "chord_build_swap_transaction",
    description: `Build the unsigned transactions for a Chord swap from the wallet on its current chain, without signing or sending anything. Returns any ERC-20 approvals still needed (to the Chord router ${CHORD_ROUTER_ADDRESS}, for exactly the input amount) and the swap transaction, to be signed by the wallet in that order. When no approval is pending the swap is simulated from the wallet. ${NATIVE_NOTE} ${AMOUNT_NOTE} ${ADDRESS_NOTE} Supported chains: ${SUPPORTED_CHAIN_LIST}.`,
  })
  async buildSwapTransaction(wallet: EVMWalletClient, parameters: SwapParameters) {
    try {
      const chainId = chainIdOf(wallet);
      const walletAddress = wallet.getAddress() as Address;
      const { from, to, amountIn } = await this.#resolve(wallet, chainId, parameters);
      const slippageBps = parameters.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
      const quote = await this.#quote(chainId, from, to, amountIn, slippageBps);
      if (!hasRoute(quote)) return noRoute(quote, from, to, parameters.amount);

      const approvals: UnsignedTransaction[] = [];
      if (!from.isNative) {
        const allowance = await getAllowance(wallet, from.address, CHORD_ROUTER_ADDRESS);
        if (allowance < amountIn) {
          if (allowance > 0n && needsApproveReset(chainId, from.address)) {
            approvals.push(approvalTx(chainId, from.address, 0n));
          }
          approvals.push(approvalTx(chainId, from.address, amountIn));
        }
      }

      const transaction = await this.#build(chainId, quote, walletAddress, slippageBps);
      const simulation =
        approvals.length === 0
          ? await this.#client.simulate(simulationOf(transaction, walletAddress))
          : null;

      return {
        success: true,
        network: CHORD_SUPPORTED_CHAINS[chainId].name,
        chainId,
        ...summarizeQuote(quote, from, to),
        approvals,
        transaction,
        simulation: simulation
          ? {
              ok: simulation.ok,
              ...(simulation.ok ? {} : { revert: simulation.revert ?? "reverted" }),
            }
          : "skipped until the approval is confirmed",
      };
    } catch (error) {
      return { success: false, error: `Error building swap: ${errorMessage(error)}` };
    }
  }

  /**
   * Swaps tokens through the Chord router: approves the router when needed, builds the
   * transaction with the Chord API, simulates it from the wallet and sends it.
   *
   * @param wallet - The wallet client that signs and sends.
   * @param parameters - Tokens, amount and slippage.
   * @returns The transaction hash and amounts.
   */
  @Tool({
    name: "chord_swap",
    description: `Swap tokens through the Chord router on the wallet's current chain. This sends real transactions from the wallet: get a quote with chord_get_swap_quote first and swap only after it is confirmed. For an ERC-20 input it first approves the Chord router (${CHORD_ROUTER_ADDRESS}) for exactly the swap amount if the allowance is too low. The swap is simulated from the wallet first and not sent if the simulation fails. ${NATIVE_NOTE} ${AMOUNT_NOTE} ${ADDRESS_NOTE} Supported chains: ${SUPPORTED_CHAIN_LIST}.`,
  })
  async swap(wallet: EVMWalletClient, parameters: SwapParameters) {
    let approvalTxHash: string | undefined;
    const withApproval = () => (approvalTxHash ? { approvalTxHash } : {});
    try {
      const chainId = chainIdOf(wallet);
      const walletAddress = wallet.getAddress() as Address;
      const { from, to, amountIn } = await this.#resolve(wallet, chainId, parameters);

      const balance = await getBalance(wallet, from);
      if (balance < amountIn) {
        return {
          success: false,
          error: `Insufficient ${from.symbol} balance: have ${formatUnits(balance, from.decimals)}, need ${parameters.amount}`,
        };
      }

      const slippageBps = parameters.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
      let quote = await this.#quote(chainId, from, to, amountIn, slippageBps);
      if (!hasRoute(quote)) return noRoute(quote, from, to, parameters.amount);

      if (!from.isNative) {
        const allowance = await getAllowance(wallet, from.address, CHORD_ROUTER_ADDRESS);
        if (allowance < amountIn) {
          if (allowance > 0n && needsApproveReset(chainId, from.address)) {
            const reset = await sendApprove(wallet, from.address, 0n);
            approvalTxHash = reset.hash;
            if (reset.reverted) {
              return {
                success: false,
                error: "Allowance reset transaction reverted",
                ...withApproval(),
              };
            }
          }
          const approval = await sendApprove(wallet, from.address, amountIn);
          approvalTxHash = approval.hash;
          if (approval.reverted) {
            return { success: false, error: "Approval transaction reverted", ...withApproval() };
          }
          // Waiting for the approval can outlast the quote's validity, so quote again.
          quote = await this.#quote(chainId, from, to, amountIn, slippageBps);
          if (!hasRoute(quote)) {
            return { ...noRoute(quote, from, to, parameters.amount), ...withApproval() };
          }
        }
      }

      const transaction = await this.#build(chainId, quote, walletAddress, slippageBps);
      const simulation = await this.#client.simulate(simulationOf(transaction, walletAddress));
      if (!simulation.ok) {
        return {
          success: false,
          error: `Swap simulation failed: ${simulation.revert ?? "reverted"}${simulation.selector ? ` (${simulation.selector})` : ""}`,
          ...withApproval(),
        };
      }

      const outBefore = to.isNative ? null : await getBalance(wallet, to);
      const sent = await wallet.sendTransaction({
        to: transaction.to,
        data: transaction.data,
        value: BigInt(transaction.value || "0"),
      });
      if ((sent as { status?: string }).status === "reverted") {
        return {
          success: false,
          error: "Swap transaction reverted",
          transactionHash: sent.hash,
          ...withApproval(),
        };
      }

      const summary = summarizeQuote(quote, from, to);
      let amountReceived: string | null = null;
      if (outBefore !== null) {
        amountReceived = formatUnits((await getBalance(wallet, to)) - outBefore, to.decimals);
      }

      return {
        success: true,
        network: CHORD_SUPPORTED_CHAINS[chainId].name,
        chainId,
        transactionHash: sent.hash,
        ...withApproval(),
        fromToken: summary.fromToken,
        toToken: summary.toToken,
        expectedAmountOut: summary.expectedAmountOut,
        minimumAmountOut: summary.minimumAmountOut,
        ...(amountReceived !== null ? { amountReceived } : {}),
        route: summary.route,
      };
    } catch (error) {
      return {
        success: false,
        error: `Error swapping tokens: ${errorMessage(error)}`,
        ...withApproval(),
      };
    }
  }

  /**
   * Resolves token details and the input amount in the smallest unit.
   *
   * @param wallet - The wallet client.
   * @param chainId - The chain id.
   * @param parameters - Tool parameters.
   * @returns Input and output token details and the raw input amount.
   */
  async #resolve(
    wallet: EVMWalletClient,
    chainId: number,
    parameters: { fromToken: string; toToken: string; amount: string },
  ): Promise<{ from: TokenInfo; to: TokenInfo; amountIn: bigint }> {
    const fromAddress = normalizeToken(chainId, parameters.fromToken);
    const toAddress = normalizeToken(chainId, parameters.toToken);
    if (fromAddress === toAddress) throw new Error("fromToken and toToken are the same token");
    const [from, to] = await Promise.all([
      getTokenInfo(wallet, chainId, fromAddress),
      getTokenInfo(wallet, chainId, toAddress),
    ]);
    const amountIn = parseUnits(parameters.amount, from.decimals);
    if (amountIn <= 0n) throw new Error("amount must be greater than zero");
    return { from, to, amountIn };
  }

  /**
   * Requests a quote.
   *
   * @param chainId - The chain id.
   * @param from - Input token.
   * @param to - Output token.
   * @param amountIn - Input amount in the smallest unit.
   * @param slippageBps - Slippage in basis points.
   * @returns The quote body.
   */
  #quote(
    chainId: number,
    from: TokenInfo,
    to: TokenInfo,
    amountIn: bigint,
    slippageBps: number | undefined,
  ): Promise<ChordQuoteResponse> {
    return this.#client.getQuote({
      chainId,
      inputMint: from.address,
      outputMint: to.address,
      amount: amountIn,
      slippageBps: slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    });
  }

  /**
   * Builds the swap transaction and checks it targets the Chord router on the wallet's chain.
   *
   * @param chainId - The chain id.
   * @param quote - The quote, unmodified.
   * @param walletAddress - Sender and recipient.
   * @param slippageBps - Slippage the quote was requested with.
   * @returns The unsigned transaction.
   */
  async #build(
    chainId: number,
    quote: ChordQuoteResponse,
    walletAddress: Address,
    slippageBps: number,
  ): Promise<UnsignedTransaction> {
    const built = await this.#client.buildSwap({
      chainId,
      quote,
      userAddress: walletAddress,
      slippageBps,
    });
    return checkedTransaction(built.transaction, chainId);
  }
}

/**
 * Returns the wallet's chain id, or throws when Chord does not support it.
 *
 * @param wallet - The wallet client.
 * @returns The chain id.
 */
function chainIdOf(wallet: EVMWalletClient): number {
  const chainId = Number(wallet.getChain().id);
  if (!CHORD_SUPPORTED_CHAINS[chainId])
    throw new Error(`Chain ${chainId} is not supported by Chord`);
  return chainId;
}

/**
 * Refuses a built transaction that does not target the Chord router on the expected chain.
 *
 * @param tx - Transaction from the API.
 * @param chainId - The wallet's chain id.
 * @returns The transaction in the shape the tools return.
 */
function checkedTransaction(tx: ChordSwapTransaction, chainId: number): UnsignedTransaction {
  if (tx.to.toLowerCase() !== CHORD_ROUTER_ADDRESS) {
    throw new Error(`Refusing transaction to ${tx.to}: expected the Chord router`);
  }
  if (Number(tx.chainId) !== chainId) {
    throw new Error(`Refusing transaction for chain ${tx.chainId}: wallet is on ${chainId}`);
  }
  return { to: tx.to as Address, data: tx.data as Hex, value: tx.value || "0", chainId };
}

/**
 * Turns a built transaction into the body of a simulation from the wallet.
 *
 * @param tx - The built transaction.
 * @param from - The wallet address.
 * @returns Simulation parameters.
 */
function simulationOf(tx: UnsignedTransaction, from: Address) {
  return { chainId: tx.chainId, from, to: tx.to, data: tx.data, value: tx.value };
}

/**
 * Encodes an approval of the Chord router.
 *
 * @param chainId - The chain id.
 * @param token - ERC-20 token.
 * @param amount - Allowance to set.
 * @returns The unsigned approval transaction.
 */
function approvalTx(chainId: number, token: Address, amount: bigint): UnsignedTransaction {
  return {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [CHORD_ROUTER_ADDRESS, amount],
    }),
    value: "0",
    chainId,
  };
}

/**
 * Sends an approval of the Chord router from the wallet.
 *
 * @param wallet - The wallet client.
 * @param token - ERC-20 token.
 * @param amount - Allowance to set.
 * @returns The hash and whether the receipt says it reverted.
 */
async function sendApprove(
  wallet: EVMWalletClient,
  token: Address,
  amount: bigint,
): Promise<{ hash: string; reverted: boolean }> {
  const sent = await wallet.sendTransaction({
    to: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [CHORD_ROUTER_ADDRESS, amount],
  });
  return { hash: sent.hash, reverted: (sent as { status?: string }).status === "reverted" };
}

/**
 * Returns true when the quote carries a route.
 *
 * @param quote - The `/quote` body.
 * @returns Whether there is a route.
 */
function hasRoute(quote: ChordQuoteResponse): boolean {
  return Array.isArray(quote.routePlan) && quote.routePlan.length > 0;
}

/**
 * Builds the answer for a quote without a route.
 *
 * @param quote - The `/quote` body.
 * @param from - Input token details.
 * @param to - Output token details.
 * @param amount - Amount requested, whole units.
 * @returns A failure object naming the reason.
 */
function noRoute(quote: ChordQuoteResponse, from: TokenInfo, to: TokenInfo, amount: string) {
  const reason = quote.noRouteReason ?? "NO_ROUTE";
  const hint =
    reason === "INSUFFICIENT_LIQUIDITY" ? " Try a smaller amount." : " No pool connects them.";
  return {
    success: false,
    noRouteReason: reason,
    error: `No route to swap ${amount} ${from.symbol} for ${to.symbol}.${hint}`,
  };
}

/**
 * Formats an error for the agent.
 *
 * @param error - Any thrown value.
 * @returns A short message.
 */
function errorMessage(error: unknown): string {
  if (error instanceof ChordApiError)
    return `${error.code} (HTTP ${error.status}): ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
