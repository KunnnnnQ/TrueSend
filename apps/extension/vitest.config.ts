import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The page module walks and mutates a real DOM; testing it against a fake one is the only way
    // to check the marking without loading an extension into a browser.
    environment: "happy-dom",
  },
});
