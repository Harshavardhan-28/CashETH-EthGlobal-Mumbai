import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_AGENTS, SAMPLE_LENDERS, sampleEvents } from "@/lib/admin/sample";
import type { AdminData } from "@/lib/admin/useAdminData";
import { DashboardApp, SAVED_AGENT_KEY, agentFromHash } from "./DashboardApp";

const live = (): AdminData => ({ status: "live", sample: false, events: sampleEvents(Date.now()), agents: SAMPLE_AGENTS, lenders: SAMPLE_LENDERS, updatedAt: Date.now() });
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

describe("agentFromHash", () => {
  it("reads #agent=<id>", () => {
    expect(agentFromHash("#agent=0xAbC")).toBe("0xAbC");
    expect(agentFromHash("#agent=uaid%3Aaid%3Ax")).toBe("uaid:aid:x");
    expect(agentFromHash("#overview")).toBeUndefined();
  });
});

describe("agent picker", () => {
  it("lists registered agents by role without any sign-in and opens one", async () => {
    renderAt("");
    expect(screen.getByRole("heading", { name: "Follow your agent" })).toBeInTheDocument();
    for (const role of ["Sellers", "Buyers", "Lenders", "Workers"]) expect(screen.getByRole("region", { name: role })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Seller" }));
    expect(window.location.hash).toBe(`#agent=${addrOf("Seller")}`);
    expect(localStorage.getItem(SAVED_AGENT_KEY)).toBe(addrOf("Seller"));
  });

  it("accepts a pasted address or UAID and rejects unknown ones", async () => {
    renderAt("");
    const input = screen.getByRole("textbox", { name: "Agent address or UAID" });
    await userEvent.type(input, "0x0000000000000000000000000000000000000001");
    await userEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
    expect(screen.getByRole("alert")).toHaveTextContent("No agent with that address");
    await userEvent.clear(input);
    await userEvent.type(input, SAMPLE_AGENTS.find((a) => a.label === "Buyer")!.uaid);
    await userEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
    expect(window.location.hash).toBe(`#agent=${addrOf("Buyer")}`);
  });
});

describe("seller dashboard", () => {
  it("shows the wallet, credit, worker agents, invoices, payback and the MCP log", async () => {
    renderAt(`#agent=${addrOf("Seller")}`);
    await waitFor(() => expect(screen.getByTestId("wallet-usdc")).toHaveTextContent("$5,000.00"));
    expect(loadWallet).toHaveBeenCalledWith(addrOf("Seller"));
    expect(screen.getByText("0.0.1234 on HashScan ↗")).toBeInTheDocument();
    const kpis = screen.getByRole("region", { name: "Credit" });
    for (const label of ["Credit raised", "Credit available", "Spent by your agents", "Owed to lenders"]) expect(within(kpis).getByText(label)).toBeInTheDocument();
    expect(within(kpis).getByText("$3,600.00")).toBeInTheDocument();
    const workers = screen.getByRole("heading", { name: "Your worker agents" }).closest("section")!;
    expect(within(workers).getByText("Worker 1")).toBeInTheDocument();
    expect(within(workers).getByText(/1 blocked by guardrails/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Payback" })).toBeInTheDocument();
    const invoices = screen.getByRole("heading", { name: "Your invoices" }).closest("section")!;
    expect(within(invoices).getByText("PO-1003")).toBeInTheDocument();
    expect(within(invoices).getAllByText("Repaid")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "MCP activity log" })).toBeInTheDocument();
    expect(screen.getAllByText("open_facility").length).toBeGreaterThan(0);
    expect(screen.getAllByText("commit_spend").length).toBeGreaterThan(0);
  });

  it("expands a log row into its raw record and filters blocked calls", async () => {
    renderAt(`#agent=${addrOf("Seller")}`);
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

describe("buyer dashboard", () => {
  it("shows what is due, when, and the payment history", () => {
    renderAt(`#agent=${addrOf("Buyer")}`);
    for (const label of ["Total due", "Next payment", "Paid so far", "Wallet covers dues"]) expect(screen.getByText(label)).toBeInTheDocument();
    const due = screen.getByRole("heading", { name: "Invoices due" }).closest("section")!;
    expect(within(due).getByText("PO-1003")).toBeInTheDocument();
    expect(within(due).getByText(/in 14 days/)).toBeInTheDocument();
    const history = screen.getByRole("heading", { name: "Payment history" }).closest("section")!;
    expect(within(history).getAllByText("HashScan ↗")).toHaveLength(2);
    expect(screen.queryByText("commit_spend")).not.toBeInTheDocument();
  });
});

describe("lender dashboard", () => {
  it("shows capital, lent, return rate, liquidity strategies and positions", () => {
    renderAt(`#agent=${addrOf("Lender A")}`);
    const kpis = screen.getByRole("region", { name: "Capital" });
    for (const label of ["Total capital", "Lent to sellers", "Blended return", "Earned so far"]) expect(within(kpis).getByText(label)).toBeInTheDocument();
    expect(within(kpis).getByText("9.4%")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Liquidity" })).toBeInTheDocument();
    expect(screen.getByText("Credit strategy")).toBeInTheDocument();
    expect(screen.getByText("Base-yield strategy")).toBeInTheDocument();
    const positions = screen.getByRole("heading", { name: "Positions" }).closest("section")!;
    expect(within(positions).getAllByText("7.0%")).toHaveLength(3);
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
