/** Tool definitions the model sees, generated from the MCP server's `tools/list`. */
import type { ToolDef } from "./types.js";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** A tool that runs inside the agent process instead of on the MCP server. Local tools never move money. */
export interface LocalTool {
  def: ToolDef;
  run(input: Record<string, unknown>): Promise<unknown>;
}

/** Tools with no side effect (docs/API.md section 3). Every other tool must be named in `allowTools` to be offered or called. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "get_receivable_status",
  "get_quotes",
  "explain_decision",
  "list_agents",
  "get_agent_stats",
  "get_lender_yield",
]);

/** Arguments the wrapper always owns: the model never writes an idempotency key. */
export const WRAPPER_ARGS = ["idempotencyKey"] as const;

export const propertiesOf = (schema: Record<string, unknown>): Record<string, unknown> =>
  typeof schema.properties === "object" && schema.properties !== null ? (schema.properties as Record<string, unknown>) : {};

/** The tool as the model sees it: same name, description and schema, minus the arguments the wrapper fills in (`hidden`). */
export function toolDefFor(tool: McpToolDefinition, hidden: ReadonlySet<string>): ToolDef {
  const properties = Object.fromEntries(Object.entries(propertiesOf(tool.inputSchema)).filter(([name]) => !hidden.has(name)));
  const { required: allRequired, ...rest } = tool.inputSchema;
  const required = Array.isArray(allRequired) ? (allRequired as string[]).filter((name) => !hidden.has(name)) : [];
  return {
    name: tool.name,
    description: tool.description ?? tool.name,
    inputSchema: { ...rest, type: "object", properties, ...(required.length > 0 ? { required } : {}) },
  };
}
