import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS_FIXTURE, RECEIVABLE_FIXTURE } from "@/lib/fixtures";
import { LiveConsole } from "./LiveConsole";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("LiveConsole", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders audit events and receivable state fetched from the read API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        new URL(url).pathname === "/events" ? json(EVENTS_FIXTURE) : json(RECEIVABLE_FIXTURE),
      ),
    );
    render(<LiveConsole />);

    expect(await screen.findByText("SpendRejected")).toBeInTheDocument();
    expect(screen.getByText("ReceivableUploaded")).toBeInTheDocument();
    expect(screen.getByText(/AGENT_BUDGET_EXCEEDED/)).toBeInTheDocument();
    expect(screen.getByText("Financed")).toBeInTheDocument();
    expect(screen.getByText("$6,000.00")).toBeInTheDocument();
    expect(screen.getByText("$6,036.99")).toBeInTheDocument();
    expect(screen.getByText(/receivable 0x7f3a…c21e/)).toBeInTheDocument();
  });

  it("keeps the scripted demo when the API is unreachable", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connection refused");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LiveConsole />);

    expect(await screen.findByText("DUPLICATE_RECEIVABLE")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });
});
