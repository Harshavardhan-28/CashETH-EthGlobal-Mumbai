import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { runSellerAgent } from "./run.js";
import { callTool, ScriptedChatModel, SELLER, WORKER } from "./test/fakes.js";
import { setupRun } from "./test/setup.js";

const ID = "0x" + "1".repeat(64);
const strip = (key: string) => key.replace(/^0x/, "");

describe("secrets", () => {
  it("never reach the model, its tool definitions or the transcript, though the accounts carry their keys", async () => {
    const model = new ScriptedChatModel([callTool("get_receivable_status", { id: ID }), callTool("http_get", { url: "https://paid.example/" }), new AIMessage("done")]);
    const fetch = (async () => new Response("{}", { status: 402 })) as unknown as typeof globalThis.fetch;
    const { transcript, options } = setupRun(model, { fetch });

    const result = await runSellerAgent(options);

    const exposed = JSON.stringify([model.seen, model.boundTools, transcript.entries, result]);
    for (const key of [SELLER.key, WORKER.key]) expect(exposed).not.toContain(strip(key));
  });
});
