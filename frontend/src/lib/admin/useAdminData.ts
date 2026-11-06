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
  health?: Health;
  /** ms epoch of the last successful poll. */
  updatedAt?: number;
};

export const POLL_INTERVAL_MS = 3000;

const INITIAL: AdminData = { status: "loading", sample: false, events: [], agents: [], lenders: [] };

/**
 * Polls the MCP read API (`/health`, `/events`, `/agents`, `/lenders`) now and every `intervalMs`, one poll at a time.
 * A failed poll keeps the last good data and marks the connection offline; with no good data yet it shows sample data.
 */
export function useAdminData(opts: { client?: ApiClient; intervalMs?: number } = {}): AdminData {
  const { client, intervalMs = POLL_INTERVAL_MS } = opts;
  const [data, setData] = useState<AdminData>(INITIAL);

  useEffect(() => {
    const api = client ?? createApiClient(API_URL);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const [health, events, agents, lenders] = await Promise.all([api.health(), api.events(), api.agents(), api.lenders()]);
        if (stopped) return;
        setData({ status: "live", sample: false, events, agents, lenders, health, updatedAt: Date.now() });
      } catch {
        if (stopped) return;
        setData((prev) =>
          prev.updatedAt !== undefined
            ? { ...prev, status: "offline" }
            : { status: "offline", sample: true, events: sampleEvents(Date.now()), agents: SAMPLE_AGENTS, lenders: SAMPLE_LENDERS },
        );
      }
      if (!stopped) timer = setTimeout(poll, intervalMs);
    };

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, intervalMs]);

  return data;
}
