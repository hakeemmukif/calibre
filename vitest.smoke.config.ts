import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  test: { environment: "node", include: ["src/**/*.smoke.test.ts"], setupFiles: ["src/smoke/setup.ts"], testTimeout: 120000 },
});
