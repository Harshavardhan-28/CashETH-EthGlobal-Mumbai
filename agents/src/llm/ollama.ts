/** Ollama backend over its OpenAI-compatible endpoint (`/v1/chat/completions`): plain `fetch`, tool calling via `tools` / `tool_calls`. */
import type { ChatMessage, ChatModel, ChatReply, FinishReason, ToolCall, ToolDef } from "./types.js";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";

type FetchLike = typeof fetch;

export interface OllamaOptions {
  model: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

interface WireToolCall {
  id?: string;
  function: { name: string; arguments: unknown };
}

interface WireResponse {
  choices?: { message?: { content?: string | null; tool_calls?: WireToolCall[] }; finish_reason?: string }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Models send arguments as a JSON string (OpenAI shape) or already as an object; anything else is flagged, never guessed. */
function parseCall(call: WireToolCall, index: number): ToolCall {
  const { name, arguments: args } = call.function;
  const base = { id: call.id || `call_${index}`, name };
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = args.trim() === "" ? {} : JSON.parse(args);
    } catch {
      return { ...base, input: {}, argumentsError: "arguments are not valid JSON" };
    }
  }
  return isRecord(parsed) ? { ...base, input: parsed } : { ...base, input: {}, argumentsError: "arguments are not a JSON object" };
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case "assistant":
      return {
        role: "assistant",
        content: message.text,
        ...(message.toolCalls.length > 0
          ? { tool_calls: message.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    default:
      return { role: message.role, content: message.content };
  }
}

function finishOf(reason: string | undefined, toolCalls: ToolCall[]): FinishReason {
  if (toolCalls.length > 0) return "tool_calls";
  return reason === "length" ? "length" : "stop";
}

export function ollamaModel({ model, baseUrl = DEFAULT_OLLAMA_URL, fetch: fetchImpl = fetch }: OllamaOptions): ChatModel {
  return {
    provider: "ollama",
    model,
    async chat(messages, tools: ToolDef[]): Promise<ChatReply> {
      const res = await fetchImpl(new URL("/v1/chat/completions", baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: messages.map(toWireMessage),
          temperature: 0,
          ...(tools.length > 0
            ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })) }
            : {}),
        }),
      });
      if (!res.ok) throw new Error(`ollama chat failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
      const choice = ((await res.json()) as WireResponse).choices?.[0];
      if (!choice?.message) throw new Error("ollama returned no choices");
      const toolCalls = (choice.message.tool_calls ?? []).map(parseCall);
      return { text: choice.message.content ?? "", toolCalls, finish: finishOf(choice.finish_reason, toolCalls) };
    },
  };
}

/** Model names the local Ollama has pulled (`GET /api/tags`), or `undefined` when it is not reachable. */
export async function listOllamaModels(baseUrl = DEFAULT_OLLAMA_URL, fetchImpl: FetchLike = fetch): Promise<string[] | undefined> {
  try {
    const res = await fetchImpl(new URL("/api/tags", baseUrl), { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { models?: { name: string }[] };
    return (body.models ?? []).map((m) => m.name);
  } catch {
    return undefined;
  }
}
