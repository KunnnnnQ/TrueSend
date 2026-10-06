/**
 * Rehearse the Sepolia deployment on a local fork, in one command.
 *
 *   node tools/rehearse-sepolia.mjs
 *
 * Runs Deploy, RegisterSchema and Smoke - steps 1 to 3 of docs/deploy-sepolia.md - against
 * `anvil --fork-url`: Sepolia's real state, including the real EAS contracts the registry step
 * registers against, served from this machine. Nothing is sent to Sepolia and no key of yours is
 * involved.
 *
 * It signs as close to the real deployment as a script can: a freshly generated encrypted keystore,
 * funded on the fork only, and no `--sender`. Not identically, and the difference has already
 * mattered once. The real run types the password into forge's prompt, which unlocks the keystore
 * after forge has decided who calls the script's `run()` - so `msg.sender` there is forge's default
 * address, 0x1804c8AB..., not the deployer. A script cannot answer that prompt (on Windows it reads
 * the console, not stdin; tried), so this passes the password with `--password`, which unlocks
 * early and makes `msg.sender` the deployer. On 2026-10-06 that hid a real bug: Smoke.s.sol took
 * `msg.sender` to be the deployer, passed every rehearsal, and failed with `Unauthorized()` on the
 * first real Sepolia run. The scripts now read the broadcasting account from inside a broadcast,
 * and CI fails any script that reads `msg.sender`, so this difference cannot matter again - but it
 * is a difference, and it is written down here rather than assumed away.
 *
 * It works in a temporary copy of `contracts/`, never in this repository. The scripts write
 * `deployments/11155111.json` and `deployments/registry-11155111.json`, and a fork keeps Sepolia's
 * chain id, so written in place those files would be indistinguishable from a real deployment
 * record - addresses that exist on no network at all, one `git add` away from being committed and
 * read by the app. The copy costs a few seconds. The temporary directory and the fork are both
 * removed at the end, whether the rehearsal passed or not.
 *
 * Ends by saying what the deployment costs at Sepolia's gas price right now - using the gas the
 * real deployment measurably used, because the fork cannot tell: it charges by the `prague` rules
 * forge knows, and Sepolia has since repriced storage creation. That is the second difference from
 * the real run, after the password above, and it hid the second real failure: this rehearsal
 * passed a smoke test that then ran out of gas on Sepolia (docs/deploy-sepolia.md, step 3).
 *
 * Needs Foundry (on PATH, or in .tools/foundry/) and the contract libraries checked out
 * (`git submodule update --init`), and nothing else: it imports no packages, so it runs before
 * `pnpm install` too. SEPOLIA_RPC_URL picks the endpoint; the default is the one .env.example
 * names. Console output is plain ASCII so that it reads the same in any Windows code page.
 */

import {spawn} from "node:child_process";
import {cpSync, existsSync, mkdirSync, mkdtempSync, rmSync} from "node:fs";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {basename, dirname, join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = join(ROOT, "contracts");
const RPC = process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const SEPOLIA = 11_155_111;
/** Protects a throwaway keystore that exists for one run, inside the temporary copy. */
const PASSWORD = "rehearsal";
/**
 * The three scripts, with the flags docs/deploy-sepolia.md gives each - a rehearsal of a different
 * command is a rehearsal of nothing. Smoke's `--slow -g 1000` is there because Sepolia now prices
 * storage creation well above the `prague` rules forge estimates with; the fork prices by forge's
 * rules, so here the margin changes nothing, but the command is the one that will run for real.
 */
const STEPS = [
  ["Deploy", []],
  ["RegisterSchema", []],
  ["Smoke", ["--slow", "-g", "1000"]],
];

/**
 * Gas the real deployment on Sepolia used, 2026-10-06, from its broadcast receipts: Deploy
 * 4,525,269, RegisterSchema 1,191,927, Smoke 2,331,041. The fork cannot measure this - it charges by
 * forge's `prague` rules, under which Smoke cost less than a third of what Sepolia charged - so the
 * cost this prints is the measured figure at today's gas price, not the fork's.
 */
const REAL_DEPLOYMENT_GAS = 8_048_237;
/** What the scripts read to build: everything else in `contracts/` is tests and build output. */
const NEEDED = ["foundry.toml", "remappings.txt", "src", "script", "lib"];

const FORGE = foundry("forge");
const ANVIL = foundry("anvil");
const CAST = foundry("cast");

let anvil;
let work;

process.on("SIGINT", () => {
  console.error("\nInterrupted.");
  cleanup();
  process.exit(130);
});

main().then(cleanup, (error) => fail(error instanceof Error ? error.message : String(error)));

async function main() {
  console.log("TrueSend: rehearsing the Sepolia deployment on a local fork\n");

  if (!existsSync(join(CONTRACTS, "lib", "forge-std", "src", "Script.sol"))) {
    fail("The contract libraries are not checked out. Run `git submodule update --init` first.");
  }
  const version = await run(FORGE, ["--version"], {cwd: ROOT}).catch(() => undefined);
  if (version?.code !== 0) {
    fail("Foundry was not found. Install it (https://getfoundry.sh), or put it in .tools/foundry/.");
  }

  work = mkdtempSync(join(tmpdir(), "truesend-rehearsal-"));
  for (const entry of NEEDED) {
    // `.git` inside each library is a pointer into this repository's own `.git`; a copy has no use
    // for it, and git would only complain about the path it points to.
    cpSync(join(CONTRACTS, entry), join(work, entry), {
      recursive: true,
      filter: (source) => basename(source) !== ".git",
    });
  }
  mkdirSync(join(work, "deployments"));

  const port = await freePort();
  const local = `http://127.0.0.1:${port}`;
  let anvilErrors = "";
  anvil = spawn(ANVIL, ["--fork-url", RPC, "--port", String(port), "--silent"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  anvil.stderr.on("data", (chunk) => (anvilErrors += chunk));

  const chainId = await waitForChain(local, () => anvilErrors);
  if (chainId !== SEPOLIA) {
    fail(`${RPC} is chain ${chainId}, not Sepolia (${SEPOLIA}). Point SEPOLIA_RPC_URL at a Sepolia endpoint.`);
  }
  const block = Number(await rpc(local, "eth_blockNumber"));
  console.log(`Forked Sepolia at block ${block.toLocaleString("en-US")}, from ${RPC}.`);

  // A deployer as close to the real one as a script can get - a new encrypted keystore, no
  // `--sender` - with the one difference the header describes. Funded on the fork alone, and
  // deleted with the temporary copy.
  const keystores = join(work, "keystores");
  mkdirSync(keystores);
  const created = await run(CAST, ["wallet", "new", keystores, "deployer", "--unsafe-password", PASSWORD], {cwd: work});
  const deployer = created.out.match(/Address:\s*(0x[0-9a-fA-F]{40})/)?.[1];
  if (created.code !== 0 || !deployer) fail(`Could not create the rehearsal keystore:\n${created.out.trim()}`);
  await rpc(local, "anvil_setBalance", [deployer, "0x56BC75E2D63100000"]);
  console.log(`Deploying from a fresh keystore account, ${deployer}.`);
  console.log("Nothing below is sent to Sepolia. The first step also compiles, so it is the slowest.\n");

  for (const [index, [step, flags]] of STEPS.entries()) {
    const label = `[${index + 1}/${STEPS.length}] ${step}.s.sol `.padEnd(32, ".");
    const result = await run(
      FORGE,
      [
        "script",
        `script/${step}.s.sol`,
        "--rpc-url",
        local,
        "--broadcast",
        ...flags,
        "--keystore",
        join(keystores, "deployer"),
        "--password",
        PASSWORD,
      ],
      {cwd: work},
    );
    const out = result.out.replace(/\x1b\[[0-9;]*m/g, "");

    if (result.code !== 0 || !out.includes("ONCHAIN EXECUTION COMPLETE & SUCCESSFUL")) {
      console.log(`${label} FAILED\n`);
      console.log(out.trimEnd().split("\n").slice(-30).join("\n"));
      fail(`\n${step} failed on the fork. Do not deploy for real until it passes here.`);
    }

    const checks = step === "Smoke" ? `  (${out.match(/\[ok\]/g)?.length ?? 0} checks passed)` : "";
    console.log(`${label} ok${checks}`);
  }

  const price = Number(await rpc(RPC, "eth_gasPrice"));
  const cost = (REAL_DEPLOYMENT_GAS * price) / 1e18;
  console.log("\nPASSED. Nothing was sent to Sepolia, and nothing in this repository changed.");
  console.log(
    `Cost: the real deployment of 2026-10-06 used ${(REAL_DEPLOYMENT_GAS / 1e6).toFixed(2)}M gas, ` +
      `about ${cost.toFixed(4)} ETH at Sepolia's gas price right now (${(price / 1e9).toFixed(2)} gwei).`,
  );
  console.log("(The fork prices gas by forge's rules, which undercount Sepolia's today; see the header.)");
  console.log("Next: docs/deploy-sepolia.md, step 1.");
}

/** The copy vendored in .tools/foundry/ when there is one, otherwise whatever is on PATH. */
function foundry(name) {
  const vendored = join(ROOT, ".tools", "foundry", process.platform === "win32" ? `${name}.exe` : name);
  return existsSync(vendored) ? vendored : name;
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {...options, stdio: ["ignore", "pipe", "pipe"]});
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({code, out}));
  });
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method} at ${url}: ${body.error.message}`);
  return body.result;
}

/** Forking fetches Sepolia's latest state first, which takes a few seconds on a public endpoint. */
async function waitForChain(url, errors) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (anvil.exitCode !== null) fail(`anvil stopped before it was ready:\n${errors().trim()}`);
    try {
      return Number(await rpc(url, "eth_chainId"));
    } catch {
      await delay(300);
    }
  }
  fail(`The fork did not come up within 90 seconds. Is ${RPC} reachable?`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const {port} = server.address();
      server.close(() => resolve(port));
    });
  });
}

function cleanup() {
  if (anvil && anvil.exitCode === null) anvil.kill();
  if (work) {
    try {
      rmSync(work, {recursive: true, force: true});
    } catch {
      console.error(`(Could not delete the temporary copy at ${work}. Nothing in it is needed; delete it by hand.)`);
    }
    work = undefined;
  }
}

function fail(message) {
  console.error(message);
  cleanup();
  process.exit(1);
}
