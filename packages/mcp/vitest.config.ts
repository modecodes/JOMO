import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Test against the SDK's source, never a stale build in packages/sdk/dist.
  resolve: { alias: { "@jomo/sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false },
});
