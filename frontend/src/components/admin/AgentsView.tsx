import { useMemo } from "react";
import { agentRows, type AgentRow } from "@/lib/admin/derive";
import { formatOnTime, formatScore, formatUsdc, relativeTime, shortAddress } from "@/lib/admin/format";
import type { ActorRole } from "@/lib/admin/narrate";
import styles from "./Admin.module.css";
import { ActivityFeed } from "./ActivityFeed";
import { capitalise } from "./AgentsTable";
import { PageHead, RangeControl } from "./Chrome";
import type { ViewProps } from "./Overview";
import { Avatar, Empty, ROLE_COLOR, ROLE_PLURAL, ScoreBar, StatusChip, jobOf, lenderOf } from "./primitives";

const ROLE_ORDER: ActorRole[] = ["seller", "buyer", "worker", "lender"];

export function AgentsView(props: ViewProps & { agentKey?: string }) {
  const { agents, all, lenders, nowMs, query, go, agentKey } = props;
  const rows = useMemo(() => agentRows(agents, all, lenders, nowMs), [agents, all, lenders, nowMs]);

  if (agentKey) {
    const row = rows.find((r) => r.actor.key === agentKey.toLowerCase());
    return row ? <AgentDetail {...props} row={row} /> : <NotFound go={go} />;
  }

  const q = query.trim().toLowerCase();
  const visible = q ? rows.filter((r) => r.actor.name.toLowerCase().includes(q) || r.last?.sentence.toLowerCase().includes(q)) : rows;

  return (
    <>
      <PageHead title="Agents" subtitle="Every agent registered on Hedera (KYA) and what it has done" />
      {!visible.length ? (
        <div className={styles.card}>
          <Empty title={rows.length ? "No agents match your search" : "No agents registered yet"}>
            {rows.length ? undefined : "Agents appear here once they register through the MCP server."}
          </Empty>
        </div>
      ) : (
        ROLE_ORDER.map((role) => {
          const group = visible.filter((r) => r.actor.role === role);
          if (!group.length) return null;
          return (
            <section key={role} className={styles.roleSection} aria-label={ROLE_PLURAL[role]}>
              <h2 className={styles.roleHead}>
                <i style={{ background: ROLE_COLOR[role] }} />
                {ROLE_PLURAL[role]} <span>{group.length}</span>
              </h2>
              <div className={styles.agentGrid}>
                {group.map((row) => (
                  <AgentCard key={row.actor.key} row={row} {...props} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </>
  );
}

function AgentCard({ row, lenders, nowMs, go }: ViewProps & { row: AgentRow }) {
  return (
    <button type="button" className={`${styles.card} ${styles.agentCard}`} onClick={() => go({ view: "agents", agent: row.actor.key })} aria-label={`Open ${row.actor.name}`}>
      <div className={styles.agentTop}>
        <Avatar actor={row.actor} size={38} />
        <div>
          <div className={styles.whoName}>{row.actor.name}</div>
          <div className={styles.whoJob}>{jobOf(row.actor.role, lenderOf(row.stats, lenders))}</div>
        </div>
        <StatusChip kind={row.status} />
      </div>
      <div className={styles.agentStats}>
        <div>
          <div className={styles.miniLabel}>Credit score</div>
          <ScoreBar score={row.stats.score} />
        </div>
        <div>
          <div className={styles.miniLabel}>Money moved</div>
          <span className={styles.mono}>{row.money}</span>
        </div>
      </div>
      <div className={styles.agentLast}>{row.last ? `${capitalise(row.last.sentence)} · ${relativeTime(row.last.ts, nowMs)}` : "No actions yet"}</div>
    </button>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${styles.card} ${styles.tile}`}>
      <div className={styles.miniLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
    </div>
  );
}

function AgentDetail({ row, items, lenders, range, onRange, nowMs, go }: ViewProps & { row: AgentRow }) {
  const s = row.stats;
  const mine = items.filter((i) => i.actor.key === row.actor.key);
  const merchants = Object.entries(s.spendByMerchant ?? {});
  const lender = lenderOf(s, lenders);
  return (
    <>
      <PageHead
        back={{ label: "All agents", onClick: () => go({ view: "agents" }) }}
        title={
          <span className={styles.detailHead}>
            <Avatar actor={row.actor} size={40} />
            {row.actor.name}
            <StatusChip kind={row.status} />
          </span>
        }
        subtitle={`${jobOf(row.actor.role, lender)} · ${shortAddress(s.address)}`}
      >
        <RangeControl range={range} onRange={onRange} />
      </PageHead>
      <section className={styles.tiles}>
        <Tile label="KYA level" value={`Level ${s.level}`} />
        <Tile label="Credit score" value={formatScore(s.score)} />
        <Tile label="On-time repayment" value={formatOnTime(s)} />
        <Tile label="Money moved" value={row.money} />
        <Tile label="Invoices funded" value={String(s.receivablesFunded)} />
        <Tile label="Invoices repaid" value={String(s.receivablesRepaid)} />
        <Tile label="Invoices defaulted" value={String(s.receivablesDefaulted)} />
        {s.role === "lender" ? (
          <Tile label="Lender return" value={`${s.lenderReturnPct.toFixed(1)}%`} />
        ) : (
          <Tile label="Avg days to repay" value={s.avgDaysToRepay ? `${s.avgDaysToRepay} d` : "—"} />
        )}
      </section>
      {merchants.length > 0 && (
        <section className={styles.card} style={{ marginBottom: 14 }}>
          <div className={styles.cardHead}>
            <h2>Spending by merchant</h2>
            <span>paid through x402</span>
          </div>
          <ul className={styles.merchants}>
            {merchants.map(([m, units]) => (
              <li key={m}>
                <span className={styles.mono}>{shortAddress(m)}</span>
                <span className={styles.mono}>{formatUsdc(units)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2>{row.actor.name}&apos;s activity</h2>
          <span>{mine.length} actions</span>
        </div>
        <ActivityFeed items={mine} nowMs={nowMs} emptyText="No actions in this time range" />
      </section>
    </>
  );
}

function NotFound({ go }: { go: ViewProps["go"] }) {
  return (
    <>
      <PageHead back={{ label: "All agents", onClick: () => go({ view: "agents" }) }} title="Agent not found" />
      <div className={styles.card}>
        <Empty title="Agent not found">This agent is not registered on the MCP server.</Empty>
      </div>
    </>
  );
}
