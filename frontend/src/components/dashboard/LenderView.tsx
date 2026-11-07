import { useMemo } from "react";
import a from "@/components/admin/Admin.module.css";
import { Empty, ROLE_COLOR } from "@/components/admin/primitives";
import type { LenderYield } from "@/lib/admin/api";
import { formatScore, shortAddress } from "@/lib/admin/format";
import { backingOf, formatRate, rateRange, SLABS, slabLabel, type Backing } from "@/lib/admin/slabs";
import { addU, lenderOf, lenderPositions, type Position } from "@/lib/dashboard/derive";
import { AgentDetails, Connections, Panel, RecentCalls, ToolUsage, WalletPanel } from "./console";
import d from "./Dashboard.module.css";
import { DueLabel, Icons, InvoiceName, KV, Meter, Party, Proof, Stat, StateChip, pct, usd } from "./parts";
import type { RoleViewProps, SectionDef } from "./types";

export const LENDER_NAV: SectionDef[] = [
  { id: "overview", label: "Overview", icon: Icons.overview, title: "Overview", description: "Your capital, what it earns and who it is lent to" },
  { id: "sellers", label: "Sellers", icon: Icons.agents, title: "Sellers", description: "Agents you can back: each one's risk slab and the rate it pays, set on chain from its score" },
  { id: "liquidity", label: "Liquidity", icon: Icons.coins, title: "Liquidity", description: "Non-custodial: your USDC stays in your wallet until one of your 1inch Aqua strategies fills" },
  { id: "positions", label: "Positions", icon: Icons.runs, title: "Positions", description: "Invoices your credit strategy funded, and where each loan stands" },
  { id: "returns", label: "Returns", icon: Icons.percent, title: "Returns", description: "Fees earned from sellers' credit and from base-yield swaps" },
];

const BACKING: Record<Backing, { label: string; cls: string }> = {
  backed: { label: "Backed by you", cls: a.chipGood },
  "outside-slabs": { label: "Outside your slabs", cls: a.chipIdle },
  "not-listed": { label: "Not on your list", cls: a.chipIdle },
  "not-financeable": { label: "Not financeable", cls: a.chipBad },
};

/** How to change what the lender backs: lenders act through their MCP connection, the dashboard only reads. */
const CHANGE_HINT = "To change the slabs or sellers you back, call fund_agents (lend:write) with slabs and up to 3 sellers.";

function Kpis({ y, idle, earned, open, late, me }: { y?: LenderYield; idle?: string; earned: string; open: number; late: number; me: RoleViewProps["me"] }) {
  return (
    <section className={a.kpis} aria-label="Capital">
      <Stat label="Total capital" value={usd(y?.capital ?? idle)} sub="Idle in your wallet + lent" icon={<Icons.coins />} />
      <Stat label="Lent to sellers" value={usd(y?.lent ?? "0")} sub={`${open} open position${open === 1 ? "" : "s"}${late ? ` · ${late} late` : ""}`} tone={late ? "warn" : "accent"} icon={<Icons.card />} />
      <Stat label="Blended return" value={pct(y?.blendedApr ?? 0)} sub={`Farming ${pct(y?.baseApr ?? 0)} · lending ${pct(y?.creditApr ?? 0)} APR`} tone="accent" icon={<Icons.percent />} />
      <Stat label="Earned so far" value={usd(earned)} sub={`${pct(me.lenderReturnPct)} on capital`} icon={<Icons.check />} />
    </section>
  );
}

function Allocation({ y, idle }: { y?: LenderYield; idle?: string }) {
  return (
    <Meter
      label="Capital allocation"
      segments={[
        { label: `Lent ${usd(y?.lent ?? "0")}`, value: Number(y?.lent ?? 0), color: ROLE_COLOR.lender },
        { label: `Idle ${usd(idle)}`, value: Number(idle ?? 0), color: "var(--accent)" },
      ]}
    />
  );
}

/** What lending adds on top of plain yield farming: the two rates side by side and the extra USDC it earned. */
function FarmingVsLending({ y }: { y?: LenderYield }) {
  return (
    <KV
      rows={[
        { label: "Farming only", value: `${pct(y?.baseApr ?? 0)} APR`, hint: "Aqua swap fees on idle USDC" },
        { label: "Lending", value: `${pct(y?.creditApr ?? 0)} APR`, hint: "each loan at its seller's own rate" },
        { label: "Your blend", value: `${pct(y?.blendedApr ?? 0)} APR`, hint: "weighted by idle and lent capital" },
        { label: "Extra over farming", value: usd(y?.extraEarned ?? "0"), hint: "credit fees minus what that capital would have earned farming" },
      ]}
    />
  );
}

function Strategies({ y }: { y?: LenderYield }) {
  const creditOn = !!y && (!!y.strategies.credit || y.slabs.length > 0);
  const baseOn = !!y && (!!y.strategies.base || y.baseApr > 0);
  return (
    <div className={d.strategies}>
      <div className={d.strategy}>
        <h3>
          Credit strategy <span className={`${a.chip} ${creditOn ? a.chipGood : a.chipIdle}`}>{creditOn ? "Active" : "Off"}</span>
        </h3>
        <p>
          {creditOn ? y!.slabs.map((s) => `${SLABS[s].label} (${SLABS[s].rates})`).join(" · ") : "No risk slab funded"} · 1inch Aqua
          {y?.strategies.credit ? ` · ${shortAddress(y.strategies.credit)}` : ""}
        </p>
        <div className={d.strategyApr}>{creditOn ? `${rateRange(y!.slabs)} APR` : "Not offered"}</div>
        <p>
          You choose the risk, not the price: each loan pays its seller&apos;s own rate, set on chain from its score.
          {y?.sellers.length ? ` Only your ${y.sellers.length} chosen seller${y.sellers.length === 1 ? "" : "s"}.` : " Any seller in these slabs."}
        </p>
      </div>
      <div className={d.strategy}>
        <h3>
          Base-yield strategy <span className={`${a.chip} ${baseOn ? a.chipGood : a.chipIdle}`}>{baseOn ? "Active" : "Off"}</span>
        </h3>
        <p>USDC / tUSDT · 30 bps swaps{y?.strategies.base ? ` · ${shortAddress(y.strategies.base)}` : ""}</p>
        <div className={d.strategyApr}>{baseOn ? `${pct(y!.baseApr)} APR` : "Not offered"}</div>
        <p>Idle capital earns swap fees while it waits for credit demand.</p>
      </div>
    </div>
  );
}

/** Every seller agent with its score, slab and rate, and whether this lender's credit strategies back it. */
function SellerTable({ y, agents }: { y?: LenderYield; agents: RoleViewProps["agents"] }) {
  const sellers = agents.filter((x) => x.role === "seller");
  if (!sellers.length) return <Empty title="No sellers yet">Seller agents appear here once they register through the MCP server.</Empty>;
  return (
    <div className={a.tableWrap} style={{ paddingTop: 0 }}>
      <table className={a.table}>
        <thead>
          <tr>
            <th>Seller</th>
            <th className={d.num}>Score</th>
            <th>Risk slab</th>
            <th className={d.num}>Rate it pays</th>
            <th>Your strategy</th>
          </tr>
        </thead>
        <tbody>
          {sellers.map((s) => {
            const backing = BACKING[backingOf(y, s)];
            return (
              <tr key={s.address}>
                <td>
                  <Party address={s.address} agents={agents} />
                </td>
                <td className={`${d.num} ${a.mono}`}>{formatScore(s.score)}</td>
                <td>{slabLabel(s.slab)}</td>
                <td className={`${d.num} ${a.mono}`}>{formatRate(s.aprBps)}</td>
                <td>
                  <span className={`${a.chip} ${backing.cls}`}>{backing.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PositionTable({ positions, agents, nowMs, compact }: { positions: Position[]; agents: RoleViewProps["agents"]; nowMs: number; compact?: boolean }) {
  if (!positions.length) return <Empty title="No positions yet">When a seller&apos;s invoice fills your credit strategy, the position shows here.</Empty>;
  return (
    <div className={a.tableWrap} style={{ paddingTop: 0 }}>
      <table className={a.table}>
        <thead>
          <tr>
            <th>Invoice</th>
            <th>Seller</th>
            <th className={d.num}>Your principal</th>
            <th className={d.num}>APR</th>
            {!compact && <th className={d.num}>Fee</th>}
            <th>Due</th>
            <th>Status</th>
            {!compact && <th>Proof</th>}
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.invoice.id}>
              <td>
                <InvoiceName invoice={p.invoice} />
              </td>
              <td>
                <Party address={p.invoice.seller} agents={agents} />
              </td>
              <td className={`${d.num} ${a.mono}`}>{usd(p.principal)}</td>
              <td className={`${d.num} ${a.mono}`}>{p.aprBps !== undefined ? pct(p.aprBps / 100) : "—"}</td>
              {!compact && <td className={`${d.num} ${a.mono}`}>{usd(p.fee)}</td>}
              <td>
                <DueLabel invoice={p.invoice} nowMs={nowMs} />
              </td>
              <td>
                <StateChip state={p.invoice.state} />
              </td>
              {!compact && (
                <td>
                  <Proof url={p.invoice.proofUrl} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Lender console: capital, how much is lent to sellers, the return it earns, its liquidity across strategies and its positions. */
export function LenderPage({ view, ...p }: RoleViewProps & { view: string }) {
  const { me, agents, lenders, mine, wallet, nowMs, go } = p;
  const y = lenderOf(lenders, me.address);
  const positions = useMemo(() => lenderPositions(mine, me.address), [mine, me.address]);
  const open = positions.filter((x) => x.invoice.state === "Financed" || x.invoice.state === "Overdue").length;
  const late = positions.filter((x) => x.invoice.state === "Overdue" || x.invoice.state === "Defaulted").length;
  const idle = y?.idle ?? wallet.usdc;
  const earned = y ? addU(y.creditFees, y.baseFees) : "0";
  const kpis = <Kpis y={y} idle={idle} earned={earned} open={open} late={late} me={me} />;
  const returns = (
    <KV
      strong
      rows={[
        { label: "Credit fees", value: usd(y?.creditFees ?? "0"), hint: "interest from sellers, repaid first" },
        { label: "Swap fees", value: usd(y?.baseFees ?? "0"), hint: "from the base-yield strategy" },
        { label: "Total earned", value: usd(earned) },
        { label: "Return on capital", value: pct(me.lenderReturnPct) },
        { label: "Defaults on your positions", value: String(positions.filter((x) => x.invoice.state === "Defaulted").length) },
      ]}
    />
  );

  switch (view) {
    case "sellers":
      return (
        <Panel title="Sellers" description={CHANGE_HINT} flush>
          <SellerTable y={y} agents={agents} />
        </Panel>
      );
    case "liquidity":
      return (
        <>
          {kpis}
          <div className={d.split}>
            <Panel title="Strategies" description="Published on 1inch Aqua; one wallet backs both">
              <Allocation y={y} idle={idle} />
              <Strategies y={y} />
            </Panel>
            <WalletPanel {...p} />
          </div>
        </>
      );
    case "positions":
      return (
        <Panel title="Positions" description={`${positions.length} invoice${positions.length === 1 ? "" : "s"} you funded`} flush>
          <PositionTable positions={positions} agents={agents} nowMs={nowMs} />
        </Panel>
      );
    case "returns":
      return (
        <>
          {kpis}
          <div className={d.grid2}>
            <Panel title="Earnings" description="Paid on-chain by the repayment router">
              {returns}
            </Panel>
            <Panel title="Farming vs lending" description="Annualised; what lending adds on top of yield farming">
              <FarmingVsLending y={y} />
            </Panel>
          </div>
        </>
      );
    default:
      return (
        <>
          {kpis}
          <div className={d.grid2}>
            <AgentDetails {...p} lenders={lenders} />
            <WalletPanel {...p} />
          </div>
          <div className={d.split}>
            <Panel title="Liquidity" description="Where your capital is right now" more={{ label: "Strategies", onClick: () => go("liquidity") }}>
              <Allocation y={y} idle={idle} />
              <Strategies y={y} />
            </Panel>
            <div className={d.stack}>
              <Panel title="Farming vs lending" description="What lending adds on top of yield farming" more={{ label: "Return details", onClick: () => go("returns") }}>
                <FarmingVsLending y={y} />
              </Panel>
              <Connections {...p} />
            </div>
          </div>
          <Panel title="Recent positions" description="Latest three" flush className={d.section} more={{ label: `All ${positions.length} positions`, onClick: () => go("positions") }}>
            <PositionTable positions={positions.slice(0, 3)} agents={agents} nowMs={nowMs} compact />
          </Panel>
          <div className={d.grid2}>
            <RecentCalls {...p} more={{ label: "Open the activity log", onClick: () => go("activity") }} />
            <ToolUsage {...p} />
          </div>
        </>
      );
  }
}
