import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_AGENTS, SAMPLE_LENDERS, sampleEvents } from "@/lib/admin/sample";
import type { AdminData } from "@/lib/admin/useAdminData";
import { AdminApp } from "./AdminApp";
import { narrateAll } from "@/lib/admin/narrate";
import { Overview } from "./Overview";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));

const live = (): AdminData => ({ status: "live", sample: false, events: sampleEvents(Date.now()), agents: SAMPLE_AGENTS, lenders: SAMPLE_LENDERS, updatedAt: Date.now() });
const offlineSample = (): AdminData => ({ ...live(), status: "offline", sample: true, updatedAt: undefined });
const empty = (): AdminData => ({ status: "live", sample: false, events: [], agents: [], lenders: [], updatedAt: Date.now() });

function renderAt(hash: string, data: () => AdminData = live) {
  window.location.hash = hash;
  const fixed = data();
  return render(<AdminApp useData={() => fixed} />);
}

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => {
  window.location.hash = "";
});

describe("Overview", () => {
  const now = Date.now();
  const all = narrateAll(sampleEvents(now), SAMPLE_AGENTS, "0.0.1");
  const base = { agents: SAMPLE_AGENTS, lenders: SAMPLE_LENDERS, range: "all" as const, onRange: () => {}, query: "", nowMs: now, go: () => {} };

  it("shows the four headline numbers, the live run and plain-English activity with proof links", () => {
    render(<Overview {...base} all={all} items={all} />);
    for (const label of ["Agents connected", "Invoices financed", "Agent spending (x402)", "On-chain records"]) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText("$3,600.00")).toBeInTheDocument(); // 1,200 + 1,600 + 800 financed
    expect(screen.getByText("Live run · Invoice PO-1003")).toBeInTheDocument();
    expect(screen.getAllByText(/^paid \$/).length).toBeGreaterThan(0);
    const proof = screen.getAllByRole("link", { name: "View proof ↗" })[0];
    expect(proof).toHaveAttribute("target", "_blank");
    expect(proof).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows friendly empty states with no data", () => {
    render(<Overview {...base} agents={[]} lenders={[]} all={[]} items={[]} />);
    expect(screen.getByText(/No activity yet/)).toBeInTheDocument();
    expect(screen.getByText("No invoice in flight yet")).toBeInTheDocument();
    expect(screen.getByText("No agents registered yet")).toBeInTheDocument();
    expect(screen.getByText("No records yet")).toBeInTheDocument();
  });
});

describe("AdminApp shell", () => {
  it("labels sample data and the offline status", () => {
    renderAt("", offlineSample);
    expect(screen.getByText("Sample data · MCP server offline")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAccessibleName("MCP offline");
  });

  it("shows the live status and no sample banner when connected", () => {
    renderAt("");
    expect(screen.getByRole("status")).toHaveAccessibleName("Live · MCP connected");
    expect(screen.queryByText("Sample data · MCP server offline")).not.toBeInTheDocument();
  });

  it("filters activity rows with the search box", async () => {
    renderAt("#activity");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search" }), "Worker 2");
    const rows = screen.getAllByTestId("feed-row");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.textContent).toContain("Worker 2");
  });

  it("navigates with the side nav through the URL hash", async () => {
    renderAt("");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Admin" })).getByRole("button", { name: /Runs/ }));
    expect(window.location.hash).toBe("#runs");
    expect(await screen.findByRole("heading", { level: 1, name: "Runs" })).toBeInTheDocument();
  });

  it("marks the chosen time range as pressed", () => {
    renderAt("");
    fireEvent.click(screen.getByRole("button", { name: "1h" }));
    expect(screen.getByRole("button", { name: "1h" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("Agents view", () => {
  it("groups agents under role sections and opens one agent's own activity", async () => {
    renderAt("#agents");
    expect(screen.getByRole("heading", { name: /Workers/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Lenders/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Worker 1" }));
    expect(await screen.findByText("On-time repayment")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /All agents/ })).toBeInTheDocument();
    const rows = screen.getAllByTestId("feed-row");
    for (const row of rows) expect(row.textContent).toContain("Worker 1");
  });

  it("says when an agent does not exist", () => {
    renderAt("#agents/0xnope");
    expect(screen.getByRole("heading", { level: 1, name: "Agent not found" })).toBeInTheDocument();
  });

  it("has an empty state", () => {
    renderAt("#agents", empty);
    expect(screen.getByText("No agents registered yet")).toBeInTheDocument();
  });
});

describe("Activity view", () => {
  it("shows only blocked actions under the Blocked filter", () => {
    renderAt("#activity");
    const before = screen.getAllByTestId("feed-row").length;
    fireEvent.click(screen.getByRole("button", { name: "Blocked" }));
    const rows = screen.getAllByTestId("feed-row");
    expect(rows.length).toBeLessThan(before);
    for (const row of rows) expect(row).toHaveAttribute("data-tone", "blocked");
    expect(screen.getByText(`${rows.length} action${rows.length === 1 ? "" : "s"}`)).toBeInTheDocument();
  });
});

describe("Runs view", () => {
  it("lists runs newest first and opens a repaid run with every step done", async () => {
    renderAt("#runs");
    const titles = screen.getAllByText(/^Invoice PO-/).map((el) => el.textContent);
    expect(titles).toEqual(["Invoice PO-1003", "Invoice PO-1002", "Invoice PO-1001"]);
    fireEvent.click(screen.getByText("Invoice PO-1002"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Invoice PO-1002"));
    const steps = within(screen.getByRole("list", { name: /progress/ })).getAllByRole("listitem");
    expect(steps).toHaveLength(5);
    for (const step of steps) expect(step).toHaveAttribute("data-done", "true");
    expect(within(screen.getByRole("heading", { level: 1 })).getByText("Repaid")).toBeInTheDocument();
  });

  it("says when a run does not exist", () => {
    renderAt("#runs/nope");
    expect(screen.getByRole("heading", { level: 1, name: "Run not found" })).toBeInTheDocument();
  });

  it("has an empty state", () => {
    renderAt("#runs", empty);
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
  });
});
