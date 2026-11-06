"use client";

import { Fragment, useMemo, useState } from "react";
import a from "@/components/admin/Admin.module.css";
import { RangeControl } from "@/components/admin/Chrome";
import { Avatar, Empty } from "@/components/admin/primitives";
import type { AuditEvent } from "@/lib/admin/api";
import { HCS_TOPIC_ID } from "@/lib/admin/api";
import { inRange, type Range } from "@/lib/admin/derive";
import { formatUsdc, humanizeCode, relativeTime, shortAddress } from "@/lib/admin/format";
import type { Narrated } from "@/lib/admin/narrate";
import { toolOf } from "@/lib/dashboard/derive";
import d from "./Dashboard.module.css";
import { Card } from "./parts";

type Outcome = "all" | "ok" | "blocked";
const OUTCOMES: { value: Outcome; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ok", label: "Succeeded" },
  { value: "blocked", label: "Blocked" },
];
const PAGE = 25;

type Props = {
  items: Narrated[]; // newest first
  raw: ReadonlyMap<number, AuditEvent>;
  nowMs: number;
  agentName: string;
  /** Hide the actor column when every row is the same agent. */
  showActor?: boolean;
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span>{label}</span>
      {children}
    </div>
  );
}

function Details({ e }: { e: AuditEvent }) {
  const str = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : undefined);
  return (
    <div className={d.logGrid}>
      <Field label="Event">
        <code>
          #{e.seq} · {e.type}
        </code>
      </Field>
      <Field label="Recorded">
        <code>{new Date(e.ts).toLocaleString()}</code>
      </Field>
      {e.id && (
        <Field label="Receivable id">
          <code>{e.id}</code>
        </Field>
      )}
      {e.spendId && (
        <Field label="Spend id">
          <code>{e.spendId}</code>
        </Field>
      )}
      {str("merchant") && (
        <Field label="Merchant">
          <code>{str("merchant")}</code>
        </Field>
      )}
      {e.code && (
        <Field label="Rejection">
          <code>
            {e.code} · {humanizeCode(e.code)}
          </code>
        </Field>
      )}
      {e.agent && (
        <Field label="Caller">
          <code>{e.agent}</code>
        </Field>
      )}
      {e.jti && (
        <Field label="Access token (jti)">
          <code>{e.jti}</code>
        </Field>
      )}
      {e.txHash && (
        <Field label="EVM transaction">
          <a href={e.hashscan ?? `https://hashscan.io/testnet/transaction/${e.txHash}`} target="_blank" rel="noopener noreferrer">
            <code>{shortAddress(e.txHash)} ↗</code>
          </a>
        </Field>
      )}
      {str("paymentHashscan") && (
        <Field label="x402 payment">
          <a href={str("paymentHashscan")} target="_blank" rel="noopener noreferrer">
            <code>{e.txId ?? "HashScan"} ↗</code>
          </a>
        </Field>
      )}
      <Field label="Hedera audit message">
        {typeof e.hcsSeq === "number" ? (
          <a href={`https://hashscan.io/testnet/topic/${HCS_TOPIC_ID}/message/${e.hcsSeq}`} target="_blank" rel="noopener noreferrer">
            <code>
              {HCS_TOPIC_ID} #{e.hcsSeq} ↗
            </code>
          </a>
        ) : (
          <code>{e.hcsError ? "not published" : "—"}</code>
        )}
      </Field>
    </div>
  );
}

/** Every MCP call that concerns the agent, newest first: tool, plain-English outcome, amount and on-chain proof. Rows expand to the raw record. */
export function McpLog({ items, raw, nowMs, agentName, showActor = true }: Props) {
  const [range, setRange] = useState<Range>("all");
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [tool, setTool] = useState("all");
  const [open, setOpen] = useState<number | undefined>();
  const [limit, setLimit] = useState(PAGE);

  const withTool = useMemo(() => items.map((i) => ({ item: i, tool: raw.get(i.seq) ? toolOf(raw.get(i.seq)!) : i.type })), [items, raw]);
  const tools = useMemo(() => [...new Set(withTool.map((x) => x.tool))].sort(), [withTool]);
  const scoped = useMemo(() => {
    const inR = new Set(inRange(items, range, nowMs).map((i) => i.seq));
    return withTool.filter(
      ({ item, tool: t }) =>
        inR.has(item.seq) && (tool === "all" || t === tool) && (outcome === "all" || (outcome === "blocked" ? item.tone === "blocked" : item.tone !== "blocked")),
    );
  }, [withTool, items, range, nowMs, tool, outcome]);
  const blocked = items.filter((i) => i.tone === "blocked").length;

  const download = () => {
    const rows = scoped.map(({ item }) => raw.get(item.seq)).filter(Boolean);
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `casheth-${agentName.toLowerCase().replace(/\W+/g, "-")}-mcp-log.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const shown = scoped.slice(0, limit);
  const cols = showActor ? 7 : 6;

  return (
    <Card title="MCP activity log" sub={`${items.length} call${items.length === 1 ? "" : "s"} · ${blocked} blocked by guardrails`}>
      <div className={d.logTools}>
        <RangeControl range={range} onRange={setRange} />
        <div className={a.seg} role="group" aria-label="Outcome">
          {OUTCOMES.map((o) => (
            <button key={o.value} type="button" aria-pressed={outcome === o.value} onClick={() => setOutcome(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
        <select aria-label="MCP tool" value={tool} onChange={(e) => setTool(e.target.value)}>
          <option value="all">All tools</option>
          {tools.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span className={d.spacer} />
        <button type="button" className={d.btnGhost} onClick={download} disabled={!scoped.length}>
          Export JSON
        </button>
      </div>
      {!shown.length ? (
        <Empty title={items.length ? "Nothing matches these filters" : "No MCP calls yet"}>
          {items.length ? undefined : "Calls this agent makes to the CashETH MCP server show up here within seconds."}
        </Empty>
      ) : (
        <div className={a.tableWrap} style={{ paddingTop: 0 }}>
          <table className={d.log}>
            <thead>
              <tr>
                <th>When</th>
                {showActor && <th>Agent</th>}
                <th>MCP tool</th>
                <th>What happened</th>
                <th className={d.num}>Amount</th>
                <th>Result</th>
                <th>Proof</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ item, tool: t }) => {
                const e = raw.get(item.seq);
                const isOpen = open === item.seq;
                const toggle = () => setOpen(isOpen ? undefined : item.seq);
                return (
                  <Fragment key={item.seq}>
                    <tr
                      className={`${d.logRow} ${isOpen ? d.logOpen : ""}`}
                      tabIndex={0}
                      aria-expanded={isOpen}
                      data-testid="log-row"
                      onClick={toggle}
                      onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), toggle())}
                    >
                      <td className={a.when} title={new Date(item.ts).toLocaleString()} style={{ whiteSpace: "nowrap" }}>
                        {relativeTime(item.ts, nowMs)}
                      </td>
                      {showActor && (
                        <td>
                          <span className={d.logWho}>
                            <Avatar actor={item.actor} size={22} />
                            {item.actor.name}
                          </span>
                        </td>
                      )}
                      <td>
                        <span className={d.tool}>{t}</span>
                      </td>
                      <td className={d.logWhat}>
                        <span className={item.tone === "blocked" ? a.toneBlocked : item.tone === "warn" ? a.toneWarn : undefined}>
                          {item.sentence.charAt(0).toUpperCase() + item.sentence.slice(1)}
                        </span>
                        {item.detail && <span className={d.sub}>{item.detail}</span>}
                      </td>
                      <td className={`${d.num} ${a.mono}`}>{item.amount ? formatUsdc(item.amount) : "—"}</td>
                      <td>
                        <span className={`${a.chip} ${item.tone === "blocked" ? a.chipBad : item.tone === "warn" ? a.chipWarn : a.chipGood}`}>
                          <i />
                          {item.tone === "blocked" ? "Blocked" : item.tone === "warn" ? "Flagged" : "OK"}
                        </span>
                      </td>
                      <td onClick={(ev) => ev.stopPropagation()}>
                        {item.proofUrl ? (
                          <a className={a.proof} href={item.proofUrl} target="_blank" rel="noopener noreferrer">
                            View ↗
                          </a>
                        ) : (
                          <span className={a.proofNone}>—</span>
                        )}
                      </td>
                    </tr>
                    {isOpen && e && (
                      <tr className={d.logDetail}>
                        <td colSpan={cols}>
                          <Details e={e} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {scoped.length > limit && (
            <div className={d.logMore}>
              <button type="button" className={d.btnGhost} onClick={() => setLimit((l) => l + PAGE)}>
                Show {Math.min(PAGE, scoped.length - limit)} more of {scoped.length - limit}
              </button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
