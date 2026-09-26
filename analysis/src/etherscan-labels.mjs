/**
 * How many planted lookalikes has Etherscan already labelled?
 *
 *   node src/etherscan-labels.mjs [--sample 30]
 *
 * Etherscan marks addresses it knows to be phishing — `Fake_Phishing1064860`, on the page instead
 * of the hex — and that is a real protection: an address the user is shown as a name is not one
 * they can mistake for another by its first and last characters. The question a project like this
 * has to answer honestly is how much of the problem it already covers, and the label is the part
 * that can be counted.
 *
 * It takes a deterministic spread of the planted addresses in `data/scan-latest.json` and looks each
 * up. Before trusting a single "no label" it checks the instrument on two pages whose answer is
 * already known — one labelled, one not — because an earlier version of this measurement used
 * Node's fetch, which could not reach the site from this machine, and reported "0 of 30 checked" as
 * though that were a result. It is not; it is an instrument that saw nothing.
 *
 * Goes through curl, a request every two and a half seconds, and reads nothing but the page.
 * Writes `data/etherscan-labels.json`.
 */

import {readFileSync} from "node:fs";
import {writeFile, mkdir} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {setTimeout as sleep} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", "data");

const args = process.argv.slice(2);
const sampleIndex = args.indexOf("--sample");
const N = Number(sampleIndex >= 0 ? args[sampleIndex + 1] : 30);

const scan = JSON.parse(readFileSync(join(dataDir, "scan-latest.json"), "utf8"));
const planted = [...new Set(scan.pairs.map((p) => p.planted))];
const step = Math.floor(planted.length / N);
const sample = Array.from({length: N}, (_, i) => planted[(i * step + 7) % planted.length]);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const KNOWN_LABELLED = "0x791685Bbd7EC45d566CcB2d8d96c7eF3BdD541c0";
const KNOWN_PLAIN = "0x28582509B138d2722bcAED3701140F2Fd270bf63";

function fetchPage(address) {
  try {
    return execFileSync(
      "curl",
      ["-s", "-m", "25", "-A", UA, "-w", "\n__HTTP__%{http_code}", `https://etherscan.io/address/${address}`],
      {encoding: "utf8", maxBuffer: 20 * 1024 * 1024},
    );
  } catch {
    return null;
  }
}

function classify(raw) {
  if (raw === null) return {status: "error"};
  const code = raw.slice(raw.lastIndexOf("__HTTP__") + 8).trim();
  if (code !== "200") return {status: `HTTP ${code}`};
  const html = raw.slice(0, raw.lastIndexOf("\n__HTTP__"));
  const label = html.match(/Fake_Phishing\d+|Phish[_-]?Hack\d*|Fake_[A-Za-z]+\d*|Exploiter\d*|Scam[A-Za-z_]*\d*/)?.[0];
  return {status: "ok", label: label ?? null};
}

console.log("Calibrating the instrument on two pages whose answer is already known:");
const positive = classify(fetchPage(KNOWN_LABELLED));
const negative = classify(fetchPage(KNOWN_PLAIN));
console.log(`  known-labelled   -> ${positive.status} ${positive.label ?? "(no label seen)"}`);
console.log(`  known-unlabelled -> ${negative.status} ${negative.label ?? "(no label seen)"}`);
if (positive.status !== "ok" || !positive.label || negative.label) {
  console.log("\nThe instrument does not read labels correctly. Stopping: any number below would be meaningless.");
  process.exit(1);
}

console.log(`\n${planted.length} distinct planted addresses in the committed sample; checking ${sample.length}\n`);
const results = [];
for (const address of sample) {
  const result = classify(fetchPage(address));
  results.push({address, ...result});
  const short = `${address.slice(0, 12)}…${address.slice(-6)}`;
  console.log(short, result.status !== "ok" ? result.status : result.label ? `LABELLED ${result.label}` : "no label");
  await sleep(2500);
}

const checked = results.filter((r) => r.status === "ok");
const labelled = checked.filter((r) => r.label);
// Wilson score interval at 95%: a sample this small has to say how much it does not know.
const z = 1.96;
const n = checked.length;
const p = labelled.length / n;
const denom = 1 + (z * z) / n;
const centre = (p + (z * z) / (2 * n)) / denom;
const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;

console.log(`\nchecked ${n}, labelled ${labelled.length} (${(p * 100).toFixed(0)}%), could not check ${results.length - n}`);
console.log(`95% interval for the true share: ${((centre - margin) * 100).toFixed(1)}% to ${((centre + margin) * 100).toFixed(1)}%`);

await mkdir(dataDir, {recursive: true});
await writeFile(
  join(dataDir, "etherscan-labels.json"),
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      plantedWindow: {fromBlock: scan.fromBlock, toBlock: scan.toBlock},
      sampled: results.length,
      checked: n,
      labelled: labelled.length,
      share: p,
      interval95: [centre - margin, centre + margin],
      instrumentCalibrated: {knownLabelled: positive.label, knownUnlabelled: negative.label},
      results,
    },
    null,
    2,
  )}\n`,
);
console.log("\nWrote data/etherscan-labels.json");
