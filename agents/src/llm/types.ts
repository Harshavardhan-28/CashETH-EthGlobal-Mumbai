/** Provider-neutral chat types: the agent loop speaks these, each backend (Ollama, Anthropic) translates them. */

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** The model's arguments were not a JSON object; the call is answered with an error instead of being executed. */
  argumentsError?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema of the tool input (`type: "object"`). */
  inputSchema: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  /** `raw` is the provider's own content, replayed verbatim on the next request (Claude's thinking blocks). */
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError: boolean };

export type FinishReason = "stop" | "tool_calls" | "length" | "refusal";

export interface ChatReply {
  text: string;
  toolCalls: ToolCall[];
  finish: FinishReason;
  raw?: unknown;
}

/** The whole provider contract: one request/response round. */
export interface ChatModel {
  readonly provider: string;
  readonly model: string;
  chat(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatReply>;
}
