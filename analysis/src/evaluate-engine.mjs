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
const noise = JSON.parse(await readFile(join(dataDir, "false-positives.json"), "utf8"));

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

// The measurement that decides whether anyone keeps this switched on. Checked here rather than
// left in a README, because a number nothing verifies is a number that drifts.
const noiseFactShare = noise.perCounterparty.onAFact / noise.perCounterparty.flagged;
const noiseQuietShare = noise.perWallet.quiet / noise.wallets;

console.log(`\nOn ${noise.wallets} randomly sampled wallets (${noise.counterparties} counterparties):`);
console.log(`  warnings resting on a fact       ${(noiseFactShare * 100).toFixed(1)}%`);
console.log(`  wallets that saw nothing at all  ${(noiseQuietShare * 100).toFixed(1)}%`);

/**
 * The share of those "facts" that survive being checked against the chain.
 *
 * A warning that says "somebody fabricated a record of you paying this address" is either true or
 * it is not, and `reconcile` settles which by asking the token whether its balances moved the way
 * its logs claim. Reporting the share of fact-warnings without checking them would be counting
 * the detector's own opinion of itself.
 */
const factsChecked = noise.factWarnings.right + noise.factWarnings.wrong;
const factsHeldUp = factsChecked === 0 ? 1 : noise.factWarnings.right / factsChecked;

console.log(`  of those, checked against chain  ${factsChecked}`);
console.log(`  and found to be true             ${(factsHeldUp * 100).toFixed(1)}%`);
console.log(
  `  records where value really moved (so not a fabrication at all): ` +
    `${noise.unsignedOutgoing.stateAgrees} of ${noise.unsignedOutgoing.checked} checked`,
);

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
  if (noiseFactShare < 0.8) {
    problems.push(
      `only ${(noiseFactShare * 100).toFixed(1)}% of warnings rest on a fact, expected >= 80% — ` +
        `the detector has started guessing more than it knows`,
    );
  }
  if (noiseQuietShare < 0.4) {
    problems.push(
      `only ${(noiseQuietShare * 100).toFixed(1)}% of sampled wallets saw nothing, expected >= 40% — ` +
        `a tool this noisy gets switched off`,
    );
  }
  if (noise.unsignedOutgoing.checked === 0) {
    problems.push(
      `not one unsigned record could be reconciled against the chain, so the fact-check below ` +
        `proves nothing — check the archive endpoint before believing the rest`,
    );
  }
  /**
   * The floor sits below the 100% actually measured, on purpose.
   *
   * A warning that calls a record fabricated is either right or wrong, and the chain settles it.
   * Pinning the gate at the measured 100% would fail CI the first time one legitimate settlement
   * slipped into a sample, which is noise rather than regression. What must not happen quietly is
   * the detector drifting into asserting fabrications that did not occur.
   */
  if (factsChecked > 0 && factsHeldUp < 0.95) {
    problems.push(
      `only ${(factsHeldUp * 100).toFixed(1)}% of fact-warnings survived being checked against ` +
        `the chain, expected >= 95% — the detector is calling real movements fabrications`,
    );
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
