/**
 * Calibrate the instrument before trusting what it measures.
 *
 *   node src/check-reconcile.mjs
 *
 * `reconcile.mjs` decides whether value really left a wallet, and every false-positive number in
 * this project now rests on it. An instrument nobody checked is an instrument that quietly reads
 * whatever you hoped for, so this runs it against two records whose nature was already
 * established independently, by `verify-wbtc-case.mjs`, and asserts both.
 *
 * Both come from the same victim on the same afternoon, which is what makes them a good pair:
 *
 *   - the **bait** — a log reading "0.05 ETH" from a contract the attacker deployed, naming the
 *     victim as sender in a transaction `0x517dc8e5…` signed. Nothing moved. It must not come
 *     back `stateAgrees`, or the test would clear every fabrication in the project;
 *   - the **loss** — 1155.288 WBTC, genuinely sent, signed by the victim. Real value, real token.
 *     It must come back `stateAgrees`, or the test would call every settlement a fabrication and
 *     the product would cry wolf at solvers.
 *
 * The second case is signed by the owner, which `reconcile` neither knows nor cares about: it
 * asks the token what happened, not who asked for it. That is the point — a test that could only
 * recognise real movements when the owner signed them would be assuming the answer.
 *
 * Exits non-zero if either fails.
 */

import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import {ARCHIVE_ENDPOINTS, createClient} from "./rpc.mjs";
import {reconcile} from "./reconcile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const wbtc = JSON.parse(
  await readFile(join(here, "..", "data", "case-wbtc-2024-05-03.json"), "utf8"),
);

const archive = createClient(ARCHIVE_ENDPOINTS);

const cases = [
  {
    what: "the fabricated bait — a log from a contract the attacker deployed",
    record: {token: wbtc.bait.token, txHash: wbtc.bait.tx},
    expect: (verdict) => verdict !== "stateAgrees" && verdict !== "unknown",
    expected: "anything but stateAgrees",
    detail: `${wbtc.bait.rendersAs}, signed by ${wbtc.bait.signedBy}`,
  },
  {
    what: "the real loss — 1155.288 WBTC, genuinely sent",
    record: {token: wbtc.loss.token, txHash: wbtc.loss.tx},
    expect: (verdict) => verdict === "stateAgrees",
    expected: "stateAgrees",
    detail: `${wbtc.loss.amount} ${wbtc.loss.symbol}, signed by the victim`,
  },
];

console.log(`Calibrating reconcile() against ${cases.length} established records.`);
console.log(`Victim ${wbtc.victim}\n`);

let failed = false;

for (const testCase of cases) {
  const verdicts = await reconcile(archive, wbtc.victim, [testCase.record]);
  const {verdict, block} = verdicts.get(testCase.record) ?? {};
  const ok = testCase.expect(verdict);
  if (!ok) failed = true;

  console.log(`  ${testCase.what}`);
  console.log(`    ${testCase.detail}`);
  console.log(`    block ${block}  token ${testCase.record.token}`);
  console.log(`    ${verdict}   expected ${testCase.expected}   ${ok ? "ok" : "FAILED"}\n`);
}

if (failed) {
  console.error(
    "check-reconcile: the ground-truth test does not agree with two records whose nature is " +
      "already known. Every false-positive figure in analysis/README.md depends on it, so fix " +
      "this before believing any of them.",
  );
  process.exit(1);
}

console.log("Both as expected. The instrument reads true on the cases where the answer is known.");
