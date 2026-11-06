import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Hero } from "./Hero";

describe("Hero", () => {
  it("leads with the promise", () => {
    render(<Hero />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Invoices your agents can spend.");
    expect(screen.getByText(/An MCP that turns a buyer-signed invoice into USDC working capital/)).toBeInTheDocument();
    expect(screen.getByText("CASHETH MCP · LIVE ON HEDERA")).toBeInTheDocument();
  });

  it("navigates to each landing section and the docs", () => {
    render(<Hero />);
    const nav = within(screen.getByRole("navigation", { name: "Primary" }));
    const href = (name: string) => nav.getByRole("link", { name }).getAttribute("href");
    expect(href("How it works")).toBe("#flow");
    expect(href("Credit")).toBe("#ceiling");
    expect(href("Repayment")).toBe("#waterfall");
    expect(href("Docs")).toBe("/docs");
    expect(href("Dashboard")).toBe("/dashboard");
  });

  it("offers a way to get started and to try the demo", () => {
    render(<Hero />);
    const start = screen.getAllByRole("link", { name: /Get started/ });
    expect(start.length).toBeGreaterThanOrEqual(1);
    start.forEach((a) => expect(a).toHaveAttribute("href", "/docs"));
    expect(screen.getByRole("link", { name: /npm run demo/ })).toHaveAttribute("href", "/docs#quickstart");
  });

  it("lets the visitor switch theme", () => {
    render(<Hero />);
    expect(screen.getByRole("button", { name: /toggle color theme/i })).toBeInTheDocument();
  });

  it("shows the lifecycle board", () => {
    render(<Hero />);
    expect(screen.getByTestId("stage")).toBeInTheDocument();
  });
});
