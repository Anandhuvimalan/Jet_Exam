import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/**/*.test.ts",
      "tests/**/*.spec.ts"
    ],
    exclude: [
      "node_modules",
      "dist",
      "tools"
    ],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json", "html"],
      reportsDirectory: "tests/coverage",
      include: [
        "src/server/**/*.ts",
        "src/shared/**/*.ts"
      ],
      exclude: [
        "**/*.d.ts",
        "**/*.test.ts",
        "**/*.spec.ts",
        "src/server/scripts/**"
      ]
    },
    mockReset: true,
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 15000,
    hookTimeout: 10000,
    isolate: true,
    globals: true
  },
  resolve: {
    alias: {
      "@server": path.resolve(__dirname, "./src/server"),
      "@shared": path.resolve(__dirname, "./src/shared"),
      "@web": path.resolve(__dirname, "./src/web")
    }
  }
});
