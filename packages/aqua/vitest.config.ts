import { defineConfig } from "vitest/config";

/**
 * `unit`: pure tests, no chain. `anvil`: integration tests against a local anvil node running the real
 * contracts (test/anvil.globalSetup.ts starts anvil and deploys contracts/script/LocalStack.s.sol). The anvil
 * project needs Foundry: set FOUNDRY_BIN to the directory holding `anvil` and `forge` when they are not on PATH.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.anvil.test.ts"],
        },
      },
      {
        test: {
          name: "anvil",
          include: ["src/**/*.anvil.test.ts"],
          globalSetup: ["./test/anvil.globalSetup.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
