/** Starts the merchant, authorization server and MCP server as child processes and waits until they are healthy. */
import { spawn, type ChildProcess } from "node:child_process";
import type { Env } from "@casheth/shared";
import { poll, type PollOptions } from "./poll.js";

export interface ServerSpec {
  name: string;
  /** Workspace package whose `start` script runs the server. */
  pkg: string;
  healthUrl: string;
}

const setting = (env: Env, key: string, fallback: string): string => {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
};

/** The merchant's port: the one `MERCHANT_ORIGINS` in the MCP server defaults to. */
export const merchantPort = (env: Env): string => setting(env, "MERCHANT_PORT", "3003");

/** The MCP endpoint (`MCP_RESOURCE_URL`), which is also the audience of the agents' tokens. */
export const mcpResourceUrl = (env: Env): string => setting(env, "MCP_RESOURCE_URL", `http://localhost:${setting(env, "MCP_PORT", "4030")}/mcp`);

/** Where each server listens, from the same variables the servers themselves read. */
export function demoServers(env: Env): { merchant: ServerSpec; auth: ServerSpec; mcp: ServerSpec } {
  const authUrl = setting(env, "AUTH_ISSUER", `http://localhost:${setting(env, "AUTH_PORT", "4020")}`);
  return {
    merchant: { name: "merchant", pkg: "@casheth/merchant", healthUrl: `http://localhost:${merchantPort(env)}/health` },
    auth: { name: "auth-server", pkg: "@casheth/auth", healthUrl: new URL("/health", authUrl).href },
    mcp: { name: "mcp-server", pkg: "@casheth/mcp", healthUrl: new URL("/health", mcpResourceUrl(env)).href },
  };
}

/** Polls `url` until it answers 200. */
export async function waitForHealth(url: string, options: PollOptions, fetchImpl: typeof fetch = fetch): Promise<void> {
  await poll(`${url} to answer`, async () => (await fetchImpl(url).then((res) => res.ok, () => false)) || undefined, options);
}

export interface RunningServers {
  stop(): void;
}

/** Variables the demo needs the servers to run with; they override `.env` (`loadEnv` never overrides what is set). */
export const demoServerEnv = (env: Env): Record<string, string> => ({
  AGENT_KEYS_IN_PROCESS: "true",
  LENDER_KEYS_IN_PROCESS: "true",
  MERCHANT_PORT: merchantPort(env),
});

function launch(spec: ServerSpec, root: string, env: NodeJS.ProcessEnv): ChildProcess {
  // Detached, so stopping kills the whole pnpm -> tsx -> node tree through its process group.
  const child = spawn("pnpm", ["-F", spec.pkg, "start"], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const forward = (stream: NodeJS.ReadableStream) =>
    stream.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) console.log(`[${spec.name}] ${line}`);
    });
  forward(child.stdout!);
  forward(child.stderr!);
  child.on("exit", (code) => code && console.error(`[${spec.name}] exited with code ${code}`));
  return child;
}

/** Starts the three servers (the MCP server last: it needs the authorization server) and waits for each `/health`. */
export async function startServers(env: Env, root: string, log: (message: string) => void = console.log): Promise<RunningServers> {
  const { merchant, auth, mcp } = demoServers(env);
  const childEnv = { ...process.env, ...demoServerEnv(env) };
  const children: ChildProcess[] = [];
  const stop = () => {
    for (const child of children) if (child.pid && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
  };
  const wait = { attempts: 90, delayMs: 1000 };
  try {
    for (const group of [[merchant, auth], [mcp]]) {
      for (const spec of group) children.push(launch(spec, root, childEnv));
      await Promise.all(group.map((spec) => waitForHealth(spec.healthUrl, wait)));
      for (const spec of group) log(`${spec.name} is healthy at ${spec.healthUrl}`);
    }
  } catch (error) {
    stop();
    throw error;
  }
  return { stop };
}
