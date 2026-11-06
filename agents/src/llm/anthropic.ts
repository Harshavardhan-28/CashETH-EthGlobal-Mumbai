/** Anthropic backend (optional alternative to Ollama): Claude through the official SDK, manual tool-use turns. */
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ChatModel, ChatReply, FinishReason, ToolCall, ToolDef } from "./types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

export interface AnthropicOptions {
  model: string;
  /** Defaults to a client that reads `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` from the environment. */
  client?: Anthropic;
  maxTokens?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The wire form of the conversation: system text apart, and consecutive tool results merged into one user turn. */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: Anthropic.MessageParam[] } {
  const system = messages.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n\n");
  const wire: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      wire.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      // The raw blocks carry Claude's thinking, which must be replayed unchanged between tool turns.
      const content: Anthropic.ContentBlockParam[] = Array.isArray(message.raw)
        ? (message.raw as Anthropic.ContentBlockParam[])
        : [
            ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
            ...message.toolCalls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })),
          ];
      wire.push({ role: "assistant", content });
    } else {
      const result: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      };
      const last = wire.at(-1);
      if (last?.role === "user" && Array.isArray(last.content)) last.content.push(result);
      else wire.push({ role: "user", content: [result] });
    }
  }
  return { system, messages: wire };
}

function finishOf(stopReason: string | null): FinishReason {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return stopReason === "refusal" ? "refusal" : "stop";
}

export function anthropicModel({ model, client = new Anthropic(), maxTokens = 8_000 }: AnthropicOptions): ChatModel {
  return {
    provider: "anthropic",
    model,
    async chat(messages, tools: ToolDef[]): Promise<ChatReply> {
      const wire = toAnthropicMessages(messages);
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: wire.system,
        messages: wire.messages,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: { ...t.inputSchema, type: "object" as const } })),
        output_config: { effort: "medium" },
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolCalls = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b): ToolCall => (isRecord(b.input) ? { id: b.id, name: b.name, input: b.input } : { id: b.id, name: b.name, input: {}, argumentsError: "input is not an object" }));
      return { text, toolCalls, finish: finishOf(response.stop_reason), raw: response.content };
    },
  };
}
