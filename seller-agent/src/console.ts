/** Live console output: one line per decision as the graph runs, and the HashScan table at the end. */
import type { AuditEntry } from "./state.js";

type SummarisedMessage = { type?: string; content?: unknown; tool_calls?: { name: string; args: unknown }[] };
type Update = { steps?: number; messages?: SummarisedMessage[]; approved?: string[]; audit?: AuditEntry[] };

const auditLine = (node: string, a: AuditEntry): string =>
  a.outcome === "refused" ? `[${node}] refused ${a.tool}: ${a.code}` : [`[${node}] ${a.tool} ${a.outcome}${a.code ? ` ${a.code}` : ""}`, ...a.links].join(" ");

/** What a node's update means, as console lines. */
export function formatUpdate(node: string, raw: Record<string, unknown>): string[] {
  const update = raw as Update;
  if (node === "plan") {
    const ai = update.messages?.find((m) => m.type === "ai");
    if (!ai) return [];
    const calls = ai.tool_calls ?? [];
    if (calls.length === 0) return [`[plan #${update.steps}] says: ${String(ai.content ?? "").trim()}`];
    return calls.map((c) => `[plan #${update.steps}] -> ${c.name} ${JSON.stringify(c.args)}`);
  }
  if (node === "guard") {
    const refused = (update.audit ?? []).map((a) => auditLine(node, a));
    return [...refused, ...(update.approved?.length ? [`[guard] approved ${update.approved.join(", ")}`] : [])];
  }
  if (node === "tools") return (update.audit ?? []).map((a) => auditLine(node, a));
  return [];
}

/** A markdown table of every HashScan link the run produced, each once. */
export function linksTable(audit: AuditEntry[]): string[] {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const entry of audit) {
    for (const link of entry.links) {
      if (seen.has(link)) continue;
      seen.add(link);
      rows.push(`| ${entry.step} | ${entry.tool} | ${link} |`);
    }
  }
  return ["| step | tool | HashScan |", "|---|---|---|", ...rows];
}
