import type { AgentStats, AuditEvent, LenderYield } from "@/lib/admin/api";
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
};
