/**
 * Print the web app's contract-address variables from the committed deployment records.
 *
 *   node tools/deployment-env.mjs                        prints NEXT_PUBLIC_...=0x... lines
 *   node tools/deployment-env.mjs >> "$GITHUB_ENV"       what pages.yml does
 *   node tools/deployment-env.mjs >> apps/web/.env.local for local development
 *
 * Deploy.s.sol and RegisterSchema.s.sol write contracts/deployments/<chainid>.json and
 * registry-<chainid>.json; the app reads addresses from NEXT_PUBLIC_ variables. This is the one
 * place the two meet, so no address is copied by hand between them. A record that does not exist
 * prints nothing, and the app then says nothing is deployed on that chain. A record that exists but
 * holds something other than an address stops the build instead of wiring it in.
 *
 * Public networks only: the local anvil records are gitignored and change on every run.
 */

import {existsSync, readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const DEPLOYMENTS = join(dirname(fileURLToPath(import.meta.url)), "..", "contracts", "deployments");

/** [record, field in it, variable apps/web reads]. Exactly the variables the app looks for. */
const VARIABLES = [
  ["11155111.json", "safeVaultFactory", "NEXT_PUBLIC_SEPOLIA_VAULT_FACTORY"],
  ["11155111.json", "guardedAccountImplementation", "NEXT_PUBLIC_SEPOLIA_GUARDED_ACCOUNT"],
  ["registry-11155111.json", "poisonRegistry", "NEXT_PUBLIC_SEPOLIA_POISON_REGISTRY"],
  ["registry-1.json", "poisonRegistry", "NEXT_PUBLIC_MAINNET_POISON_REGISTRY"],
];

for (const [record, field, variable] of VARIABLES) {
  const path = join(DEPLOYMENTS, record);
  if (!existsSync(path)) continue;

  const value = JSON.parse(readFileSync(path, "utf8"))[field];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    console.error(`${record} has no address in "${field}" (found ${JSON.stringify(value)}).`);
    process.exit(1);
  }
  console.log(`${variable}=${value}`);
}
