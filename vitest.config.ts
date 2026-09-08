import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "packages/web/**/*.test.js"],
    environment: "node",
    // Hosted Windows runners can take several seconds for initial filesystem
    // operations while antivirus scans the checkout and fresh temp files.
    testTimeout: process.platform === "win32" ? 20_000 : 5_000,
  },
});
