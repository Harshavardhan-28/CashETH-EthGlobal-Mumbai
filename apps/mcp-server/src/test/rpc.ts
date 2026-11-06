/** Test-only JSON-RPC helpers over supertest against the stateless Streamable HTTP endpoint. */
import type { Express } from "express";
import request from "supertest";

let nextId = 1;

export function post(app: Express, body: unknown, token?: string) {
  const req = request(app)
    .post("/mcp")
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json")
    .set("MCP-Protocol-Version", "2025-06-18");
  if (token) req.set("Authorization", `Bearer ${token}`);
  return req.send(body as object);
}

export async function rpc(app: Express, token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await post(app, { jsonrpc: "2.0", id: nextId++, method, params }, token);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${res.text}`);
  return res.body as { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

export type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; _meta?: Record<string, unknown> };

/** Calls a tool and returns the raw result plus its JSON payload. */
export async function callTool(app: Express, token: string, name: string, args: Record<string, unknown>) {
  const body = await rpc(app, token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(`JSON-RPC error ${body.error.code}: ${body.error.message}`);
  const result = body.result as unknown as ToolResult;
  return { result, json: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
}
