import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "@casheth/engine";
import type { LlmToolClient } from "./agent.js";
import { eventStoreSink } from "./audit.js";
import { main, type CliIo } from "./cli.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempAudit = () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-cli-"));
  dirs.push(dir);
  return join(dir, "audit.jsonl");
};

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  const handle: CliIo = { out: (line) => void out.push(line), err: (line) => void err.push(line) };
  return { handle, out, err };
};

const ENV = { SELLER_KEY: `0x${"ab".repeat(32)}`, SELLER_UAID: "uaid:aid:seller", SELLER_EVM: "0x00000000000000000000000000000000000000c1" };
const unreachable: typeof fetch = async () => {
  throw new Error("ECONNREFUSED");
};

describe("llm cli", () => {
  it("refuses clearly when Ollama is unreachable and no key is set, before touching the MCP server", async () => {
    const { handle, err } = io();
    let connected = false;
    const code = await main(["--role", "seller", "--goal", "x"], ENV, handle, {
      fetch: unreachable,
      connect: () => ((connected = true), {} as LlmToolClient),
    });
    expect(code).toBe(1);
    expect(connected).toBe(false);
    expect(err.join("\n")).toMatch(/Ollama is not reachable.*ANTHROPIC_API_KEY is not set/);
  });

  it("prints usage on missing arguments", async () => {
    const { handle, err } = io();
    expect(await main(["--role", "seller"], ENV, handle)).toBe(1);
    expect(err.join("\n")).toMatch(/usage:/);
  });

  it("--dry-run drives the loop with the fake model, prints provider and model, and writes the audit trail", async () => {
    const { handle, out } = io();
    const auditFile = tempAudit();
    const calls: string[] = [];
    const client: LlmToolClient = {
      listToolDefinitions: async () => [{ name: "list_agents", description: "agents", inputSchema: { type: "object", properties: {} } }],
      call: async (tool) => (calls.push(tool), [] as never),
    };
    // `pnpm run llm -- --flag` forwards a leading "--"; the CLI tolerates it.
    const code = await main(["--", "--role", "seller", "--goal", "x", "--dry-run"], ENV, handle, { connect: () => client, auditFile });
    expect(code).toBe(0);
    expect(out[0]).toBe("LLM provider: scripted, model: dry-run");
    expect(calls).toEqual(["list_agents"]);
    const events = readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events).toMatchObject([
      { type: "LlmToolCall", tool: "list_agents", outcome: "ok", role: "seller", model: "scripted:dry-run", agentUaid: "uaid:aid:seller" },
      { type: "LlmRunFinished", status: "completed", steps: 2 },
    ]);
  });

  it("asks for the account variables it needs", async () => {
    const { handle, err } = io();
    expect(await main(["--role", "lender", "--goal", "x", "--dry-run"], {}, handle)).toBe(1);
    expect(err.join("\n")).toMatch(/LENDER_A_KEY, LENDER_A_UAID and LENDER_A_EVM/);
  });
});

describe("eventStoreSink", () => {
  it("maps entries to engine audit events with the error code lifted out", () => {
    const store = new EventStore(tempAudit());
    const sink = eventStoreSink(store, { role: "worker", model: "ollama:qwen2.5:7b", id: "0x01" });
    sink.record({ kind: "tool_call", runId: "r", step: 1, tool: "reserve_spend", input: { amount: "1" }, outcome: "refused", result: { code: "SPEND_CAP_EXCEEDED" } });
    expect(store.list()[0]).toMatchObject({ type: "LlmToolCall", id: "0x01", code: "SPEND_CAP_EXCEEDED", tool: "reserve_spend", seq: 1 });
  });
});
