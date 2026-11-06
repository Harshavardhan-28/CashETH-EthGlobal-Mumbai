import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DocsShell } from "./DocsShell";

const renderShell = () =>
  render(
    <DocsShell>
      <section id="overview" data-doc-sec="overview" />
    </DocsShell>,
  );

const filter = () => screen.getByRole("textbox", { name: /filter sections/i });

describe("DocsShell sidebar", () => {
  it("lists every section, grouped", () => {
    renderShell();
    expect(screen.getAllByRole("link")).toHaveLength(12);
    expect(screen.getByRole("navigation", { name: "REFERENCE" })).toBeInTheDocument();
  });

  it("matches a query against labels that contain capitals", async () => {
    renderShell();
    await userEvent.type(filter(), "kya");
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(["Agents & KYA"]);
  });

  it("ignores the case of the query", async () => {
    renderShell();
    await userEvent.type(filter(), "X402");
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(["x402 spending"]);
  });

  it("hides a group when nothing in it matches", async () => {
    renderShell();
    await userEvent.type(filter(), "x402");
    expect(screen.queryByRole("navigation", { name: "REFERENCE" })).not.toBeInTheDocument();
  });

  it("says so when no section matches", async () => {
    renderShell();
    await userEvent.type(filter(), "zzz");
    expect(screen.getByText("No sections match.")).toBeInTheDocument();
  });

  it("marks the overview link as current on first render", () => {
    renderShell();
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "true");
  });

  it("marks a link as current after it is clicked", async () => {
    renderShell();
    await userEvent.click(screen.getByRole("link", { name: "Quickstart" }));
    expect(screen.getByRole("link", { name: "Quickstart" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });
});
