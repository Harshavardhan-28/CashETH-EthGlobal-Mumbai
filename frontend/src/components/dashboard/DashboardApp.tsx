"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import a from "@/components/admin/Admin.module.css";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { API_URL, HCS_TOPIC_ID, type AgentStats } from "@/lib/admin/api";
import { relativeTime } from "@/lib/admin/format";
import { narrateAll } from "@/lib/admin/narrate";
import { useAdminData, type AdminData, type ConnStatus } from "@/lib/admin/useAdminData";
import { buildInvoices, eventsFor, type Invoice } from "@/lib/dashboard/derive";
import { fetchReceivable, fetchWallet, useReceivables, useWallet, type ReceivableLoader } from "@/lib/dashboard/live";
import { AgentPicker, findAgent } from "./AgentPicker";
import { BuyerView } from "./BuyerView";
import d from "./Dashboard.module.css";
import { Identity } from "./Identity";
import { LenderView } from "./LenderView";
import { McpLog } from "./McpLog";
import { SellerView } from "./SellerView";
import type { RoleViewProps } from "./types";
import { WorkerView } from "./WorkerView";

export const SAVED_AGENT_KEY = "casheth-dashboard-agent";

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const readHash = () => window.location.hash;
const serverHash = () => "";

/** `#agent=<0x address or uaid>` → the id, else undefined. */
export function agentFromHash(hash: string): string | undefined {
  const m = /^#?agent=(.+)$/.exec(hash);
  return m ? decodeURIComponent(m[1]) : undefined;
}

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const CONN: Record<ConnStatus, { label: string; cls: string }> = {
  live: { label: "Live · MCP connected", cls: a.connLive },
  offline: { label: "MCP offline", cls: a.connOffline },
  loading: { label: "Connecting…", cls: a.connLoading },
};

const ROLE_ORDER: AgentStats["role"][] = ["seller", "buyer", "lender", "worker"];

function TopBar({ status, agents, current, onPick }: { status: ConnStatus; agents: AgentStats[]; current?: AgentStats; onPick(id?: string): void }) {
  const conn = CONN[status];
  const sorted = [...agents].sort((x, y) => ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role) || x.label.localeCompare(y.label));
  return (
    <header className={a.bar}>
      <div className={a.brand}>
        <Logo size={20} />
        <span className={a.brandTag}>Dashboard</span>
      </div>
      <span className={a.netPill}>
        Network <b>Hedera testnet</b>
      </span>
      {agents.length > 0 && (
        <label className={d.switcher}>
          <span className={d.hideSm}>Agent</span>
          <select aria-label="Agent" value={current?.address.toLowerCase() ?? ""} onChange={(e) => onPick(e.target.value || undefined)}>
            <option value="">Choose an agent…</option>
            {sorted.map((x) => (
              <option key={x.address} value={x.address.toLowerCase()}>
                {x.label || x.address} · {x.role}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className={a.barRight}>
        <a className={`${d.barLink} ${d.hideSm}`} href="/docs">
          Docs
        </a>
        <span className={`${a.conn} ${conn.cls}`} role="status" aria-label={conn.label}>
          <i />
          <span>{conn.label}</span>
        </span>
        <ThemeToggle variant="icon" />
      </div>
    </header>
  );
}

type Deps = { useData?: () => AdminData; loadWallet?: typeof fetchWallet; loadReceivable?: ReceivableLoader };

/**
 * Public agent dashboard: pick a seller, buyer or lender agent registered with the CashETH MCP server and follow
 * everything it does through the MCP, its wallet, credit and invoices. No sign-in: it reads the public read API
 * and the Hedera mirror node only. Dependencies are injectable for tests.
 */
export function DashboardApp({ useData = useAdminData, loadWallet = fetchWallet, loadReceivable = fetchReceivable }: Deps) {
  const data = useData();
  const nowMs = useNow();
  const hash = useSyncExternalStore(subscribeHash, readHash, serverHash);
  const wanted = agentFromHash(hash);
  const me = wanted ? findAgent(data.agents, wanted) : undefined;

  const pick = useCallback((id?: string) => {
    window.location.hash = id ? `agent=${encodeURIComponent(id)}` : "";
    try {
      if (id) localStorage.setItem(SAVED_AGENT_KEY, id);
      else localStorage.removeItem(SAVED_AGENT_KEY);
    } catch {}
    window.scrollTo?.({ top: 0 });
  }, []);

  // Reopen the last agent this browser followed.
  useEffect(() => {
    if (window.location.hash) return;
    try {
      const saved = localStorage.getItem(SAVED_AGENT_KEY);
      if (saved) window.location.replace(`#agent=${encodeURIComponent(saved)}`);
    } catch {}
  }, []);

  const narrated = useMemo(() => narrateAll(data.events, data.agents, HCS_TOPIC_ID), [data.events, data.agents]);
  const refs = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of narrated) if (n.id && n.ref && !m.has(n.id.toLowerCase())) m.set(n.id.toLowerCase(), n.ref);
    return m;
  }, [narrated]);
  const baseInvoices = useMemo(() => buildInvoices(data.events, refs), [data.events, refs]);

  const myAddr = me?.address.toLowerCase();
  const isMine = useCallback(
    (i: Invoice) =>
      !!me &&
      (me.role === "seller" ? i.seller === myAddr : me.role === "buyer" ? i.buyer === myAddr : me.role === "lender" ? i.lenders.some((l) => l.maker === myAddr) : i.workers.includes(myAddr!)),
    [me, myAddr],
  );
  const myIds = useMemo(() => baseInvoices.filter(isMine).map((i) => i.id), [baseInvoices, isMine]);
  const details = useReceivables(myIds, !data.sample && !!me, loadReceivable);
  const invoices = useMemo(() => (details.size ? buildInvoices(data.events, refs, details) : baseInvoices), [details, data.events, refs, baseInvoices]);
  const mine = useMemo(() => invoices.filter(isMine), [invoices, isMine]);

  const wallet = useWallet(me?.address, !data.sample, loadWallet);

  const raw = useMemo(() => new Map(data.events.map((e) => [e.seq, e])), [data.events]);
  const log = useMemo(() => {
    if (!me) return [];
    const seqs = new Set(eventsFor(data.events, invoices, me.address, me.role).map((e) => e.seq));
    return narrated.filter((n) => seqs.has(n.seq));
  }, [me, data.events, invoices, narrated]);

  const props: RoleViewProps | undefined = me ? { me, agents: data.agents, lenders: data.lenders, events: data.events, mine, wallet, nowMs } : undefined;
  const lastAction = log[0];
  // The agent list arrives with the slower stats poll, after the activity; until then the picker is still loading.
  const agentsKnown = data.statsReady || data.sample;

  return (
    <div className={a.app}>
      <TopBar status={data.status} agents={data.agents} current={me} onPick={pick} />
      {data.sample && (
        <div className={a.banner} role="note">
          <b>Sample data · MCP server offline</b>
          <span>
            — start the MCP server on <code>{API_URL}</code> to follow your live agents
          </span>
        </div>
      )}
      <main className={d.main}>
        {!props ? (
          <AgentPicker agents={data.agents} status={agentsKnown ? data.status : "loading"} unknown={wanted && agentsKnown && data.status !== "loading" ? wanted : undefined} onPick={pick} />
        ) : (
          <>
            <Identity me={props.me} lenders={data.lenders} wallet={wallet} sample={data.sample} lastAction={lastAction ? relativeTime(lastAction.ts, nowMs) : undefined} onSwitch={() => pick(undefined)} />
            {props.me.role === "seller" && <SellerView {...props} />}
            {props.me.role === "buyer" && <BuyerView {...props} />}
            {props.me.role === "lender" && <LenderView {...props} />}
            {props.me.role === "worker" && <WorkerView {...props} />}
            <McpLog items={log} raw={raw} nowMs={nowMs} agentName={props.me.label || props.me.address} />
          </>
        )}
      </main>
    </div>
  );
}
