# chord-goat-plugin

Swap tools for [GOAT](https://github.com/goat-sdk/goat), backed by the [Chord](https://getchord.xyz) API.

Chord quotes every venue it indexes on a chain, splits an order across venues when that gives a better output, and settles the trade through one router contract (`0x1b1fee89a381e595fe6536b99ba91f3e16e9601a`, the same address on every chain below). Transactions are built by the API unsigned and signed by your GOAT wallet client; Chord never takes custody of keys or funds.

## Install

```bash
npm install chord-goat-plugin @goat-sdk/core @goat-sdk/wallet-evm viem zod
```

## Usage

```typescript
import { getOnChainTools } from "@goat-sdk/adapter-vercel-ai";
import { viem } from "@goat-sdk/wallet-viem";
import { chord } from "chord-goat-plugin";

const tools = await getOnChainTools({
  wallet: viem(walletClient), // any EVM wallet client on a supported chain
  plugins: [chord()],
});
```

The same plugin works with every GOAT adapter (Vercel AI SDK, LangChain, LlamaIndex, Eliza, MCP).

### Options

All fields are optional.

| Option | Env var | Description |
| --- | --- | --- |
| `apiKey` | `CHORD_API_KEY` | Sent as `X-API-Key`. Quotes and swaps work without a key at the public limit of 60 requests per minute per IP. |
| `baseUrl` |  | Defaults to `https://api.getchord.xyz/v1`. |

## Tools

| Tool | What it does |
| --- | --- |
| `chord_search_tokens` | Searches Chord's token index on the wallet's chain by symbol, name or address. Returns address, symbol, decimals and whether the token is on the chain's curated list. |
| `chord_get_swap_quote` | Best route for `amount` of `fromToken` into `toToken`: expected output after Chord's fee, the minimum the transaction enforces, price impact, fee and the venues used. Sends nothing. |
| `chord_build_swap_transaction` | The unsigned transactions for the swap: any ERC-20 approval still needed (exactly the input amount, to the Chord router) and the swap itself, checked to target the Chord router on the wallet's chain. When no approval is pending, the swap is simulated from the wallet. Signs and sends nothing. |
| `chord_swap` | Approves the router for exactly the input amount when the allowance is too low, quotes again, builds the transaction, checks its target and chain, simulates it from the wallet, and only then sends it. Returns the transaction hash and, for an ERC-20 output, the amount received. |

Amounts are given in whole units (`"1.5"` ETH, `"10"` USDC); the plugin reads decimals on-chain. The native coin is `0x0000000000000000000000000000000000000000` (`0xEeee...EEeE` is accepted too).

## Networks

The plugin is active when the wallet is on one of these chains:

| Chain             | Id    | Native coin |
| ----------------- | ----- | ----------- |
| Ethereum          | 1     | ETH         |
| Base              | 8453  | ETH         |
| Arbitrum One      | 42161 | ETH         |
| BNB Chain         | 56    | BNB         |
| Avalanche C-Chain | 43114 | AVAX        |
| Monad             | 143   | MON         |
| Robinhood Chain   | 4663  | ETH         |
| Arc               | 5042  | USDC        |

On Arc gas is paid in USDC. The plugin sends the USDC system contract (`0x3600...0000`, 6 decimals) for the native coin, so an Arc "native" input is approved and pulled like an ERC-20.

USDT on Ethereum rejects a new approval while an allowance is still open; the plugin resets it to zero first.

## Fees

Chord's fee is read on-chain per output token. The quote reports it as `feeBps` and `feeAmount`, and `expectedAmountOut` is already net of it.

## Development

```bash
npm install
npm test
npm run build
```

Unit tests mock HTTP and the wallet client, and register the tools through GOAT's own `@Tool` decorator.

## Links

- Docs: https://getchord.xyz/docs
- API reference (OpenAPI): https://getchord.xyz/docs/openapi.json
- GOAT: https://github.com/goat-sdk/goat

## License

MIT
