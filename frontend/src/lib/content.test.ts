import { describe, expect, it } from "vitest";
import { DOC_NAV, ERROR_CODES, LIFECYCLE, MCP_ERROR_CODES, MCP_TOOLS, READ_API, REGISTRY_RULES, ROLE_COLOR } from "./content";

describe("docs content", () => {
  it("documents every error code a registry rule can raise", () => {
    const known = new Set(ERROR_CODES.map(([code]) => code));
    for (const [, code] of REGISTRY_RULES) expect(known, code).toContain(code);
  });

  it("has no duplicate error codes", () => {
    const codes = ERROR_CODES.map(([c]) => c);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("gives every MCP tool roles that have a colour", () => {
    for (const t of MCP_TOOLS) {
      expect(t.roles.length, t.name).toBeGreaterThan(0);
      for (const role of t.roles) expect(ROLE_COLOR, t.name).toHaveProperty(role);
    }
  });

  it("documents all 21 MCP server tools in tools.ts order", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      "register_agent", "upload_invoice_document", "get_invoice_document", "upload_receivable", "confirm_receivable",
      "get_receivable_status", "get_quotes", "open_facility", "set_budgets", "reserve_spend", "pay_x402", "commit_spend",
      "release_spend", "repay_receivable", "explain_decision", "list_agents", "get_agent_stats", "whoami", "fund_agents",
      "get_lender_yield", "close_strategy",
    ]);
  });

  it("matches the server's roles and scopes", () => {
    const tool = (name: string) => MCP_TOOLS.find((t) => t.name === name)!;
    expect(tool("reserve_spend")).toMatchObject({ roles: ["seller", "worker"], scope: "spend:reserve" });
    expect(tool("release_spend")).toMatchObject({ roles: ["seller", "worker"], scope: "spend:reserve" });
    expect(tool("fund_agents")).toMatchObject({ roles: ["lender"], scope: "lend:write" });
    expect(tool("list_agents")).toMatchObject({ roles: ["any"], scope: "stats:read" });
    expect(tool("register_agent").scope).toBe("agent:admin");
    expect(tool("whoami")).toMatchObject({ roles: ["any"], scope: "stats:read", mutating: false });
  });

  it("lists the read API endpoints the dashboards use", () => {
    const paths = READ_API.map((r) => r.path);
    for (const p of ["/health", "/events", "/agents", "/lenders", "/receivables/:id"]) expect(paths).toContain(p);
  });

  it("has unique MCP-side error codes", () => {
    const codes = MCP_ERROR_CODES.map(([c]) => c);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain("COSIGNER_REFUSED");
  });

  it("adds the connect and read API sections to the sidebar", () => {
    expect(DOC_NAV.start.map(([id]) => id)).toContain("connect");
    expect(DOC_NAV.ref.map(([id]) => id)).toContain("read-api");
  });

  it("has unique sidebar section ids", () => {
    const ids = Object.values(DOC_NAV).flatMap((g) => g.map(([id]) => id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("lifecycle", () => {
  it("has eight numbered steps in order", () => {
    expect(LIFECYCLE.map((s) => s.n)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"]);
  });
});
