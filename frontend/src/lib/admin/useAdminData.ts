"use client";

import { useEffect, useState } from "react";
import { API_URL, createApiClient, type AgentStats, type ApiClient, type AuditEvent, type Health, type LenderYield } from "./api";
import { SAMPLE_AGENTS, SAMPLE_LENDERS, sampleEvents } from "./sample";

export type ConnStatus = "loading" | "live" | "offline";

export type AdminData = {
  status: ConnStatus;
  /** True only while the MCP server has never answered: the data is the labelled sample story. */
  sample: boolean;
  events: AuditEvent[];
  agents: AgentStats[];
  lenders: LenderYield[];
  /** False until `/agents` and `/lenders` have answered once (they are slower than `/events`). */
  statsReady: boolean;
  health?: Health;
  /** ms epoch of the last successful `/events` poll. */
  updatedAt?: number;
};

/** `/health` + `/events`: in-memory on the server, so polled often. */
export const POLL_INTERVAL_MS = 3000;
/** `/agents` + `/lenders`: chain-derived and cached server-side for about ten seconds. */
export const STATS_POLL_INTERVAL_MS = 10_000;
/** localStorage key of the last live data, shown at once on the next visit while the server is asked again. */
export const CACHE_KEY = "casheth.admin-data.v1";

const INITIAL: AdminData = { status: "loading", sample: false, events: [], agents: [], lenders: [], statsReady: false };

type Cached = Pick<AdminData, "events" | "agents" | "lenders" | "statsReady" | "health" | "updatedAt">;

function readCache(): Cached | undefined {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Cached) : undefined;
    return Array.isArray(parsed?.events) && Array.isArray(parsed?.agents) && Array.isArray(parsed?.lenders) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(d: AdminData): void {
  if (d.sample) return;
  const { events, agents, lenders, statsReady, health, updatedAt } = d;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ events, agents, lenders, statsReady, health, updatedAt } satisfies Cached));
  } catch {
    // Storage full or blocked: the cache is only a head start.
  }
}

/** Runs `poll` now and again `intervalMs` after each run finishes, so a slow endpoint never has two requests open. */
function repeat(poll: () => Promise<void>, intervalMs: number, stopped: () => boolean): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    await poll();
    if (!stopped()) timer = setTimeout(run, intervalMs);
  };
  void run();
  return () => timer && clearTimeout(timer);
}

/**
 * Polls the MCP read API in two independent loops: `/health` + `/events` every `intervalMs` (they decide the
 * connection status) and the slower `/agents` + `/lenders` every `statsIntervalMs`, so the activity shows as soon as
 * the server answers instead of waiting for the chain-derived stats. The last live data is kept in localStorage and
 * shown at once on reload. A failed poll keeps the last good data and marks the connection offline; with no good data
 * yet it shows sample data.
 */
export function useAdminData(opts: { client?: ApiClient; intervalMs?: number; statsIntervalMs?: number } = {}): AdminData {
  const { client, intervalMs = POLL_INTERVAL_MS, statsIntervalMs = STATS_POLL_INTERVAL_MS } = opts;
  const [data, setData] = useState<AdminData>(INITIAL);

  useEffect(() => {
    const api = client ?? createApiClient(API_URL);
    let stopped = false;
    const isStopped = () => stopped;
    const update = (next: (prev: AdminData) => AdminData) =>
      setData((prev) => {
        const d = next(prev);
        writeCache(d);
        return d;
      });

    const cached = readCache();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is client-only, so it is read after hydration
    if (cached) setData({ ...INITIAL, ...cached });

    const pollActivity = async () => {
      try {
        const [health, events] = await Promise.all([api.health(), api.events()]);
        if (stopped) return;
        update((prev) => ({
          ...(prev.sample ? INITIAL : prev),
          status: "live",
          sample: false,
          events,
          health,
          updatedAt: Date.now(),
        }));
      } catch {
        if (stopped) return;
        setData((prev) =>
          prev.updatedAt !== undefined
            ? { ...prev, status: "offline" }
            : { ...INITIAL, status: "offline", sample: true, events: sampleEvents(Date.now()), agents: SAMPLE_AGENTS, lenders: SAMPLE_LENDERS },
        );
      }
    };

    const pollStats = async () => {
      try {
        const [agents, lenders] = await Promise.all([api.agents(), api.lenders()]);
        if (stopped) return;
        update((prev) => (prev.sample ? prev : { ...prev, agents, lenders, statsReady: true }));
      } catch {
        // The activity loop owns the connection status; the last good stats stay on screen.
      }
    };

    const stopActivity = repeat(pollActivity, intervalMs, isStopped);
    const stopStats = repeat(pollStats, statsIntervalMs, isStopped);
    return () => {
      stopped = true;
      stopActivity();
      stopStats();
    };
  }, [client, intervalMs, statsIntervalMs]);

  return data;
}
