/**
 * `pnpm demo`: runs every step of BUILD.md section 16 on Hedera testnet through the agents, prints a HashScan link
 * per step, appends a "Demo run" section to docs/EVIDENCE.md and exits non-zero when a step failed or lacks a
 * Hedera transaction id. `DEMO_SERVERS=external` uses servers that are already running (with the demo key flags set).
 */
import { fileURLToPath } from "node:url";
import { createNotesTopic, hieroClient } from "@casheth/hedera";
import { loadEnv } from "@casheth/shared";
import { buildContext } from "./demo/context.js";
import { appendEvidence, formatEvidenceSection, formatStepLine } from "./demo/evidence.js";
import { ensureNotesTopic } from "./demo/notesTopic.js";
import { exitCode, failedSteps, runSteps } from "./demo/run.js";
import { startServers, type RunningServers } from "./demo/servers.js";
import { STEPS } from "./demo/steps.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

async function main(): Promise<number> {
  const loaded = loadEnv();
  const servers: RunningServers | undefined = process.env.DEMO_SERVERS === "external" ? undefined : await startServers(loaded, root);
  try {
    const { env, result: setup } = await ensureNotesTopic(loaded, {
      envFile: `${root}.env.accounts`,
      create: () => createNotesTopic(hieroClient(loaded)),
    });
    console.log(formatStepLine(setup));
    const ctx = await buildContext(env, root);
    const results = [setup, ...(await runSteps(STEPS, ctx, (result) => console.log(formatStepLine(result))))];

    const failed = failedSteps(results);
    if (failed.length > 0) {
      console.log(`\nSteps that failed or lack a Hedera transaction id (nothing is written to docs/EVIDENCE.md):\n  ${failed.join("\n  ")}`);
      return exitCode(results);
    }
    appendEvidence(`${root}docs/EVIDENCE.md`, formatEvidenceSection(new Date(), results));
    console.log("\nEvery step has a Hedera transaction. Evidence appended to docs/EVIDENCE.md.");
    return 0;
  } finally {
    servers?.stop();
  }
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(error);
  return 1;
});
process.exit();
