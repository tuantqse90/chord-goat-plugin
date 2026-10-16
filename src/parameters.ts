import { createToolParameters } from "@goat-sdk/core";
import { z } from "zod";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "Invalid EVM address format");

const tokenSchema = (side: "sell" | "buy") =>
  addressSchema.describe(
    `Address of the token to ${side}. Use 0x0000000000000000000000000000000000000000 for the chain's native coin`,
  );

const swapShape = {
  fromToken: tokenSchema("sell"),
  toToken: tokenSchema("buy"),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "Invalid number format")
    .describe(
      "Amount of the input token in whole units, e.g. '1.5' for 1.5 ETH or '10' for 10 USDC",
    ),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe("Maximum slippage in basis points, 1-5000 (50 = 0.5%). Defaults to 50."),
};

/**
 * Parameters of the token search tool.
 */
export class SearchTokensParameters extends createToolParameters(
  z.object({
    query: z
      .string()
      .min(1)
      .max(64)
      .describe("Token symbol, name or address fragment, e.g. 'USDC' or 'wrapped ether'"),
  }),
) {}

/**
 * Parameters of the quote, build and swap tools.
 */
export class SwapParameters extends createToolParameters(z.object(swapShape)) {}
