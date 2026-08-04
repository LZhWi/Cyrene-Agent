import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/main/**/*.test.ts",
      "src/renderer/**/*.test.ts",
      "src/shared/**/*.test.ts",
      "src/cli/**/*.test.ts",
      "skills/**/tests/**/*.test.ts",
      "scripts/cline-poc/**/*.test.ts",
    ],
  },
});
