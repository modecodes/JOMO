import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    server: {
      deps: {
        // The ScopeLift SDK (used only as a test oracle) ships directory imports that Node ESM rejects.
        inline: ["@scopelift/stealth-address-sdk"],
      },
    },
  },
});
