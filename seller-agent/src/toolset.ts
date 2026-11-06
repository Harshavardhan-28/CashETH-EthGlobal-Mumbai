/**
 * The tool set the model sees: the seller's and the research worker's CashETH tools, generated from each session's
 * `tools/list`, plus three local tools (the free `http_get` and the two requests to the buyer). The model-facing
 * schemas leave out every argument the wrapper owns; the executors forward whatever the guard node approved.
 */
import { toolDefFor, ToolCallError, type LlmToolClient, type McpToolDefinition } from "@casheth/agents";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";

type Args = Record<string, unknown>;

/** Which session runs each CashETH tool the model may use. Everything else on the server is not offered. */
export const MCP_TOOL_SESSIONS = {
  upload_invoice_document: "seller",
  upload_receivable: "seller",
  get_receivable_status: "seller",
  get_quotes: "seller",
  open_facility: "seller",
  set_budgets: "seller",
  reserve_spend: "worker",
  pay_x402: "worker",
  commit_spend: "worker",
} as const satisfies Record<string, "seller" | "worker">;

/** Arguments the wrapper fills in: hidden from the model, which could only get them wrong. */
export const WRAPPER_ARGS: Record<string, string[]> = {
  upload_invoice_document: ["content", "filename", "mime", "expected"],
  upload_receivable: ["seller", "detailsCommitment"],
  reserve_spend: ["worker", "spendWallet"],
};

export interface LocalHandlers {
  httpGet(args: Args): Promise<unknown>;
  /** The guard node adds the stored upload (`upload`) to the model's `pendingId`. */
  confirm(args: Args): Promise<unknown>;
  /** The guard node adds the receivable's face amount (`amount`) to the model's `id`. */
  repay(args: Args): Promise<unknown>;
}

/** OpenAI-style function definition: what `bindTools` sends to the model. */
export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Toolset {
  specs: ToolSpec[];
  tools: StructuredToolInterface[];
}

const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties) });

const LOCAL_SPECS: Record<"http_get" | "request_buyer_confirmation" | "request_buyer_repayment", { description: string; parameters: Record<string, unknown> }> = {
  http_get: {
    description:
      "Free HTTP GET on the paid API. Returns status, headers and body; on 402 Payment Required, paymentRequired holds the decoded x402 requirements (accepts[0].amount in USDC base units and accepts[0].payTo, the payee account). Never pays.",
    parameters: object({ url: { type: "string", description: "full URL on the paid API origin" } }),
  },
  request_buyer_confirmation: {
    description:
      "Ask the buyer (a separate agent with its own key) to sign and confirm the receivable you uploaded. Returns the on-chain registration and the credit decision.",
    parameters: object({ pendingId: { type: "string", description: "pendingId from upload_receivable" } }),
  },
  request_buyer_repayment: {
    description: "Ask the buyer to repay the financed receivable in full; lenders are paid first, you get the rest.",
    parameters: object({ id: { type: "string", description: "receivable id" } }),
  },
};

const errorJson = (error: unknown): string => {
  if (error instanceof ToolCallError) return JSON.stringify({ error: error.details });
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "CLIENT_ERROR";
  return JSON.stringify({ error: { code, message: error instanceof Error ? error.message : String(error) } });
};

/** Every executor answers JSON text; a failure is `{ error: { code, ... } }` so the model sees the code. */
function executor(name: string, description: string, run: (args: Args) => Promise<unknown>): StructuredToolInterface {
  return tool(
    async (args: Args) => {
      try {
        return JSON.stringify(await run(args));
      } catch (error) {
        return errorJson(error);
      }
    },
    { name, description, schema: { type: "object", properties: {}, additionalProperties: true } },
  );
}

const spec = (name: string, description: string, parameters: Record<string, unknown>): ToolSpec => ({ type: "function", function: { name, description, parameters } });

export async function buildToolset({ seller, worker, local }: { seller: LlmToolClient; worker: LlmToolClient; local: LocalHandlers }): Promise<Toolset> {
  const sessions = { seller, worker };
  const listed = { seller: await seller.listToolDefinitions(), worker: await worker.listToolDefinitions() };
  const specs: ToolSpec[] = [];
  const tools: StructuredToolInterface[] = [];

  for (const [name, session] of Object.entries(MCP_TOOL_SESSIONS)) {
    const definition: McpToolDefinition | undefined = listed[session].find((t) => t.name === name);
    if (!definition) throw new Error(`the ${session} session's tools/list lacks ${name}: is the MCP server up to date?`);
    const model = toolDefFor(definition, new Set(["idempotencyKey", ...(WRAPPER_ARGS[name] ?? [])]));
    specs.push(spec(name, model.description, model.inputSchema));
    tools.push(executor(name, model.description, (args) => sessions[session].call(name, args)));
  }

  const handlers = { http_get: local.httpGet, request_buyer_confirmation: local.confirm, request_buyer_repayment: local.repay };
  for (const [name, { description, parameters }] of Object.entries(LOCAL_SPECS)) {
    specs.push(spec(name, description, parameters));
    tools.push(executor(name, description, handlers[name as keyof typeof handlers]));
  }
  return { specs, tools };
}
