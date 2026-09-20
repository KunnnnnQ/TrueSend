import type {NextConfig} from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The engine ships as TypeScript-built ESM inside the workspace; Next has to compile it rather
  // than treat it as a prebuilt external, or the import resolves to nothing at build time.
  transpilePackages: ["@truesend/engine", "@truesend/chain"],
};

export default config;
