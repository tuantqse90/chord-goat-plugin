import { Chain, PluginBase } from "@goat-sdk/core";
import { EVMWalletClient } from "@goat-sdk/wallet-evm";
import { ChordPluginOptions, ChordService } from "./chord.service";
import { CHORD_SUPPORTED_CHAINS } from "./constants";

/**
 * GOAT plugin for Chord: token search, best-route quotes, unsigned swap transactions and swaps
 * through the Chord router.
 */
export class ChordPlugin extends PluginBase<EVMWalletClient> {
  /**
   * Creates the plugin.
   *
   * @param options - Optional API key and base URL.
   */
  constructor(options: ChordPluginOptions = {}) {
    super("chord", [new ChordService(options)]);
  }

  /**
   * Checks whether the wallet's chain is one the Chord router is deployed on.
   *
   * @param chain - The chain to check.
   * @returns True for the supported EVM chains.
   */
  supportsChain = (chain: Chain): boolean =>
    chain.type === "evm" && Number(chain.id) in CHORD_SUPPORTED_CHAINS;
}

/**
 * Creates the Chord plugin.
 *
 * @param options - Optional API key and base URL.
 * @returns The plugin.
 */
export function chord(options: ChordPluginOptions = {}): ChordPlugin {
  return new ChordPlugin(options);
}
