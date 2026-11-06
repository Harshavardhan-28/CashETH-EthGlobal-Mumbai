"use client";

import { useEffect, useState } from "react";
import { api, type ApiClient, type AuditEvent, type ReceivableDetails } from "./api";
import { latestReceivableId } from "./liveConsole";

export type LiveAudit = { events: AuditEvent[]; receivable?: ReceivableDetails };

const POLL_MS = 5000;

/**
 * Polls the read API for the audit log and the receivable it last mentions.
 * Returns null until the API has answered with at least one event, so callers can fall back to
 * static content. A later failed poll keeps the last good data.
 */
export function useLiveAudit(client: ApiClient = api, intervalMs: number = POLL_MS): LiveAudit | null {
  const [live, setLive] = useState<LiveAudit | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const events = await client.events();
        const id = latestReceivableId(events);
        const receivable = id ? await client.receivable(id).catch(() => undefined) : undefined;
        if (!cancelled && events.length > 0) setLive({ events, receivable });
      } catch {
        // API unreachable: keep whatever we have (static content on first load).
      }
    }

    void poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, intervalMs]);

  return live;
}
