/**
 * Build the two workspace libraries every other package imports.
 *
 *   node tools/build-libs.mjs      (also runs on its own, as the root `prepare` script)
 *
 * `@truesend/engine` and `@truesend/chain` resolve through `dist/`, which is build output and not
 * committed. Without this step a fresh clone installs cleanly and then fails to find them: measured
 * on one, the typechecks of chain, web, the extension and the indexer fail, and so do the extension's
 * and the indexer's test suites and the mainnet replay. (Engine's and chain's own tests pass; they
 * never import a built copy.) That was found the first time the repository was cloned rather than
 * worked on in place — the working copy it was written in had a `dist/` left over from earlier
 * builds the whole time, so those checks had only ever passed on the one machine that had one. CI
 * would have failed the same way on its first run; it had never had one.
 *
 * A node script rather than `pnpm -r --filter "./packages/**" build`: a nested `pnpm` is not on
 * PATH when pnpm itself was started through corepack without `corepack enable`, which is exactly
 * how the README starts it. The order is explicit because chain imports engine's types, so engine
 * has to exist first.
 */

import {execFileSync} from "node:child_process";
import {createRequire} from "node:module";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const pkg of ["packages/engine", "packages/chain"]) {
  const dir = join(root, pkg);
  // Each package's own TypeScript, so a library is built with the compiler it declares.
  const tsc = createRequire(join(dir, "package.json")).resolve("typescript/bin/tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {cwd: dir, stdio: "inherit"});
}
