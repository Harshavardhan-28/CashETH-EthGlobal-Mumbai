import { relativeTime } from "@/lib/admin/format";
import type { Narrated } from "@/lib/admin/narrate";
import styles from "./Admin.module.css";
import { Avatar, Empty } from "./primitives";

type Props = {
  items: Narrated[];
  nowMs: number;
  limit?: number;
  emptyText?: string;
  onSelectAgent?(key: string): void;
};

/** Plain-English activity rows. Rows are keyed by seq, so the fade-in plays only when a row first mounts (a new action). */
export function ActivityFeed({ items, nowMs, limit, emptyText = "No activity yet — connect an agent to the MCP server", onSelectAgent }: Props) {
  const shown = limit ? items.slice(0, limit) : items;

  if (!shown.length) return <Empty title={emptyText} />;

  return (
    <ul className={styles.feed}>
      {shown.map((item) => (
        <li key={item.seq} className={`${styles.feedRow} ${styles.fresh}`} data-testid="feed-row" data-tone={item.tone}>
          <Avatar actor={item.actor} size={30} />
          <div className={styles.feedText}>
            <div>
              {onSelectAgent && item.actor.address ? (
                <button type="button" className={styles.actorBtn} onClick={() => onSelectAgent(item.actor.key)}>
                  {item.actor.name}
                </button>
              ) : (
                <b>{item.actor.name}</b>
              )}{" "}
              <span className={item.tone === "blocked" ? styles.toneBlocked : item.tone === "warn" ? styles.toneWarn : undefined}>{item.sentence}</span>
            </div>
            {item.detail && <div className={styles.feedDetail}>{item.detail}</div>}
          </div>
          <span className={styles.feedTime} title={new Date(item.ts).toLocaleString()}>
            {relativeTime(item.ts, nowMs)}
          </span>
          {item.proofUrl ? (
            <a className={styles.proof} href={item.proofUrl} target="_blank" rel="noopener noreferrer">
              View proof ↗
            </a>
          ) : (
            <span className={styles.proofNone} title="No transaction link was recorded for this action">No link</span>
          )}
        </li>
      ))}
    </ul>
  );
}
