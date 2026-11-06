import type { LenderYield } from "@/lib/admin/api";
import type { AgentRow } from "@/lib/admin/derive";
import { relativeTime } from "@/lib/admin/format";
import styles from "./Admin.module.css";
import { Avatar, Empty, ScoreBar, StatusChip, jobOf, lenderOf } from "./primitives";

type Props = { rows: AgentRow[]; lenders: LenderYield[]; nowMs: number; onSelect?(key: string): void };

export function AgentsTable({ rows, lenders, nowMs, onSelect }: Props) {
  if (!rows.length) return <Empty title="No agents registered yet">Agents appear here once they register through the MCP server.</Empty>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Status</th>
            <th>Last action</th>
            <th>Trust score</th>
            <th>Money moved</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.actor.key} className={onSelect ? styles.rowClick : undefined} onClick={onSelect ? () => onSelect(row.actor.key) : undefined}>
              <td>
                <div className={styles.who}>
                  <Avatar actor={row.actor} />
                  <div>
                    <div className={styles.whoName}>{row.actor.name}</div>
                    <div className={styles.whoJob}>{jobOf(row.actor.role, lenderOf(row.stats, lenders))}</div>
                  </div>
                </div>
              </td>
              <td>
                <StatusChip kind={row.status} />
              </td>
              <td>
                {row.last ? (
                  <>
                    {capitalise(row.last.sentence)} · <span className={styles.when}>{relativeTime(row.last.ts, nowMs)}</span>
                  </>
                ) : (
                  <span className={styles.when}>No actions yet</span>
                )}
              </td>
              <td>
                <ScoreBar score={row.stats.score} />
              </td>
              <td className={styles.mono}>{row.money}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
