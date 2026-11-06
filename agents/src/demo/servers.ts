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
  /** Stops every child; safe to call more than once. */
  stop(): void;
}

/** Variables the demo needs the servers to run with; they override `.env` (`loadEnv` never overrides what is set). */
export const demoServerEnv = (env: Env): Record<string, string> => ({
  AGENT_KEYS_IN_PROCESS: "true",
  LENDER_KEYS_IN_PROCESS: "true",
  MERCHANT_PORT: merchantPort(env),
});

/** What the runner needs to know about a child process. */
export interface ChildLike {
  pid?: number | undefined;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

/** Everything `startServers` does to the outside world, replaced by fakes in the unit tests. */
export interface ServerDeps {
  launch(spec: ServerSpec, root: string, env: NodeJS.ProcessEnv): ChildLike;
  /** Signals a child's whole process group. */
  kill(pid: number, signal: NodeJS.Signals): void;
  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  exit(code: number): void;
  /** How long the children get to shut down before the runner exits on a signal. */
  settleMs: number;
  fetch: typeof fetch;
  wait: PollOptions;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

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

const realDeps: ServerDeps = {
  launch,
  kill: (pid, signal) => process.kill(-pid, signal),
  onSignal: (signal, handler) => void process.on(signal, handler),
  exit: (code) => process.exit(code),
  settleMs: 1000,
  fetch,
  wait: { attempts: 90, delayMs: 1000 },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: console.log,
};

/** SIGTERMs the process group of every child still running; a second call, or a child already gone, does nothing. */
export function createStopper(children: ChildLike[], kill: ServerDeps["kill"]): () => void {
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const child of children) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      try {
        kill(child.pid, "SIGTERM");
      } catch {
        // the group exited between the check and the signal
      }
    }
  };
}

/**
 * Starts the three servers (the MCP server last: it needs the authorization server) and waits for each `/health`.
 * Ctrl-C or SIGTERM at any point stops the children, gives them a moment, and exits non-zero: they are detached
 * (their own process group), so the terminal's signal does not reach them.
 */
export async function startServers(env: Env, root: string, overrides: Partial<ServerDeps> = {}): Promise<RunningServers> {
  const deps = { ...realDeps, ...overrides };
  const { merchant, auth, mcp } = demoServers(env);
  const childEnv = { ...process.env, ...demoServerEnv(env) };
  const children: ChildLike[] = [];
  const stop = createStopper(children, deps.kill);

  const shutdown = async (code: number) => {
    stop();
    await deps.sleep(deps.settleMs);
    deps.exit(code);
  };
  deps.onSignal("SIGINT", () => void shutdown(130));
  deps.onSignal("SIGTERM", () => void shutdown(143));

  try {
    for (const group of [[merchant, auth], [mcp]]) {
      for (const spec of group) children.push(deps.launch(spec, root, childEnv));
      await Promise.all(group.map((spec) => waitForHealth(spec.healthUrl, deps.wait, deps.fetch)));
      for (const spec of group) deps.log(`${spec.name} is healthy at ${spec.healthUrl}`);
    }
  } catch (error) {
    stop();
    throw error;
  }
  return { stop };
}
