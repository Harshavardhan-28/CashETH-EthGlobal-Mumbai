"use client";

import { useMemo, useState, type FormEvent } from "react";
import a from "@/components/admin/Admin.module.css";
import { Avatar, Empty, ROLE_COLOR, ScoreBar, jobOf } from "@/components/admin/primitives";
import type { AgentStats } from "@/lib/admin/api";
import { initials, relativeTime, shortAddress } from "@/lib/admin/format";
import type { ConnStatus } from "@/lib/admin/useAdminData";
import d from "./Dashboard.module.css";
import { Icons } from "./parts";

/** The registered agent with this EVM address or UAID (case-insensitive). */
export function findAgent(agents: AgentStats[], id: string): AgentStats | undefined {
  const q = id.trim().toLowerCase();
  return agents.find((x) => x.address.toLowerCase() === q || x.uaid.toLowerCase() === q);
}

type RoleFilter = "all" | AgentStats["role"];
const TABS: { value: RoleFilter; label: string; hint: string }[] = [
  { value: "all", label: "All agents", hint: "" },
  { value: "seller", label: "Sellers", hint: "Credit, worker agents, invoices, payback" },
  { value: "buyer", label: "Buyers", hint: "Invoices due and payments" },
  { value: "lender", label: "Lenders", hint: "Capital, returns, liquidity, positions" },
  { value: "worker", label: "Workers", hint: "Budget and x402 spending" },
];
const ORDER: AgentStats["role"][] = ["seller", "buyer", "lender", "worker"];

type Props = { agents: AgentStats[]; status: ConnStatus; lastSeen: ReadonlyMap<string, string>; nowMs: number; unknown?: string; onPick(id: string): void };

/** No sign-in: the agent is chosen by its on-chain identity (EVM address or UAID), or from the registered list. */
export function AgentPicker({ agents, status, lastSeen, nowMs, unknown, onPick }: Props) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<RoleFilter>("all");
  const [error, setError] = useState<string | undefined>();

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: agents.length };
    for (const x of agents) c[x.role] = (c[x.role] ?? 0) + 1;
    return c;
  }, [agents]);

  const q = query.trim().toLowerCase();
  const rows = useMemo(
    () =>
      agents
        .filter((x) => (role === "all" || x.role === role) && (!q || [x.label, x.address, x.uaid, x.role].some((v) => v.toLowerCase().includes(q))))
        .sort((x, y) => ORDER.indexOf(x.role) - ORDER.indexOf(y.role) || x.label.localeCompare(y.label)),
    [agents, role, q],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!q) return setError("Paste your agent's EVM address (0x…) or UAID, or pick one below.");
    const hit = findAgent(agents, q) ?? (rows.length === 1 ? rows[0] : undefined);
    if (!hit) return setError("No agent with that address or UAID is registered with the CashETH MCP server.");
    setError(undefined);
    onPick(hit.address.toLowerCase());
  };

  return (
    <div className={d.picker}>
      <section className={d.pickHero}>
        <h1>Follow your agent</h1>
        <p>Track what your seller, buyer or lender agent does through the CashETH MCP server: its wallet, credit, invoices and every tool call, each with Hedera proof.</p>
        <form className={d.pickForm} onSubmit={submit} role="search">
          <span className={d.pickIcon}>
            <Icons.search />
          </span>
          <input
            aria-label="Agent address or UAID"
            placeholder="Search by name, 0x address or UAID"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setError(undefined);
            }}
            spellCheck={false}
            autoComplete="off"
          />
          <button type="submit" className={d.btn}>
            Open dashboard
          </button>
        </form>
        {(error || unknown) && (
          <p className={d.pickError} role="alert">
            {error ?? `No registered agent matches ${shortAddress(unknown!)}. Pick one below.`}
          </p>
        )}
        <ul className={d.pickPoints}>
          <li>
            <Icons.wallet /> Live wallet balance
          </li>
          <li>
            <Icons.coins /> Credit, dues or returns
          </li>
          <li>
            <Icons.activity /> Every MCP call, with proof
          </li>
        </ul>
      </section>

      <section className={d.panel} aria-label="Registered agents">
        <header className={d.panelHead}>
          <div>
            <h2>Registered agents</h2>
            <p>Agents with an on-chain KYA identity on the CashETH MCP server</p>
          </div>
          <span className={a.when}>
            {rows.length} of {agents.length}
          </span>
        </header>
        <div className={d.tabs} role="tablist" aria-label="Role">
          {TABS.map((t) => (
            <button key={t.value} type="button" role="tab" aria-selected={role === t.value} title={t.hint || undefined} onClick={() => setRole(t.value)}>
              {t.value !== "all" && <i style={{ background: ROLE_COLOR[t.value] }} />}
              {t.label}
              <span>{counts[t.value] ?? 0}</span>
            </button>
          ))}
        </div>
        {!rows.length ? (
          <Empty title={status === "loading" ? "Loading agents…" : agents.length ? "No agents match" : "No agents registered yet"}>
            {status !== "loading" && !agents.length ? "Agents appear here once they register through the MCP server." : undefined}
          </Empty>
        ) : (
          <div className={a.tableWrap} style={{ paddingTop: 0 }}>
            <table className={a.table}>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Role</th>
                  <th>Address</th>
                  <th>KYA</th>
                  <th>Credit score</th>
                  <th>Last MCP call</th>
                  <th aria-label="Open" />
                </tr>
              </thead>
              <tbody>
                {rows.map((x) => {
                  const name = x.label || shortAddress(x.address);
                  const seen = lastSeen.get(x.address.toLowerCase());
                  return (
                    <tr key={x.address} className={a.rowClick} onClick={() => onPick(x.address.toLowerCase())}>
                      <td>
                        <div className={a.who}>
                          <Avatar actor={{ name, role: x.role, initials: initials(name) }} size={32} />
                          <div>
                            <div className={a.whoName}>{name}</div>
                            <div className={a.whoJob}>{jobOf(x.role)}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={d.roleTag} style={{ color: ROLE_COLOR[x.role] }}>
                          <i style={{ background: ROLE_COLOR[x.role] }} />
                          {x.role}
                        </span>
                      </td>
                      <td className={a.mono}>{shortAddress(x.address)}</td>
                      <td>Level {x.level}</td>
                      <td>
                        <ScoreBar score={x.score} />
                      </td>
                      <td className={a.when}>{seen ? relativeTime(seen, nowMs) : "—"}</td>
                      <td>
                        <button
                          type="button"
                          className={d.btnGhost}
                          aria-label={`Open ${name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onPick(x.address.toLowerCase());
                          }}
                        >
                          Open →
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
