/** Console building blocks shared by every role: panels, page header, agent details, wallet, tool usage, connections and recent calls. */
import { useMemo, type ReactNode } from "react";
import a from "@/components/admin/Admin.module.css";
import { Avatar, Empty, ROLE_COLOR, jobOf } from "@/components/admin/primitives";
import { HCS_TOPIC_ID, type AgentStats, type LenderYield } from "@/lib/admin/api";
import { formatUsdc, initials, relativeTime, shortAddress } from "@/lib/admin/format";
import { toolOf } from "@/lib/dashboard/derive";
import { formatHbar } from "@/lib/dashboard/live";
import d from "./Dashboard.module.css";
import { Icons } from "./parts";
import type { RoleViewProps } from "./types";

/** A console panel: title, one-line description, optional actions and a "view all" footer link. */
export function Panel({
  title,
  description,
  actions,
  more,
  children,
  flush,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  more?: { label: string; onClick(): void };
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={`${d.panel} ${className ?? ""}`} aria-label={typeof title === "string" ? title : undefined}>
      <header className={d.panelHead}>
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className={d.panelActions}>{actions}</div>}
      </header>
      <div className={flush ? undefined : d.panelBody}>{children}</div>
      {more && (
        <footer className={d.panelFoot}>
          <button type="button" className={a.link} onClick={more.onClick}>
            {more.label} →
          </button>
        </footer>
      )}
    </section>
  );
}

export function PageHeader({ crumbs, title, description, actions }: { crumbs: { label: string; onClick?(): void }[]; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={d.pageHeader}>
      <nav className={d.crumbs} aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <span key={i}>
            {c.onClick ? (
              <button type="button" onClick={c.onClick}>
                {c.label}
              </button>
            ) : (
              <span aria-current="page">{c.label}</span>
            )}
            {i < crumbs.length - 1 && <i aria-hidden="true">/</i>}
          </span>
        ))}
      </nav>
      <div className={d.pageTitleRow}>
        <div>
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className={d.panelActions}>{actions}</div>}
      </div>
    </div>
  );
}

/** AWS-style summary: label over value, in columns. */
export function Details({ items }: { items: { label: string; value: ReactNode; title?: string }[] }) {
  return (
    <dl className={d.details}>
      {items.map((i) => (
        <div key={i.label}>
          <dt>{i.label}</dt>
          <dd title={i.title}>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AgentDetails({ me, lenders, wallet, log, nowMs }: Pick<RoleViewProps, "me" | "wallet" | "log" | "nowMs"> & { lenders: LenderYield[] }) {
  const lender = lenders.find((l) => l.address.toLowerCase() === me.address.toLowerCase());
  return (
    <Panel title="Agent details" description="On-chain identity from the KYA registry">
      <Details
        items={[
          { label: "Role", value: <span style={{ textTransform: "capitalize" }}>{me.role}</span> },
          { label: "What it does", value: jobOf(me.role, lender) },
          { label: "EVM address", value: <span className={a.mono}>{shortAddress(me.address)}</span>, title: me.address },
          { label: "Hedera account", value: wallet.accountId ?? "—" },
          { label: "UAID", value: <span className={a.mono}>{me.uaid.length > 24 ? `${me.uaid.slice(0, 22)}…` : me.uaid}</span>, title: me.uaid },
          { label: "KYA level", value: `Level ${me.level}` },
          { label: "Trust score", value: `${Math.round(me.score)} / 100${me.role === "seller" || me.role === "buyer" ? ` · ${me.tier} tier` : ""}` },
          { label: "Last MCP call", value: log[0] ? relativeTime(log[0].ts, nowMs) : "Never" },
        ]}
      />
    </Panel>
  );
}

export function WalletPanel({ me, wallet, sample, more }: Pick<RoleViewProps, "me" | "wallet" | "sample"> & { more?: { label: string; onClick(): void } }) {
  const note = sample ? "Sample data: no live wallet read" : wallet.status === "loading" ? "Reading the Hedera mirror node…" : wallet.status === "error" ? "Mirror node unavailable" : undefined;
  return (
    <Panel
      title="Wallet"
      description="Live balance from the Hedera mirror node"
      more={more}
      actions={
        <a className={a.proof} href={`https://hashscan.io/testnet/account/${wallet.accountId ?? me.address}`} target="_blank" rel="noopener noreferrer">
          HashScan ↗
        </a>
      }
    >
      <div className={d.walletBig} data-testid="wallet-usdc">
        {formatUsdc(wallet.usdc)}
        <small>USDC</small>
      </div>
      <div className={d.walletRow}>
        <span>
          <Icons.bolt /> {formatHbar(wallet.hbar)} for gas
        </span>
        <span>{note ?? `Account ${wallet.accountId ?? shortAddress(me.address)}`}</span>
      </div>
    </Panel>
  );
}

/** Which MCP tools the agent's activity came through, as horizontal bars. */
export function ToolUsage({ log, raw, more }: Pick<RoleViewProps, "log" | "raw"> & { more?: { label: string; onClick(): void } }) {
  const rows = useMemo(() => {
    const counts = new Map<string, { n: number; blocked: number }>();
    for (const i of log) {
      const e = raw.get(i.seq);
      const t = e ? toolOf(e) : i.type;
      const c = counts.get(t) ?? { n: 0, blocked: 0 };
      c.n += 1;
      if (i.tone === "blocked") c.blocked += 1;
      counts.set(t, c);
    }
    return [...counts.entries()].sort((x, y) => y[1].n - x[1].n);
  }, [log, raw]);
  const max = Math.max(1, ...rows.map(([, c]) => c.n));
  return (
    <Panel title="MCP tools used" description="Calls per CashETH MCP tool" more={more}>
      {rows.length ? (
        <ul className={d.bars}>
          {rows.slice(0, 7).map(([tool, c]) => (
            <li key={tool}>
              <span className={d.tool}>{tool}</span>
              <span className={d.barTrack}>
                <i style={{ width: `${(c.n / max) * 100}%` }} />
              </span>
              <b>
                {c.n}
                {c.blocked > 0 && <em> · {c.blocked} blocked</em>}
              </b>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No MCP calls yet" />
      )}
    </Panel>
  );
}

const STATUS_TEXT = { live: "Connected", offline: "Unreachable", loading: "Connecting…" } as const;

/** Health of the services the dashboard (and the agent) depend on. */
export function Connections({ status, wallet, sample, log }: Pick<RoleViewProps, "status" | "wallet" | "sample" | "log">) {
  const rows: { name: string; detail: string; state: "ok" | "warn" | "bad" }[] = [
    { name: "CashETH MCP server", detail: `Read API · ${STATUS_TEXT[status]}`, state: status === "live" ? "ok" : status === "loading" ? "warn" : "bad" },
    {
      name: "Hedera mirror node",
      detail: sample ? "Skipped for sample data" : wallet.status === "ok" ? "Wallet balance read" : wallet.status === "loading" ? "Reading…" : "Unavailable",
      state: wallet.status === "ok" ? "ok" : sample || wallet.status === "loading" ? "warn" : "bad",
    },
    {
      name: "Hedera audit topic",
      detail: `${HCS_TOPIC_ID} · ${log.filter((i) => i.proofUrl).length} recorded`,
      state: "ok",
    },
  ];
  return (
    <Panel title="Service health" description="What this dashboard reads from">
      <ul className={d.health}>
        {rows.map((r) => (
          <li key={r.name}>
            <i className={r.state === "ok" ? d.dotOk : r.state === "warn" ? d.dotWarn : d.dotBad} aria-hidden="true" />
            <div>
              <b>{r.name}</b>
              <span>{r.detail}</span>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** The latest few MCP calls, compact. */
export function RecentCalls({ log, raw, nowMs, more, limit = 6 }: Pick<RoleViewProps, "log" | "raw" | "nowMs"> & { more?: { label: string; onClick(): void }; limit?: number }) {
  return (
    <Panel title="Recent MCP calls" description="Newest first, each with its Hedera proof" more={more} flush>
      {log.length ? (
        <ul className={d.recent}>
          {log.slice(0, limit).map((i) => {
            const e = raw.get(i.seq);
            return (
              <li key={i.seq}>
                <Avatar actor={i.actor} size={26} />
                <div>
                  <span className={d.tool}>{e ? toolOf(e) : i.type}</span>
                  <p className={i.tone === "blocked" ? a.toneBlocked : undefined}>
                    <b>{i.actor.name}</b> {i.sentence}
                  </p>
                </div>
                <span className={a.when}>{relativeTime(i.ts, nowMs)}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty title="No MCP calls yet">Calls this agent makes appear here within seconds.</Empty>
      )}
    </Panel>
  );
}

/** Agent chip at the top of the side nav. */
export function NavAgent({ me, onSwitch }: { me: AgentStats; onSwitch(): void }) {
  const name = me.label || shortAddress(me.address);
  return (
    <div className={d.navAgent}>
      <Avatar actor={{ name, role: me.role, initials: initials(name) }} size={34} />
      <div>
        <b>{name}</b>
        <span>
          <i style={{ background: ROLE_COLOR[me.role] }} />
          {me.role} · {shortAddress(me.address)}
        </span>
      </div>
      <button type="button" className={d.navSwitch} onClick={onSwitch} aria-label="Switch agent" title="Switch agent">
        ⇄
      </button>
    </div>
  );
}
