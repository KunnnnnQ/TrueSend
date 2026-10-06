import type {NextConfig} from "next";

/**
 * Set only by .github/workflows/pages.yml, which publishes the app as a static site on GitHub Pages
 * under `/<repository>`. Unset everywhere else, so `dev`, `build` and `start` behave as before.
 *
 * A static export works because nothing here needs a server: every page is a client component,
 * history and token names are read from public RPC endpoints in the visitor's own browser, and there
 * are no route handlers, middleware or server actions. `trailingSlash` makes each page a directory
 * with an `index.html`, the shape a static host serves without rewrites.
 */
const pagesBasePath = process.env.PAGES_BASE_PATH;

const config: NextConfig = {
  reactStrictMode: true,
  // The engine ships as TypeScript-built ESM inside the workspace; Next has to compile it rather
  // than treat it as a prebuilt external, or the import resolves to nothing at build time.
  transpilePackages: ["@truesend/engine", "@truesend/chain"],
  ...(pagesBasePath === undefined
    ? {}
    : {output: "export" as const, basePath: pagesBasePath, trailingSlash: true}),
};

export default config;
