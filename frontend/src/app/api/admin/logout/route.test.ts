// @vitest-environment node
import { describe, expect, it } from "vitest";
import { POST } from "./route";

const req = (headers?: HeadersInit) =>
  new Request("http://localhost/api/admin/logout", { method: "POST", headers });

describe("POST /api/admin/logout", () => {
  it("clears the session cookie", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("casheth_admin=;");
    expect(cookie).toContain("Max-Age=0");
  });

  it("matches the login cookie's Secure flag to the request protocol", async () => {
    expect((await POST(req())).headers.get("set-cookie")).not.toMatch(/secure/i);
    const https = await POST(req({ "x-forwarded-proto": "https" }));
    expect(https.headers.get("set-cookie")).toMatch(/; Secure/);
  });
});
