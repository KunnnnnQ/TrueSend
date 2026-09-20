/**
 * Fail if contract coverage drops below where it has already been.
 *
 *   forge coverage --no-match-coverage "test|script" --report summary | node tools/coverage-gate.mjs
 *
 * Coverage that is only ever reported is coverage that quietly erodes. The floors below are set
 * at what the suite actually achieves rather than at a round number, because the point is to stop
 * a regression rather than to hit a target.
 *
 * Branches sit at 100 deliberately. A coverage report once named eighteen untaken branches in
 * this project and every one of them was an error path — a policy that had never been shown to
 * refuse an uninitialised account, a queue that had never been shown to refuse a second
 * cancellation, a cooldown that had never been shown to refuse zero. In contracts whose whole job
 * is refusing things, an untaken branch is a refusal that has never once happened.
 *
 * Raising a floor after improving coverage is the intended workflow. Lowering one should need an
 * argument in the commit message.
 */

const FLOORS = {lines: 95, statements: 96, branches: 100, functions: 91};

const report = await read(process.stdin);
process.stdout.write(report);

const total = report.split("\n").find((line) => line.startsWith("| Total"));
if (!total) {
  console.error("\ncoverage-gate: no `| Total` row in the report. Did forge coverage run?");
  process.exit(1);
}

const percents = [...total.matchAll(/([0-9.]+)%/g)].map((match) => Number(match[1]));
if (percents.length < 4) {
  console.error(`\ncoverage-gate: expected four percentages in the Total row, found ${percents.length}`);
  process.exit(1);
}

const actual = {
  lines: percents[0],
  statements: percents[1],
  branches: percents[2],
  functions: percents[3],
};

console.log("");
let failed = false;
for (const [name, floor] of Object.entries(FLOORS)) {
  const value = actual[name];
  const ok = value >= floor;
  if (!ok) failed = true;
  console.log(`${name.padEnd(11)} ${value.toFixed(2).padStart(6)}%   floor ${floor}%   ${ok ? "ok" : "BELOW FLOOR"}`);
}

if (failed) {
  console.error(
    "\ncoverage-gate: coverage went backwards. Add the missing cases, or lower the floor in " +
      "tools/coverage-gate.mjs and say why in the commit message.",
  );
  process.exit(1);
}

function read(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}
