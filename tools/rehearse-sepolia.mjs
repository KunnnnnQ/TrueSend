/**
 * Rehearse the Sepolia deployment on a local fork, in one command.
 *
 *   node tools/rehearse-sepolia.mjs
 *
 * Runs Deploy, RegisterSchema and Smoke - steps 1 to 3 of docs/deploy-sepolia.md - against
 * `anvil --fork-url`: Sepolia's real state, including the real EAS contracts the registry step
 * registers against, served from this machine. Nothing is sent to Sepolia and no key is involved:
 * anvil's first test account is funded and unlocked on the fork, and it is the sender.
 *
 * It works in a temporary copy of `contracts/`, never in this repository. The scripts write
 * `deployments/11155111.json` and `deployments/registry-11155111.json`, and a fork keeps Sepolia's
 * chain id, so written in place those files would be indistinguishable from a real deployment
 * record - addresses that exist on no network at all, one `git add` away from being committed and
 * read by the app. The copy costs a few seconds. The temporary directory and the fork are both
 * removed at the end, whether the rehearsal passed or not.
 *
 * Ends by saying what the real deployment would cost at Sepolia's gas price right now.
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
/** Anvil's first test account: funded and unlocked on every anvil chain, forks included. */
const SENDER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const STEPS = ["Deploy", "RegisterSchema", "Smoke"];
/** What the scripts read to build: everything else in `contracts/` is tests and build output. */
const NEEDED = ["foundry.toml", "remappings.txt", "src", "script", "lib"];

const FORGE = foundry("forge");
const ANVIL = foundry("anvil");

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
  console.log("Nothing below is sent to Sepolia. The first step also compiles, so it is the slowest.\n");

  let totalGas = 0;
  for (const [index, step] of STEPS.entries()) {
    const label = `[${index + 1}/${STEPS.length}] ${step}.s.sol `.padEnd(32, ".");
    const result = await run(
      FORGE,
      ["script", `script/${step}.s.sol`, "--rpc-url", local, "--broadcast", "--unlocked", "--sender", SENDER],
      {cwd: work},
    );
    const out = result.out.replace(/\x1b\[[0-9;]*m/g, "");

    if (result.code !== 0 || !out.includes("ONCHAIN EXECUTION COMPLETE & SUCCESSFUL")) {
      console.log(`${label} FAILED\n`);
      console.log(out.trimEnd().split("\n").slice(-30).join("\n"));
      fail(`\n${step} failed on the fork. Do not deploy for real until it passes here.`);
    }

    const gas = Number(out.match(/Estimated total gas used for script: (\d+)/)?.[1] ?? 0);
    totalGas += gas;
    const checks = step === "Smoke" ? `, ${out.match(/\[ok\]/g)?.length ?? 0} checks passed` : "";
    console.log(`${label} ok  (${gas.toLocaleString("en-US")} gas${checks})`);
  }

  const price = Number(await rpc(RPC, "eth_gasPrice"));
  const cost = (totalGas * price) / 1e18;
  console.log("\nPASSED. Nothing was sent to Sepolia, and nothing in this repository changed.");
  console.log(
    `The real deployment needs about ${(totalGas / 1e6).toFixed(1)}M gas: about ${cost.toFixed(4)} ETH ` +
      `at Sepolia's gas price right now (${(price / 1e9).toFixed(2)} gwei).`,
  );
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
