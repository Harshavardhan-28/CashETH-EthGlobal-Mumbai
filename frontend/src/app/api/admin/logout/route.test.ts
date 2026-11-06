// @vitest-environment node
import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("POST /api/admin/logout", () => {
  it("clears the session cookie", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("casheth_admin=;");
    expect(cookie).toContain("Max-Age=0");
  });
});
