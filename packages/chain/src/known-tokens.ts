import type {KnownToken} from "./history.js";

/**
 * The tokens known for certain, per chain: what a dust threshold can be put on, and the strong
 * tier of the token check.
 *
 * This is **not** the list the Scan screen walks — that would make the attack invisible, because
 * the bait is always a contract the attacker deployed. Scanning is by topic across every token.
 * This table supplies decimals so a small inbound amount can be called dust rather than guessed
 * at, and a namesake of one of these at any other address is counterfeit outright. The weak tier,
 * a few hundred names that only earn a second look, is `LISTED_TOKENS`.
 *
 * Kept here rather than in the web app so that the app, the replay in `test/` and the scripts in
 * `analysis/` read one list. Each of them used to hold its own copy, kept in step by hand.
 */
export const KNOWN_TOKENS: Readonly<Partial<Record<number, readonly KnownToken[]>>> = {
  1: [
    {address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6, dustBelow: 1},
    {address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, dustBelow: 1},
    {address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8, dustBelow: 0.0001},
  ],
};
