"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import a from "@/components/admin/Admin.module.css";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { API_URL, HCS_TOPIC_ID, type AgentStats } from "@/lib/admin/api";
import { relativeTime, shortAddress } from "@/lib/admin/format";
import { narrateAll } from "@/lib/admin/narrate";
import { useAdminData, type AdminData, type ConnStatus } from "@/lib/admin/useAdminData";
import { buildInvoices, eventsFor, type Invoice } from "@/lib/dashboard/derive";
import { fetchReceivable, fetchWallet, useReceivables, useWallet, type ReceivableLoader } from "@/lib/dashboard/live";
import { AgentPicker, findAgent } from "./AgentPicker";
import { BUYER_NAV, BuyerPage } from "./BuyerView";
import { NavAgent, PageHeader } from "./console";
import d from "./Dashboard.module.css";
import { LENDER_NAV, LenderPage } from "./LenderView";
import { McpLog } from "./McpLog";
import { Icons } from "./parts";
import { SELLER_NAV, SellerPage } from "./SellerView";
import type { RoleViewProps, SectionDef } from "./types";
import { WORKER_NAV, WorkerPage } from "./WorkerView";

export const SAVED_AGENT_KEY = "casheth-dashboard-agent";

const ACTIVITY: SectionDef = {
  id: "activity",
  label: "Activity log",
  icon: Icons.activity,
  title: "MCP activity log",
  description: "Every CashETH MCP call that concerns this agent, newest first. Click a row for the full record",
};
const NAV: Record<AgentStats["role"], SectionDef[]> = { seller: SELLER_NAV, buyer: BUYER_NAV, lender: LENDER_NAV, worker: WORKER_NAV };
const PAGES = { seller: SellerPage, buyer: BuyerPage, lender: LenderPage, worker: WorkerPage };
const ROLE_ORDER: AgentStats["role"][] = ["seller", "buyer", "lender", "worker"];

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const readHash = () => window.location.hash;
const serverHash = () => "";

/** `#agent=<0x address or uaid>&view=<section>` → its parts. */
export function parseDashboardHash(hash: string): { agent?: string; view: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const agent = params.get("agent");
  return { ...(agent ? { agent } : {}), view: params.get("view") || "overview" };
}
export const agentFromHash = (hash: string) => parseDashboardHash(hash).agent;
const toHash = (agent: string, view = "overview") => `agent=${encodeURIComponent(agent)}${view === "overview" ? "" : `&view=${encodeURIComponent(view)}`}`;

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

function TopBar({ status, agents, current, onPick }: { status: ConnStatus; agents: AgentStats[]; current?: AgentStats; onPick(id?: string): void }) {
  const conn = CONN[status];
  const sorted = [...agents].sort((x, y) => ROLE_ORDER.indexOf(x.role) - ROLE_ORDER.indexOf(y.role) || x.label.localeCompare(y.label));
  return (
    <header className={a.bar}>
      <div className={a.brand}>
        <Logo size={20} />
        <span className={a.brandTag}>Agent dashboard</span>
      </div>
      <span className={a.netPill}>
        Network <b>Hedera testnet</b>
      </span>
      {agents.length > 0 && (
        <label className={d.switcher}>
          <span className={d.hideSm}>Agent</span>
          <select aria-label="Agent" value={current?.address.toLowerCase() ?? ""} onChange={(e) => onPick(e.target.value || undefined)}>
            <option value="">All agents…</option>
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

type NavProps = { me: AgentStats; sections: SectionDef[]; view: string; counts: Record<string, number>; accountUrl: string; onView(v: string): void; onSwitch(): void };

function SideNav({ me, sections, view, counts, accountUrl, onView, onSwitch }: NavProps) {
  const item = (s: SectionDef) => (
    <button key={s.id} type="button" className={`${a.navItem} ${view === s.id ? a.navOn : ""}`} aria-current={view === s.id ? "page" : undefined} onClick={() => onView(s.id)}>
      <s.icon />
      {s.label}
      {counts[s.id] !== undefined && <span className={a.navCount}>{counts[s.id]}</span>}
    </button>
  );
  return (
    <nav className={a.nav} aria-label="Agent console">
      <NavAgent me={me} onSwitch={onSwitch} />
      <div className={a.navGroup}>{me.role} console</div>
      {sections.map(item)}
      <div className={a.navGroup}>Monitor</div>
      {item(ACTIVITY)}
      <div className={a.navGroup}>Proof</div>
      <a className={a.navItem} href={accountUrl} target="_blank" rel="noopener noreferrer">
        <Icons.wallet />
        HashScan account ↗
      </a>
      <a className={a.navItem} href={`https://hashscan.io/testnet/topic/${HCS_TOPIC_ID}`} target="_blank" rel="noopener noreferrer">
        <Icons.proof />
        Hedera audit log ↗
      </a>
      <div className={a.navFoot}>Read-only. This page holds no keys; it reads the MCP read API and the Hedera mirror node.</div>
    </nav>
  );
}

type Deps = { useData?: () => AdminData; loadWallet?: typeof fetchWallet; loadReceivable?: ReceivableLoader };

/**
 * Public agent dashboard: pick a seller, buyer or lender agent registered with the CashETH MCP server and follow
 * everything it does through the MCP, in a console laid out by section. No sign-in: it reads the public read API
 * and the Hedera mirror node only. Dependencies are injectable for tests.
 */
export function DashboardApp({ useData = useAdminData, loadWallet = fetchWallet, loadReceivable = fetchReceivable }: Deps) {
  const data = useData();
  const nowMs = useNow();
  const hash = useSyncExternalStore(subscribeHash, readHash, serverHash);
  const route = parseDashboardHash(hash);
  const me = route.agent ? findAgent(data.agents, route.agent) : undefined;
  const meAddr = me?.address.toLowerCase();

  const pick = useCallback((id?: string) => {
    window.location.hash = id ? toHash(id) : "";
    try {
      if (id) localStorage.setItem(SAVED_AGENT_KEY, id);
      else localStorage.removeItem(SAVED_AGENT_KEY);
    } catch {}
    window.scrollTo?.({ top: 0 });
  }, []);

  const go = useCallback(
    (view: string) => {
      if (!meAddr) return;
      window.location.hash = toHash(meAddr, view);
      window.scrollTo?.({ top: 0 });
    },
    [meAddr],
  );

  // Reopen the last agent this browser followed.
  useEffect(() => {
    if (window.location.hash) return;
    try {
      const saved = localStorage.getItem(SAVED_AGENT_KEY);
      if (saved) window.location.replace(`#${toHash(saved)}`);
    } catch {}
  }, []);

  const narrated = useMemo(() => narrateAll(data.events, data.agents, HCS_TOPIC_ID), [data.events, data.agents]);
  const refs = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of narrated) if (n.id && n.ref && !m.has(n.id.toLowerCase())) m.set(n.id.toLowerCase(), n.ref);
    return m;
  }, [narrated]);
  const lastSeen = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of narrated) if (n.actor.address && !m.has(n.actor.address)) m.set(n.actor.address, n.ts);
    return m;
  }, [narrated]);
  const baseInvoices = useMemo(() => buildInvoices(data.events, refs), [data.events, refs]);

  const isMine = useCallback(
    (i: Invoice) =>
      !!me &&
      (me.role === "seller" ? i.seller === meAddr : me.role === "buyer" ? i.buyer === meAddr : me.role === "lender" ? i.lenders.some((l) => l.maker === meAddr) : i.workers.includes(meAddr!)),
    [me, meAddr],
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

  // The agent list arrives with the slower stats poll, after the activity; until then the picker is still loading.
  const agentsKnown = data.statsReady || data.sample;

  const banner = data.sample && (
    <div className={a.banner} role="note">
      <b>Sample data · MCP server offline</b>
      <span>
        — start the MCP server on <code>{API_URL}</code> to follow your live agents
      </span>
    </div>
  );

  if (!me) {
    return (
      <div className={a.app}>
        <TopBar status={data.status} agents={data.agents} onPick={pick} />
        {banner}
        <main className={d.main}>
          <AgentPicker
            agents={data.agents}
            status={agentsKnown ? data.status : "loading"}
            lastSeen={lastSeen}
            nowMs={nowMs}
            unknown={route.agent && agentsKnown && data.status !== "loading" ? route.agent : undefined}
            onPick={pick}
          />
        </main>
      </div>
    );
  }

  const sections = NAV[me.role];
  const section = [...sections, ACTIVITY].find((s) => s.id === route.view) ?? sections[0];
  const overview = section.id === "overview";
  const name = me.label || shortAddress(me.address);
  const props: RoleViewProps = { me, agents: data.agents, lenders: data.lenders, events: data.events, mine, wallet, nowMs, log, raw, status: data.status, sample: data.sample, go };
  const Page = PAGES[me.role];
  const updated = data.updatedAt ? `Updated ${relativeTime(new Date(data.updatedAt).toISOString(), nowMs)}` : data.sample ? "Sample data" : "Waiting for data";

  return (
    <div className={a.app}>
      <TopBar status={data.status} agents={data.agents} current={me} onPick={pick} />
      {banner}
      <div className={a.body}>
        <SideNav
          me={me}
          sections={sections}
          view={section.id}
          counts={{ activity: log.length, ...(me.role === "seller" ? { invoices: mine.length } : me.role === "lender" ? { positions: mine.length } : {}) }}
          accountUrl={`https://hashscan.io/testnet/account/${wallet.accountId ?? me.address}`}
          onView={go}
          onSwitch={() => pick(undefined)}
        />
        <main className={a.main}>
          <PageHeader
            crumbs={[{ label: "Agents", onClick: () => pick(undefined) }, { label: name, ...(overview ? {} : { onClick: () => go("overview") }) }, ...(overview ? [] : [{ label: section.label }])]}
            title={overview ? name : section.title}
            description={overview ? `${me.role.charAt(0).toUpperCase()}${me.role.slice(1)} agent · ${section.description}` : section.description}
            actions={<span className={d.updated}>{updated}</span>}
          />
          {section.id === "activity" ? <McpLog items={log} raw={raw} nowMs={nowMs} agentName={name} /> : <Page {...props} view={section.id} />}
        </main>
      </div>
    </div>
  );
}
