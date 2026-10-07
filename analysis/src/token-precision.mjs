/**
 * Does the token detector cry wolf on tokens that are fine?
 *
 *   node src/token-precision.mjs [--check]
 *
 * Every other number about the token rules measures whether they *catch* counterfeits. That is half
 * of what decides whether anybody keeps them switched on. The rule that does most of the work is
 * "a real ticker is plain ASCII", and the honest objection to it is that plenty of real tokens are
 * not: names and symbols in Chinese, Cyrillic, Korean. A detector that flags those is a detector
 * that gets muted, and one that is muted protects nobody.
 *
 * So this runs the shipped rules over two published lists of legitimate tokens and counts. The
 * first is Uniswap's default list, which is curated. The second is CoinGecko's, which is broad and
 * does contain junk, so what it flags has to be read rather than counted.
 *
 * Nothing here is fetched from a chain. The lists are the whole input.
 */

import {execFileSync} from "node:child_process";
import {writeFile, mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import {LISTED_TOKENS, LISTED_TOKENS_SOURCE} from "@truesend/chain";
import {inspectToken, revealSymbol} from "@truesend/engine";

const CHECK = process.argv.includes("--check");
const here = dirname(fileURLToPath(import.meta.url));

/** The same list the app checks against; see `KNOWN_TOKENS` in `apps/web/src/lib/chains.ts`. */
const CANONICAL = [
  {symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7"},
  {symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"},
  {symbol: "WBTC", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"},
];

// curl rather than fetch: Node's fetch could not reach these hosts from this machine when curl could.
function download(url) {
  const raw = execFileSync("curl", ["-s", "-m", "60", "-L", url], {encoding: "utf8", maxBuffer: 64 * 1024 * 1024});
  return JSON.parse(raw);
}

const LISTS = [
  {
    name: "Uniswap default list (curated)",
    url: "https://raw.githubusercontent.com/Uniswap/default-token-list/main/src/tokens/mainnet.json",
    tokens: (json) => json,
  },
  {
    name: "CoinGecko (broad; contains junk)",
    url: "https://tokens.coingecko.com/uniswap/all.json",
    tokens: (json) => json.tokens.filter((t) => t.chainId === 1),
  },
];

const report = {measuredAt: new Date().toISOString(), lists: []};

for (const list of LISTS) {
  const tokens = list.tokens(download(list.url)).filter((t) => typeof t.symbol === "string" && t.address);
  const flagged = [];
  const byIssue = new Map();

  for (const token of tokens) {
    const findings = inspectToken(
      {symbol: token.symbol, address: token.address, ...(token.name ? {name: token.name} : {})},
      {canonical: CANONICAL},
    );
    if (findings.length === 0) continue;
    for (const f of findings) byIssue.set(f.issue, (byIssue.get(f.issue) ?? 0) + 1);
    flagged.push({
      address: token.address.toLowerCase(),
      symbol: revealSymbol(token.symbol),
      name: token.name ?? null,
      issues: findings.map((f) => f.issue),
    });
  }

  const share = flagged.length / tokens.length;
  console.log(`\n${list.name}`);
  console.log(`  ${tokens.length} tokens, ${flagged.length} flagged (${(share * 100).toFixed(2)}%)`);
  for (const [issue, n] of [...byIssue.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${issue.padEnd(30)} ${n}`);
  }
  for (const f of flagged.slice(0, 14)) {
    console.log(`  - ${f.symbol.slice(0, 30).padEnd(30)} ${(f.name ?? "").slice(0, 26).padEnd(26)} ${f.issues.join(",")}`);
  }
  if (flagged.length > 14) console.log(`  … and ${flagged.length - 14} more, in data/token-precision.json`);

  report.lists.push({
    name: list.name,
    source: list.url,
    tokens: tokens.length,
    flagged: flagged.length,
    share,
    byIssue: Object.fromEntries(byIssue),
    flaggedTokens: flagged,
  });
}

/**
 * The second tier, measured the same way.
 *
 * `LISTED_TOKENS` is Uniswap's default list, pinned in @truesend/chain. Across CoinGecko's list, a
 * token sharing a listed ticker at another contract gets `listed-symbol-wrong-contract`. That is
 * never a counterfeit verdict on its own — `judgeToken` needs the token used against the account
 * first — so what is counted here is the line a holder of a legitimate namesake would see.
 */
const listed = LISTED_TOKENS[1] ?? [];
const listedTier = {source: LISTED_TOKENS_SOURCE, listedTokens: listed.length, lists: []};
for (const list of LISTS) {
  const tokens = list.tokens(download(list.url)).filter((t) => typeof t.symbol === "string" && t.address);
  const namesakes = tokens
    .filter((token) =>
      inspectToken({symbol: token.symbol, address: token.address}, {canonical: CANONICAL, listed}).some(
        (f) => f.issue === "listed-symbol-wrong-contract",
      ),
    )
    .map((token) => ({address: token.address.toLowerCase(), symbol: revealSymbol(token.symbol), name: token.name ?? null}));

  console.log(`\nListed tier over ${list.name}: ${namesakes.length} of ${tokens.length} share a listed ticker at another contract`);
  for (const n of namesakes.slice(0, 14)) console.log(`  - ${n.symbol.slice(0, 20).padEnd(20)} ${(n.name ?? "").slice(0, 40)}`);
  listedTier.lists.push({name: list.name, tokens: tokens.length, namesakes: namesakes.length, share: namesakes.length / tokens.length, tokensFound: namesakes});
}
report.listedTier = listedTier;

await mkdir(join(here, "..", "data"), {recursive: true});
const path = join(here, "..", "data", "token-precision.json");
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${path}`);

if (CHECK) {
  const curated = report.lists[0];
  const problems = [];
  // The curated list is the one that should be nearly clean. The threshold is the point at which a
  // user would start seeing a warning on tokens they hold and trust, not a target to hit.
  if (curated.share > 0.02) {
    problems.push(
      `${(curated.share * 100).toFixed(1)}% of a curated list of legitimate tokens is flagged, expected <= 2% — ` +
        `the detector has started crying wolf`,
    );
  }
  if (problems.length) {
    console.log("\nFAILED:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}
