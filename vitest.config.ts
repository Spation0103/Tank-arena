import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "client",
          include: ["client/tests/**/*.vitest.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "server",
          include: ["server/tests/**/*.vitest.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "shared",
          include: ["shared/tests/**/*.vitest.ts"],
          environment: "node",
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["shared/**/*.ts"],
      exclude: ["shared/tests/**"],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
  },
});
