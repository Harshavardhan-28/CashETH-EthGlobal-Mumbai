import type { ReactNode } from "react";
import type { AgentStats, AuditEvent, LenderYield } from "@/lib/admin/api";
import type { Narrated } from "@/lib/admin/narrate";
import type { ConnStatus } from "@/lib/admin/useAdminData";
import type { Invoice } from "@/lib/dashboard/derive";
import type { Wallet } from "@/lib/dashboard/live";

export type RoleViewProps = {
  me: AgentStats;
  agents: AgentStats[];
  lenders: LenderYield[];
  /** Every audit event (workers' spending is matched against the seller's invoices). */
  events: AuditEvent[];
  /** Invoices where this agent is the seller, the buyer or a funding lender, newest activity first. */
  mine: Invoice[];
  wallet: Wallet;
  nowMs: number;
  /** MCP calls that concern this agent, newest first, and the raw records behind them. */
  log: Narrated[];
  raw: ReadonlyMap<number, AuditEvent>;
  status: ConnStatus;
  sample: boolean;
  /** Opens another section of this agent's console. */
  go(view: string): void;
};

/** One page of an agent's console: a nav entry with its page header. */
export type SectionDef = { id: string; label: string; icon: () => ReactNode; title: string; description: string };
