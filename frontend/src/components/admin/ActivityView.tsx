"use client";

import { useState } from "react";
import type { ActorRole } from "@/lib/admin/narrate";
import styles from "./Admin.module.css";
import { ActivityFeed } from "./ActivityFeed";
import { PageHead, RangeControl } from "./Chrome";
import type { ViewProps } from "./Overview";

type RoleFilter = "all" | Exclude<ActorRole, "mcp">;
type Outcome = "all" | "ok" | "blocked";

const ROLES: { value: RoleFilter; label: string }[] = [
  { value: "all", label: "All roles" },
  { value: "seller", label: "Sellers" },
  { value: "buyer", label: "Buyers" },
  { value: "worker", label: "Workers" },
  { value: "lender", label: "Lenders" },
];
const OUTCOMES: { value: Outcome; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ok", label: "Succeeded" },
  { value: "blocked", label: "Blocked" },
];

export function ActivityView({ items, range, onRange, nowMs, go }: ViewProps) {
  const [role, setRole] = useState<RoleFilter>("all");
  const [outcome, setOutcome] = useState<Outcome>("all");
  const shown = items.filter(
    (i) => (role === "all" || i.actor.role === role) && (outcome === "all" || (outcome === "blocked" ? i.tone === "blocked" : i.tone === "ok" || i.tone === "info")),
  );
  return (
    <>
      <PageHead title="Activity" subtitle="Everything the agents did through the MCP server, as recorded on Hedera">
        <RangeControl range={range} onRange={onRange} />
      </PageHead>
      <div className={styles.filters}>
        {ROLES.map((r) => (
          <button key={r.value} type="button" className={styles.filterChip} aria-pressed={role === r.value} onClick={() => setRole(r.value)}>
            {r.label}
          </button>
        ))}
        <span className={styles.filterSep} />
        {OUTCOMES.map((o) => (
          <button key={o.value} type="button" className={styles.filterChip} aria-pressed={outcome === o.value} onClick={() => setOutcome(o.value)}>
            {o.label}
          </button>
        ))}
        <span className={styles.count}>
          {shown.length} action{shown.length === 1 ? "" : "s"}
        </span>
      </div>
      <section className={styles.card}>
        <ActivityFeed items={shown} nowMs={nowMs} emptyText={items.length ? "Nothing matches these filters" : undefined} onSelectAgent={(key) => go({ view: "agents", agent: key })} />
      </section>
    </>
  );
}
