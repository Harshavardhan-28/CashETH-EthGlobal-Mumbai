import { useMemo, type ReactNode } from "react";
import type { AgentStats, LenderYield } from "@/lib/admin/api";
import { SETUP_RUN_ID, agentRows, computeKpis, groupRuns, roleBuckets, type Range } from "@/lib/admin/derive";
import { formatUsdc, relativeTime } from "@/lib/admin/format";
import type { Narrated } from "@/lib/admin/narrate";
import styles from "./Admin.module.css";
import { ActivityFeed } from "./ActivityFeed";
import { AgentsTable } from "./AgentsTable";
import { PageHead, RangeControl } from "./Chrome";
import { Icon, Sparkline, StatusChip, Empty } from "./primitives";
import { RoleActivityChart } from "./RoleActivityChart";
import type { Route } from "./route";
import { RunStepper } from "./RunStepper";

export type ViewProps = {
  /** Every narrated event, newest first. */
  all: Narrated[];
  /** `all` scoped by the time range and the search box, newest first. */
  items: Narrated[];
  agents: AgentStats[];
  lenders: LenderYield[];
  range: Range;
  onRange(r: Range): void;
  query: string;
  nowMs: number;
  go(route: Route): void;
};

function Kpi({ label, value, sub, muted, icon, spark }: { label: string; value: string; sub: string; muted?: boolean; icon: ReactNode; spark: number[] }) {
  return (
    <div className={`${styles.card} ${styles.kpi}`}>
      <div className={styles.kpiLabel}>
        <span className={styles.kpiIcon}>{icon}</span>
        {label}
      </div>
      <div className={styles.kpiValue}>{value}</div>
      <div className={`${styles.kpiSub} ${muted ? styles.kpiSubMuted : ""}`}>{sub}</div>
      <Sparkline values={spark} label={label} />
    </div>
  );
}

export function Overview({ all, items, agents, lenders, range, onRange, query, nowMs, go }: ViewProps) {
  const kpis = useMemo(() => computeKpis(all, agents, range, nowMs), [all, agents, range, nowMs]);
  const buckets = useMemo(() => roleBuckets(all, range, nowMs), [all, range, nowMs]);
  const liveRun = useMemo(() => groupRuns(all).find((r) => r.id !== SETUP_RUN_ID), [all]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all_ = agentRows(agents, all, lenders, nowMs);
    return q ? all_.filter((r) => r.actor.name.toLowerCase().includes(q) || r.last?.sentence.toLowerCase().includes(q)) : all_;
  }, [agents, all, lenders, nowMs, query]);
  const selectAgent = (key: string) => go({ view: "agents", agent: key });

  return (
    <>
      <PageHead title="Overview" subtitle="AI agents financing invoices through the CashETH MCP server, recorded on Hedera">
        <RangeControl range={range} onRange={onRange} />
      </PageHead>

      <section className={styles.kpis} aria-label="Key numbers">
        <Kpi label="Agents connected" value={String(kpis.agents)} sub={`${kpis.activeNow} active now`} muted={kpis.activeNow === 0} icon={<Icon.agents />} spark={kpis.spark.agents} />
        <Kpi label="Invoices financed" value={formatUsdc(kpis.financed)} sub={`+${formatUsdc(kpis.financedInRange)} in range`} icon={<Icon.coins />} spark={kpis.spark.financed} />
        <Kpi label="Agent spending (x402)" value={formatUsdc(kpis.spent)} sub={`${kpis.payments} payment${kpis.payments === 1 ? "" : "s"}`} icon={<Icon.card />} spark={kpis.spark.spent} />
        <Kpi
          label="On-chain records"
          value={String(kpis.records)}
          sub={kpis.lastRecordAt ? `Last: ${relativeTime(kpis.lastRecordAt, nowMs)}` : "No records yet"}
          muted
          icon={<Icon.chain />}
          spark={kpis.spark.records}
        />
      </section>

      <section className={styles.row2}>
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <h2>Activity by agent role</h2>
            <span>actions per period</span>
          </div>
          <div className={styles.chartBody}>
            <RoleActivityChart buckets={buckets} nowMs={nowMs} />
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <h2>{liveRun ? `Live run · ${liveRun.title}` : "Live run"}</h2>
            {liveRun && <StatusChip kind={liveRun.status} />}
          </div>
          {liveRun ? (
            <>
              <RunStepper run={liveRun} nowMs={nowMs} />
              <div className={styles.cardHead} style={{ padding: "0 18px 16px" }}>
                <span>{liveRun.amount ? `${formatUsdc(liveRun.amount)} invoice` : ""}</span>
                <button type="button" className={styles.link} onClick={() => go({ view: "runs", run: liveRun.id })}>
                  Open run →
                </button>
              </div>
            </>
          ) : (
            <Empty title="No invoice in flight yet">When a seller agent uploads an invoice, its progress shows here.</Empty>
          )}
        </div>
      </section>

      <section className={styles.card} style={{ marginBottom: 14 }}>
        <div className={styles.cardHead}>
          <h2>Agents</h2>
          <span>
            {agents.length} registered on Hedera (KYA) ·{" "}
            <button type="button" className={styles.link} onClick={() => go({ view: "agents" })}>
              View all
            </button>
          </span>
        </div>
        <AgentsTable rows={rows.slice(0, 6)} lenders={lenders} nowMs={nowMs} onSelect={selectAgent} />
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2>Live activity</h2>
          <span>
            newest first · every row is on Hedera ·{" "}
            <button type="button" className={styles.link} onClick={() => go({ view: "activity" })}>
              View all
            </button>
          </span>
        </div>
        <ActivityFeed items={items} nowMs={nowMs} limit={8} onSelectAgent={selectAgent} />
      </section>
    </>
  );
}
