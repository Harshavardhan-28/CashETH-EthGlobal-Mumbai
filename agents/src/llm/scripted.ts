/** A fake `ChatModel` that plays back prepared replies: the test suite and `--dry-run` need no model server and no key. */
import type { ChatMessage, ChatModel, ChatReply, ToolCall, ToolDef } from "./types.js";

export type ReplyScript = ChatReply[] | ((messages: ChatMessage[], tools: ToolDef[]) => ChatReply);

export const textReply = (text: string): ChatReply => ({ text, toolCalls: [], finish: "stop" });

export const callReply = (text: string, ...calls: { name: string; input?: Record<string, unknown>; id?: string }[]): ChatReply => ({
  text,
  toolCalls: calls.map((c, i): ToolCall => ({ id: c.id ?? `call_${i}`, name: c.name, input: c.input ?? {} })),
  finish: "tool_calls",
});

export interface ScriptedModel extends ChatModel {
  /** Every request the agent sent, oldest first. */
  readonly requests: { messages: ChatMessage[]; tools: ToolDef[] }[];
}

export function scriptedModel(script: ReplyScript, model = "scripted"): ScriptedModel {
  const requests: ScriptedModel["requests"] = [];
  return {
    provider: "scripted",
    model,
    requests,
    async chat(messages, tools) {
      requests.push({ messages: structuredClone(messages), tools });
      if (typeof script === "function") return script(messages, tools);
      const reply = script[requests.length - 1];
      if (!reply) throw new Error("scripted model has no reply left");
      return reply;
    },
  };
}
