/**
 * Run the shipped detector against the real cases and report what it actually does.
 *
 *   node src/evaluate-engine.mjs [--check]
 *
 * This imports `@truesend/engine` from its built `dist`, exactly as the web app and the extension
 * do. Reimplementing the rules here in a notebook would measure a copy of the detector rather
 * than the detector, and the copy is the one thing that cannot ship.
 *
 * With `--check` it exits non-zero if the headline detection rate regresses, so the number in the
 * README cannot quietly rot.
 */

import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import {assessAddress} from "@truesend/engine";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");
const CHECK = process.argv.includes("--check");

/** Block times are ~12s; the engine takes unix seconds, so this is how a block becomes one. */
const SECONDS_PER_BLOCK = 12;
const asTime = (block) => block * SECONDS_PER_BLOCK;

const scan = JSON.parse(await readFile(join(dataDir, "scan-latest.json"), "utf8"));
const wbtc = JSON.parse(await readFile(join(dataDir, "case-wbtc-2024-05-03.json"), "utf8"));

console.log("Running the shipped engine against real mainnet activity.\n");

/**
 * Two ways an indexer can read the same chain.
 *
 * `naive` believes the log: a `Transfer` naming you as sender is a payment you made.
 * `signerAware` checks who signed the transaction and refuses to count a payment you never made.
 *
 * Every wallet history that shows these entries is built the naive way, which is the whole reason
 * the attack works.
 */
const MODES = ["naive", "signerAware"];

// ---------------------------------------------------------------------------
// Case 1: the 2024 WBTC loss. No lookalike is available to lean on.
// ---------------------------------------------------------------------------

console.log("Case 1 — WBTC, 2024-05-03, 1155.288 WBTC lost");
console.log(`  victim   ${wbtc.victim}`);
console.log(`  attacker ${wbtc.attacker}`);
console.log(`  bait     a ${JSON.stringify(wbtc.bait.symbol)} token log reading "${wbtc.bait.rendersAs}",`);
console.log(`           signed by ${wbtc.bait.signedBy}, not by the victim\n`);

const wbtcResults = {};
for (const mode of MODES) {
  const spoofedIsPayment = mode === "naive";
  const result = assessAddress({
    to: wbtc.attacker,
    now: asTime(wbtc.loss.block),
    history: [
      {
        address: wbtc.attacker,
        // The fabricated entry, read the way each indexer would read it.
        outgoingCount: spoofedIsPayment ? 1 : 0,
        ...(spoofedIsPayment ? {lastOutgoingAt: asTime(wbtc.bait.block)} : {}),
        spoofedOutgoingCount: spoofedIsPayment ? 0 : 1,
        incomingCount: 0,
        zeroValueIncoming: 0,
        dustIncoming: 0,
        firstSeenAt: asTime(wbtc.bait.block),
        lastSeenAt: asTime(wbtc.bait.block),
      },
    ],
  });
  wbtcResults[mode] = result;
  console.log(`  ${mode.padEnd(12)} score ${String(result.score).padStart(3)}  ${result.level.toUpperCase()}`);
  for (const finding of result.findings) console.log(`                 - ${finding.code}`);
  if (result.findings.length === 0) console.log(`                 (no findings at all)`);
}

// ---------------------------------------------------------------------------
// Case 2: everything the scan turned up, where a lookalike does exist.
// ---------------------------------------------------------------------------

console.log(`\nCase 2 — planted addresses, ${scan.token} blocks ${scan.fromBlock}..${scan.toBlock}`);
console.log(`  the scan matched ${scan.totals.lookalikePairs}; the ${scan.pairs.length} committed rows are scored here`);
console.log(`  (rerun scan-poisoning.mjs --sample 0 to score every one)\n`);

const tally = Object.fromEntries(MODES.map((m) => [m, {danger: 0, caution: 0, safe: 0}]));

for (const pair of scan.pairs) {
  for (const mode of MODES) {
    const spoofedIsPayment = mode === "naive";
    const result = assessAddress({
      to: pair.planted,
      now: asTime(pair.plantedAtBlock + 1),
      history: [
        {
          // The address the victim genuinely paid.
          address: pair.imitating,
          outgoingCount: 1,
          lastOutgoingAt: asTime(pair.realPaymentBlock),
          incomingCount: 0,
          zeroValueIncoming: 0,
          dustIncoming: 0,
          spoofedOutgoingCount: 0,
          firstSeenAt: asTime(pair.realPaymentBlock),
          lastSeenAt: asTime(pair.realPaymentBlock),
        },
        {
          // The planted lookalike.
          address: pair.planted,
          outgoingCount: spoofedIsPayment ? 1 : 0,
          ...(spoofedIsPayment ? {lastOutgoingAt: asTime(pair.plantedAtBlock)} : {}),
          spoofedOutgoingCount: spoofedIsPayment ? 0 : 1,
          incomingCount: 0,
          zeroValueIncoming: 0,
          dustIncoming: 0,
          firstSeenAt: asTime(pair.plantedAtBlock),
          lastSeenAt: asTime(pair.plantedAtBlock),
        },
      ],
    });
    tally[mode][result.level]++;
  }
}

const total = scan.pairs.length;
for (const mode of MODES) {
  const t = tally[mode];
  console.log(`  ${mode.padEnd(12)} danger ${String(t.danger).padStart(5)} (${pct(t.danger, total)})   ` +
    `caution ${String(t.caution).padStart(5)} (${pct(t.caution, total)})   ` +
    `safe ${String(t.safe).padStart(5)} (${pct(t.safe, total)})`);
}

// ---------------------------------------------------------------------------
// Control: does it stay quiet on ordinary payments?
// ---------------------------------------------------------------------------

console.log(`\nControl — the ${scan.pairs.length} genuine payments those lookalikes were imitating`);

const control = {danger: 0, caution: 0, safe: 0};
for (const pair of scan.pairs) {
  const result = assessAddress({
    to: pair.imitating,
    now: asTime(pair.realPaymentBlock + 1),
    history: [
      {
        address: pair.imitating,
        outgoingCount: 1,
        lastOutgoingAt: asTime(pair.realPaymentBlock),
        incomingCount: 0,
        zeroValueIncoming: 0,
        dustIncoming: 0,
        spoofedOutgoingCount: 0,
        firstSeenAt: asTime(pair.realPaymentBlock),
        lastSeenAt: asTime(pair.realPaymentBlock),
      },
    ],
  });
  control[result.level]++;
}
console.log(`  danger ${String(control.danger).padStart(5)} (${pct(control.danger, total)})   ` +
  `caution ${String(control.caution).padStart(5)} (${pct(control.caution, total)})   ` +
  `safe ${String(control.safe).padStart(5)} (${pct(control.safe, total)})`);
console.log(`  A real payee must land in "safe". Anything else is the tool crying wolf.`);

// ---------------------------------------------------------------------------

const headline = {
  wbtcNaive: wbtcResults.naive.level,
  wbtcSignerAware: wbtcResults.signerAware.level,
  pairsDangerNaive: tally.naive.danger / total,
  pairsDangerSignerAware: tally.signerAware.danger / total,
  controlFalseAlarms: (control.danger + control.caution) / total,
};

console.log("\nSummary");
console.log(`  WBTC case, naive indexer        ${headline.wbtcNaive}`);
console.log(`  WBTC case, signer-aware indexer ${headline.wbtcSignerAware}`);
console.log(`  planted addresses flagged danger ${pct(tally.signerAware.danger, total)} (signer-aware)`);
console.log(`  false alarms on real payees      ${pct(control.danger + control.caution, total)}`);

if (CHECK) {
  const problems = [];
  if (headline.wbtcSignerAware !== "danger") {
    problems.push(`the WBTC attacker scores "${headline.wbtcSignerAware}" with a signer-aware indexer, expected "danger"`);
  }
  if (headline.pairsDangerSignerAware < 0.9) {
    problems.push(`only ${pct(tally.signerAware.danger, total)} of planted addresses reach danger, expected >= 90%`);
  }
  if (headline.controlFalseAlarms > 0.01) {
    problems.push(`${pct(control.danger + control.caution, total)} of real payees raised an alarm, expected <= 1%`);
  }
  if (problems.length) {
    console.log("\nFAILED:");
    for (const problem of problems) console.log(`  - ${problem}`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

function pct(n, d) {
  return d === 0 ? "0%" : `${((n / d) * 100).toFixed(1)}%`;
}
