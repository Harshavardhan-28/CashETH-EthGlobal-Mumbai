"use client";

import { useState, type FormEvent } from "react";
import a from "@/components/admin/Admin.module.css";
import { Avatar, Empty, ROLE_COLOR, ROLE_PLURAL, ScoreBar, jobOf } from "@/components/admin/primitives";
import type { AgentStats } from "@/lib/admin/api";
import { initials, shortAddress } from "@/lib/admin/format";
import type { ConnStatus } from "@/lib/admin/useAdminData";
import d from "./Dashboard.module.css";

/** The registered agent with this EVM address or UAID (case-insensitive). */
export function findAgent(agents: AgentStats[], id: string): AgentStats | undefined {
  const q = id.trim().toLowerCase();
  return agents.find((x) => x.address.toLowerCase() === q || x.uaid.toLowerCase() === q);
}

const ROLES: AgentStats["role"][] = ["seller", "buyer", "lender", "worker"];
const BLURB: Record<AgentStats["role"], string> = {
  seller: "Credit raised, your worker agents' spending, invoices and payback",
  buyer: "Invoices due, payment dates and your repayment history",
  lender: "Capital lent, return rate, liquidity and positions",
  worker: "Budget, x402 payments and guardrail blocks",
};

type Props = { agents: AgentStats[]; status: ConnStatus; unknown?: string; onPick(id: string): void };

/** No sign-in: the agent is chosen by its on-chain identity (EVM address or UAID), or from the registered list. */
export function AgentPicker({ agents, status, unknown, onPick }: Props) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return setError("Paste your agent's EVM address (0x…) or UAID.");
    const hit = findAgent(agents, v);
    if (!hit) return setError("No agent with that address or UAID is registered with the CashETH MCP server.");
    setError(undefined);
    onPick(hit.address.toLowerCase());
  };

  return (
    <>
      <section className={`${a.card} ${d.pickHero}`}>
        <h1>Follow your agent</h1>
        <p>
          See everything your seller, buyer or lender agent does through the CashETH MCP server: every tool call, its wallet balance, the credit it raised or lent,
          and each invoice, with the Hedera proof for each step.
        </p>
        <form className={d.pickForm} onSubmit={submit}>
          <input aria-label="Agent address or UAID" placeholder="0x… address or uaid:aid:…" value={value} onChange={(e) => setValue(e.target.value)} spellCheck={false} />
          <button type="submit" className={d.btn}>
            Open dashboard
          </button>
        </form>
        {(error || unknown) && (
          <p className={d.pickError} role="alert">
            {error ?? `No registered agent matches ${shortAddress(unknown!)}. Pick one below.`}
          </p>
        )}
        <p className={d.pickNote}>Read-only and public: it uses the MCP read API and the Hedera mirror node, never your keys.</p>
      </section>

      {!agents.length ? (
        <div className={a.card}>
          <Empty title={status === "loading" ? "Loading agents…" : "No agents registered yet"}>
            {status === "loading" ? undefined : "Agents appear here once they register through the MCP server."}
          </Empty>
        </div>
      ) : (
        ROLES.map((role) => {
          const group = agents.filter((x) => x.role === role);
          if (!group.length) return null;
          return (
            <section key={role} className={a.roleSection} aria-label={ROLE_PLURAL[role]}>
              <h2 className={a.roleHead}>
                <i style={{ background: ROLE_COLOR[role] }} />
                {ROLE_PLURAL[role]} <span>{BLURB[role]}</span>
              </h2>
              <div className={a.agentGrid}>
                {group.map((x) => {
                  const name = x.label || shortAddress(x.address);
                  return (
                    <button key={x.address} type="button" className={`${a.card} ${a.agentCard}`} onClick={() => onPick(x.address.toLowerCase())} aria-label={`Open ${name}`}>
                      <div className={a.agentTop}>
                        <Avatar actor={{ name, role: x.role, initials: initials(name) }} size={38} />
                        <div>
                          <div className={a.whoName}>{name}</div>
                          <div className={a.whoJob}>{jobOf(x.role)}</div>
                        </div>
                      </div>
                      <div className={a.agentStats}>
                        <div>
                          <div className={a.miniLabel}>Trust score</div>
                          <ScoreBar score={x.score} />
                        </div>
                        <div>
                          <div className={a.miniLabel}>Address</div>
                          <span className={a.mono}>{shortAddress(x.address)}</span>
                        </div>
                      </div>
                      <div className={a.agentLast}>KYA level {x.level} · open dashboard →</div>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })
      )}
    </>
  );
}
