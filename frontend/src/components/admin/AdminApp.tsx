"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { API_URL, HCS_TOPIC_ID } from "@/lib/admin/api";
import { groupRuns, inRange, type Range } from "@/lib/admin/derive";
import { narrateAll } from "@/lib/admin/narrate";
import { useAdminData, type AdminData } from "@/lib/admin/useAdminData";
import styles from "./Admin.module.css";
import { ActivityView } from "./ActivityView";
import { AgentsView } from "./AgentsView";
import { SideNav, TopBar } from "./Chrome";
import { Overview, type ViewProps } from "./Overview";
import { matchesQuery, parseHash, toHash, type Route } from "./route";
import { RunsView } from "./RunsView";

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const readHash = () => window.location.hash;
const serverHash = () => "";

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** The admin console. `useData` is injectable for tests; production polls the MCP read API. */
export function AdminApp({ useData = useAdminData }: { useData?: () => AdminData }) {
  const data = useData();
  const nowMs = useNow();
  const hash = useSyncExternalStore(subscribeHash, readHash, serverHash);
  const route = useMemo(() => parseHash(hash), [hash]);
  const [range, setRange] = useState<Range>("all");
  const [query, setQuery] = useState("");

  const go = useCallback((next: Route) => {
    window.location.hash = toHash(next);
    window.scrollTo?.({ top: 0 });
  }, []);

  const all = useMemo(() => narrateAll(data.events, data.agents, HCS_TOPIC_ID), [data.events, data.agents]);
  const items = useMemo(() => inRange(all, range, nowMs).filter((i) => matchesQuery(i, query)), [all, range, nowMs, query]);
  const runCount = useMemo(() => groupRuns(all).filter((r) => r.id !== "setup").length, [all]);

  const props: ViewProps = { all, items, agents: data.agents, lenders: data.lenders, range, onRange: setRange, query, nowMs, go };

  return (
    <div className={styles.app}>
      <TopBar status={data.status} query={query} onQuery={setQuery} />
      {data.sample && (
        <div className={styles.banner} role="note">
          <b>Sample data · MCP server offline</b>
          <span>
            — start the MCP server on <code>{API_URL}</code> to see live agents
          </span>
        </div>
      )}
      <div className={styles.body}>
        <SideNav view={route.view} onView={(view) => go({ view })} counts={{ agents: data.agents.length, runs: runCount }} />
        <main className={styles.main}>
          {route.view === "overview" && <Overview {...props} />}
          {route.view === "agents" && <AgentsView {...props} agentKey={route.agent} />}
          {route.view === "activity" && <ActivityView {...props} />}
          {route.view === "runs" && <RunsView {...props} runId={route.run} />}
        </main>
      </div>
    </div>
  );
}
