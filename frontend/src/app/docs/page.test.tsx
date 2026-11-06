import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DOC_NAV, MCP_TOOLS } from "@/lib/content";
import DocsPage from "./page";

vi.mock("next/navigation", () => ({ usePathname: () => "/docs", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

describe("docs page", () => {
  it("renders a section for every sidebar entry and every MCP tool", () => {
    const { container } = render(<DocsPage />);
    for (const [id] of Object.values(DOC_NAV).flat()) expect(container.querySelector(`section#${id}`), id).not.toBeNull();
    for (const t of MCP_TOOLS) expect(container.textContent).toContain(t.name);
  });
});
