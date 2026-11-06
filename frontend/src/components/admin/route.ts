/** Admin console navigation state, kept in `location.hash` so a reload keeps the view. */
import type { Narrated } from "@/lib/admin/narrate";

export type View = "overview" | "agents" | "activity" | "runs";
export type Route = { view: View; agent?: string; run?: string };

const VIEWS: View[] = ["overview", "agents", "activity", "runs"];

export function parseHash(hash: string): Route {
  const [head, ...rest] = hash.replace(/^#\/?/, "").split("/");
  const view = (VIEWS as string[]).includes(head) ? (head as View) : "overview";
  const sub = rest.length ? decodeURIComponent(rest.join("/")) : undefined;
  if (view === "agents" && sub) return { view, agent: sub };
  if (view === "runs" && sub) return { view, run: sub };
  return { view };
}

export function toHash(route: Route): string {
  if (route.view === "agents" && route.agent) return `#agents/${encodeURIComponent(route.agent)}`;
  if (route.view === "runs" && route.run) return `#runs/${encodeURIComponent(route.run)}`;
  return `#${route.view}`;
}

/** Case-insensitive text search over who did it, what happened, and which invoice. */
export function matchesQuery(item: Narrated, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.actor.name, item.sentence, item.detail, item.id, item.ref, item.type].some((v) => v?.toLowerCase().includes(q));
}
