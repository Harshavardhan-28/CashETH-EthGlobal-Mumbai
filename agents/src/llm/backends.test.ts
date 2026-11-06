import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { fakeHttpServer, type FakeHttpServer } from "../test/httpServer.js";
import { anthropicModel, toAnthropicMessages } from "./anthropic.js";
import { listOllamaModels, ollamaModel } from "./ollama.js";
import type { ChatMessage, ToolDef } from "./types.js";

const lookup: ToolDef = {
  name: "get_agent_stats",
  description: "stats of an agent",
  inputSchema: { type: "object", properties: { address: { type: "string" } } },
};

let server: FakeHttpServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const conversation = (): ChatMessage[] => [
  { role: "system", content: "be brief" },
  { role: "user", content: "stats for 0xabc" },
];

describe("ollama backend (OpenAI-compatible endpoint)", () => {
  it("round-trips a tool call: tools out as functions, tool_calls in, tool result back", async () => {
    server = await fakeHttpServer(({ body }) => {
      const sawToolResult = (body as { messages: { role: string }[] }).messages.some((m) => m.role === "tool");
      return {
        body: {
          choices: [
            sawToolResult
              ? { finish_reason: "stop", message: { content: "on-time 100%" } }
              : {
                  finish_reason: "tool_calls",
                  message: { content: "", tool_calls: [{ id: "call_7", type: "function", function: { name: "get_agent_stats", arguments: '{"address":"0xabc"}' } }] },
                },
          ],
        },
      };
    });
    const model = ollamaModel({ model: "qwen2.5:7b", baseUrl: server.url });
    const messages = conversation();

    const first = await model.chat(messages, [lookup]);
    expect(first).toMatchObject({ finish: "tool_calls", toolCalls: [{ id: "call_7", name: "get_agent_stats", input: { address: "0xabc" } }] });
    expect(server.requests[0]).toMatchObject({ method: "POST", path: "/v1/chat/completions" });
    expect(server.requests[0]!.body).toMatchObject({
      model: "qwen2.5:7b",
      tools: [{ type: "function", function: { name: "get_agent_stats", description: "stats of an agent", parameters: lookup.inputSchema } }],
    });

    messages.push({ role: "assistant", text: first.text, toolCalls: first.toolCalls });
    messages.push({ role: "tool", toolCallId: "call_7", name: "get_agent_stats", content: '{"onTimePct":100}', isError: false });
    const second = await model.chat(messages, [lookup]);
    expect(second).toMatchObject({ finish: "stop", text: "on-time 100%", toolCalls: [] });

    const sent = (server.requests[1]!.body as { messages: Record<string, unknown>[] }).messages;
    expect(sent[2]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_7", type: "function", function: { name: "get_agent_stats", arguments: '{"address":"0xabc"}' } }] });
    expect(sent[3]).toEqual({ role: "tool", tool_call_id: "call_7", content: '{"onTimePct":100}' });
  });

  it("accepts object arguments, invents missing ids, and flags arguments that are not a JSON object", async () => {
    server = await fakeHttpServer(() => ({
      body: {
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: null,
              tool_calls: [
                { function: { name: "a", arguments: { x: 1 } } },
                { id: "b1", function: { name: "b", arguments: "{not json" } },
                { id: "c1", function: { name: "c", arguments: "[1]" } },
              ],
            },
          },
        ],
      },
    }));
    const reply = await ollamaModel({ model: "m", baseUrl: server.url }).chat(conversation(), []);
    expect(reply.toolCalls).toEqual([
      { id: "call_0", name: "a", input: { x: 1 } },
      { id: "b1", name: "b", input: {}, argumentsError: "arguments are not valid JSON" },
      { id: "c1", name: "c", input: {}, argumentsError: "arguments are not a JSON object" },
    ]);
    expect(reply.finish).toBe("tool_calls");
  });

  it("reports an HTTP failure with the server's message", async () => {
    server = await fakeHttpServer(() => ({ status: 404, body: { error: "model 'nope' not found" } }));
    await expect(ollamaModel({ model: "nope", baseUrl: server.url }).chat(conversation(), [])).rejects.toThrow(/HTTP 404.*not found/);
  });

  it("lists pulled models from /api/tags, and answers undefined when unreachable", async () => {
    server = await fakeHttpServer(() => ({ body: { models: [{ name: "qwen2.5:7b" }, { name: "llama3.1:8b" }] } }));
    expect(await listOllamaModels(server.url)).toEqual(["qwen2.5:7b", "llama3.1:8b"]);
    expect(server.requests[0]!.path).toBe("/api/tags");
    await server.close();
    expect(await listOllamaModels(server.url)).toBeUndefined();
    server = undefined;
  });
});

describe("anthropic backend", () => {
  it("round-trips a tool call through the Messages API shape and replays the raw assistant blocks", async () => {
    server = await fakeHttpServer(({ body }) => {
      const messages = (body as { messages: { role: string }[] }).messages;
      const content =
        messages.length > 1
          ? [{ type: "text", text: "on-time 100%" }]
          : [
              { type: "thinking", thinking: "", signature: "sig" },
              { type: "tool_use", id: "toolu_1", name: "get_agent_stats", input: { address: "0xabc" } },
            ];
      return {
        body: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content,
          stop_reason: messages.length > 1 ? "end_turn" : "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      };
    });
    const model = anthropicModel({ model: "claude-sonnet-5-5", client: new Anthropic({ apiKey: "test", baseURL: server.url, maxRetries: 0 }) });
    const messages = conversation();

    const first = await model.chat(messages, [lookup]);
    expect(first).toMatchObject({ finish: "tool_calls", toolCalls: [{ id: "toolu_1", name: "get_agent_stats", input: { address: "0xabc" } }] });
    expect(server.requests[0]).toMatchObject({ method: "POST", path: "/v1/messages" });
    expect(server.requests[0]!.body).toMatchObject({
      model: "claude-sonnet-5-5",
      system: "be brief",
      tools: [{ name: "get_agent_stats", input_schema: { type: "object" } }],
    });

    messages.push({ role: "assistant", text: first.text, toolCalls: first.toolCalls, raw: first.raw });
    messages.push({ role: "tool", toolCallId: "toolu_1", name: "get_agent_stats", content: "{}", isError: true });
    const second = await model.chat(messages, [lookup]);
    expect(second).toMatchObject({ finish: "stop", text: "on-time 100%" });

    const sent = (server.requests[1]!.body as { messages: { role: string; content: { type: string }[] }[] }).messages;
    expect(sent[1]!.content.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(sent[2]).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true }] });
  });

  it("merges the results of parallel tool calls into one user turn", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", text: "", toolCalls: [{ id: "a", name: "x", input: {} }, { id: "b", name: "y", input: {} }] },
      { role: "tool", toolCallId: "a", name: "x", content: "1", isError: false },
      { role: "tool", toolCallId: "b", name: "y", content: "2", isError: false },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({ role: "user", content: [{ tool_use_id: "a" }, { tool_use_id: "b" }] });
  });

  it("maps refusal and max_tokens stop reasons", async () => {
    server = await fakeHttpServer(() => ({
      body: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: "refusal", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
    }));
    const model = anthropicModel({ model: "x", client: new Anthropic({ apiKey: "test", baseURL: server.url, maxRetries: 0 }) });
    expect((await model.chat(conversation(), [])).finish).toBe("refusal");
  });
});
