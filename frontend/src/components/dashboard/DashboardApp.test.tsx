import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_AGENTS, SAMPLE_LENDERS, sampleEvents } from "@/lib/admin/sample";
import type { AdminData } from "@/lib/admin/useAdminData";
import { DashboardApp, SAVED_AGENT_KEY, agentFromHash, parseDashboardHash } from "./DashboardApp";

const live = (): AdminData => ({ status: "live", sample: false, events: sampleEvents(Date.now()), agents: SAMPLE_AGENTS, lenders: SAMPLE_LENDERS, statsReady: true, updatedAt: Date.now() });
const offline = (): AdminData => ({ ...live(), status: "offline", sample: true, updatedAt: undefined });
const addrOf = (label: string) => SAMPLE_AGENTS.find((a) => a.label === label)!.address.toLowerCase();

const loadWallet = vi.fn(async () => ({ accountId: "0.0.1234", hbar: 2_500_000_000, usdc: "5000000000", updatedAt: Date.now() }));
const loadReceivable = vi.fn(async () => {
  throw new Error("not served in tests");
});

function renderAt(hash: string, data: () => AdminData = live) {
  window.location.hash = hash;
  const fixed = data();
  return render(<DashboardApp useData={() => fixed} loadWallet={loadWallet} loadReceivable={loadReceivable} />);
}

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  loadWallet.mockClear();
});
afterEach(() => {
  window.location.hash = "";
});

describe("routing", () => {
  it("reads #agent=<id>&view=<section>", () => {
    expect(agentFromHash("#agent=0xAbC")).toBe("0xAbC");
    expect(agentFromHash("#agent=uaid%3Aaid%3Ax")).toBe("uaid:aid:x");
    expect(agentFromHash("#overview")).toBeUndefined();
    expect(parseDashboardHash("#agent=0xabc&view=invoices")).toEqual({ agent: "0xabc", view: "invoices" });
    expect(parseDashboardHash("#agent=0xabc").view).toBe("overview");
  });
});

describe("agent picker", () => {
  it("says the agents are loading while only the activity has arrived, not that none are registered", () => {
    renderAt("", () => ({ ...live(), agents: [], lenders: [], statsReady: false }));
    expect(screen.getByText("Loading agents…")).toBeInTheDocument();
    expect(screen.queryByText("No agents registered yet")).not.toBeInTheDocument();
  });

  it("lists registered agents with role tabs, without any sign-in, and opens one", async () => {
    renderAt("");
    expect(screen.getByRole("heading", { name: "Follow your agent" })).toBeInTheDocument();
    const tabs = within(screen.getByRole("tablist", { name: "Role" }));
    expect(tabs.getByRole("tab", { name: /Lenders\s*2/ })).toBeInTheDocument();
    await userEvent.click(tabs.getByRole("tab", { name: /Lenders/ }));
    const table = within(screen.getByRole("region", { name: "Registered agents" }));
    expect(table.getByRole("button", { name: "Open Lender A" })).toBeInTheDocument();
    expect(table.queryByRole("button", { name: "Open Seller" })).not.toBeInTheDocument();
    await userEvent.click(tabs.getByRole("tab", { name: /All agents/ }));
    await userEvent.click(table.getByRole("button", { name: "Open Seller" }));
    expect(window.location.hash).toBe(`#agent=${addrOf("Seller")}`);
    expect(localStorage.getItem(SAVED_AGENT_KEY)).toBe(addrOf("Seller"));
  });

  it("filters as you type, accepts a UAID and rejects unknown ones", async () => {
    renderAt("");
    const input = screen.getByRole("textbox", { name: "Agent address or UAID" });
    await userEvent.type(input, "0x0000000000000000000000000000000000000001");
    expect(screen.getByText("No agents match")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
    expect(screen.getByRole("alert")).toHaveTextContent("No agent with that address");
    await userEvent.clear(input);
    await userEvent.type(input, SAMPLE_AGENTS.find((a) => a.label === "Buyer")!.uaid);
    await userEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
    expect(window.location.hash).toBe(`#agent=${addrOf("Buyer")}`);
  });
});

describe("console shell", () => {
  it("has a side nav of the role's sections, breadcrumbs, and navigates between sections", async () => {
    renderAt(`#agent=${addrOf("Seller")}`);
    const nav = within(screen.getByRole("navigation", { name: "Agent console" }));
    for (const s of ["Overview", "Wallet & credit", "Worker agents", "Invoices", "Payback", "Activity log"]) expect(nav.getByRole("button", { name: new RegExp(s) })).toBeInTheDocument();
    expect(nav.getByRole("button", { name: /Overview/ })).toHaveAttribute("aria-current", "page");
    await userEvent.click(nav.getByRole("button", { name: /Invoices/ }));
    expect(window.location.hash).toBe(`#agent=${addrOf("Seller")}&view=invoices`);
    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumbs.getByText("Invoices")).toHaveAttribute("aria-current", "page");
    await userEvent.click(crumbs.getByRole("button", { name: "Agents" }));
    expect(window.location.hash).toBe("");
  });
});

describe("seller console", () => {
  it("overview: wallet, credit KPIs, details, workers, recent invoices, health and tool usage", async () => {
    renderAt(`#agent=${addrOf("Seller")}`);
    await waitFor(() => expect(screen.getByTestId("wallet-usdc")).toHaveTextContent("$5,000.00"));
    expect(loadWallet).toHaveBeenCalledWith(addrOf("Seller"));
    const kpis = screen.getByRole("region", { name: "Credit" });
    for (const label of ["Credit raised", "Credit available", "Spent by your agents", "Owed to lenders"]) expect(within(kpis).getByText(label)).toBeInTheDocument();
    expect(within(kpis).getByText("$3,600.00")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Agent details" })).getByText("0.0.1234")).toBeInTheDocument();
    const workers = screen.getByRole("region", { name: "Worker agents" });
    expect(within(workers).getByText(/1 blocked by guardrails/)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Recent invoices" })).getByText("PO-1003")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Service health" })).getByText("CashETH MCP server")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "MCP tools used" })).getByText("open_facility")).toBeInTheDocument();
  });

  it("invoices and payback sections", () => {
    renderAt(`#agent=${addrOf("Seller")}&view=invoices`);
    const invoices = screen.getByRole("region", { name: "Invoices" });
    expect(within(invoices).getAllByText("Repaid")).toHaveLength(2);
    expect(within(invoices).getAllByText(/^\d+ proof links?$/)).toHaveLength(3);
  });

  it("activity log expands a row into its raw record and filters blocked calls", async () => {
    renderAt(`#agent=${addrOf("Seller")}&view=activity`);
    const rows = screen.getAllByTestId("log-row");
    await userEvent.click(rows[0]);
    expect(rows[0]).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Hedera audit message")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Blocked" }));
    const blocked = screen.getAllByTestId("log-row");
    expect(blocked).toHaveLength(1);
    expect(within(blocked[0]).getByText("reserve_spend")).toBeInTheDocument();
  });
});

describe("buyer console", () => {
  it("overview shows what is due and when, without worker spending", () => {
    renderAt(`#agent=${addrOf("Buyer")}`);
    for (const label of ["Total due", "Next payment", "Paid so far", "Wallet covers dues"]) expect(within(screen.getByRole("region", { name: "Payables" })).getByText(label)).toBeInTheDocument();
    const due = screen.getByRole("region", { name: "Invoices due" });
    expect(within(due).getByText("PO-1003")).toBeInTheDocument();
    expect(within(due).getByText(/in 14 days/)).toBeInTheDocument();
    expect(screen.queryByText("commit_spend")).not.toBeInTheDocument();
  });

  it("payments section lists repayments with proof", () => {
    renderAt(`#agent=${addrOf("Buyer")}&view=payments`);
    expect(within(screen.getByRole("region", { name: "Payment history" })).getAllByText(/^\d+ proof links?$/)).toHaveLength(2);
  });
});

describe("lender console", () => {
  it("overview shows capital, return rate, liquidity strategies and positions", () => {
    renderAt(`#agent=${addrOf("Lender A")}`);
    const kpis = screen.getByRole("region", { name: "Capital" });
    for (const label of ["Total capital", "Lent to sellers", "Blended return", "Earned so far"]) expect(within(kpis).getByText(label)).toBeInTheDocument();
    expect(within(kpis).getByText("5.4%")).toBeInTheDocument();
    expect(within(kpis).getByText("Farming 4.2% · lending 10.1% APR")).toBeInTheDocument();
    const liquidity = screen.getByRole("region", { name: "Liquidity" });
    expect(within(liquidity).getByText("Credit strategy")).toBeInTheDocument();
    expect(within(liquidity).getByText("Base-yield strategy")).toBeInTheDocument();
    expect(within(liquidity).getByText("6–11% APR")).toBeInTheDocument();
    // Every position pays its seller's own rate (the sample seller: 10.1%), whichever lender funded it.
    expect(within(screen.getByRole("region", { name: "Recent positions" })).getAllByText("10.1%")).toHaveLength(3);
  });

  it("compares yield farming with lending and shows the extra lending earned", () => {
    renderAt(`#agent=${addrOf("Lender A")}`);
    const compare = within(screen.getByRole("region", { name: "Farming vs lending" }));
    expect(compare.getByText("4.2% APR")).toBeInTheDocument();
    expect(compare.getByText("10.1% APR")).toBeInTheDocument();
    expect(compare.getByText("Extra over farming")).toBeInTheDocument();
  });

  it("lists the sellers with their score, slab and rate, and which ones the lender backs", () => {
    renderAt(`#agent=${addrOf("Lender A")}&view=sellers`);
    const table = within(screen.getByRole("region", { name: "Sellers" }));
    expect(table.getByText("630 / 750")).toBeInTheDocument();
    expect(table.getByText("Medium risk")).toBeInTheDocument();
    expect(table.getByText("10.1%")).toBeInTheDocument();
    expect(table.getByText("Backed by you")).toBeInTheDocument();
    expect(screen.getByText(/call fund_agents/)).toBeInTheDocument();
  });
});

describe("credit score", () => {
  it("shows the engine score out of 750 everywhere, never out of 100", () => {
    const withScore = (): AdminData => ({ ...live(), agents: SAMPLE_AGENTS.map((a) => (a.label === "Seller" ? { ...a, score: 623 } : a)) });
    renderAt(`#agent=${addrOf("Seller")}`, withScore);
    const details = within(screen.getByRole("region", { name: "Agent details" }));
    expect(details.getByText("623 / 750 · Good")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d+ \/ 100\b/);
  });

  it("the agent list bar reads the real score", () => {
    renderAt("", () => ({ ...live(), agents: SAMPLE_AGENTS.map((a) => (a.label === "Seller" ? { ...a, score: 623 } : a)) }));
    expect(screen.getByLabelText("Credit score 623 of 750, Good")).toBeInTheDocument();
  });
});

describe("offline", () => {
  it("labels sample data and does not read a wallet", () => {
    renderAt(`#agent=${addrOf("Seller")}`, offline);
    expect(screen.getByText("Sample data · MCP server offline")).toBeInTheDocument();
    expect(screen.getByText("Sample data: no live wallet read")).toBeInTheDocument();
    expect(loadWallet).not.toHaveBeenCalled();
  });

  it("explains an unknown agent in the link", () => {
    renderAt("#agent=0x0000000000000000000000000000000000000009");
    expect(screen.getByRole("alert")).toHaveTextContent("No registered agent matches");
  });
});
