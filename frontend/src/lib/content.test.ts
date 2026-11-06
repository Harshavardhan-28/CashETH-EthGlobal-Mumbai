import { describe, expect, it } from "vitest";
import { DOC_NAV, ERROR_CODES, LIFECYCLE, MCP_TOOLS, REGISTRY_RULES, ROLE_COLOR } from "./content";

describe("docs content", () => {
  it("documents every error code a registry rule can raise", () => {
    const known = new Set(ERROR_CODES.map(([code]) => code));
    for (const [, code] of REGISTRY_RULES) expect(known, code).toContain(code);
  });

  it("has no duplicate error codes", () => {
    const codes = ERROR_CODES.map(([c]) => c);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("gives every MCP tool a role that has a colour", () => {
    for (const t of MCP_TOOLS) expect(ROLE_COLOR, t.name).toHaveProperty(t.role);
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
