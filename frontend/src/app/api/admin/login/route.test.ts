// @vitest-environment node
import { describe, expect, it } from "vitest";
import { POST } from "./route";

const post = (body: string, url = "http://localhost/api/admin/login", headers?: HeadersInit) =>
  POST(new Request(url, { method: "POST", body, headers }));

const good = JSON.stringify({ password: "admin@01" });

describe("POST /api/admin/login", () => {
  it("sets an httpOnly session cookie on the right password", async () => {
    const res = await post(JSON.stringify({ password: "admin@01" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("casheth_admin=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Max-Age=43200");
    expect(cookie).toMatch(/SameSite=lax/i);
  });

  it("omits Secure on a plain http request", async () => {
    const res = await post(good);
    expect(res.headers.get("set-cookie")).not.toMatch(/secure/i);
  });

  it("sets Secure for an https request URL", async () => {
    const res = await post(good, "https://example.com/api/admin/login");
    expect(res.headers.get("set-cookie")).toMatch(/; Secure/);
  });

  it("sets Secure behind a proxy that forwards https", async () => {
    for (const proto of ["https", "HTTPS", " https , http"]) {
      const res = await post(good, undefined, { "x-forwarded-proto": proto });
      expect(res.headers.get("set-cookie")).toMatch(/; Secure/);
    }
    const res = await post(good, undefined, { "x-forwarded-proto": "http,https" });
    expect(res.headers.get("set-cookie")).not.toMatch(/secure/i);
  });

  it("rejects a wrong password without a cookie", async () => {
    const res = await post(JSON.stringify({ password: "nope" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "Wrong password" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a missing or non-string password", async () => {
    expect((await post(JSON.stringify({}))).status).toBe(401);
    expect((await post(JSON.stringify({ password: 1 }))).status).toBe(401);
  });

  it("answers 400 to a body that is not JSON", async () => {
    const res = await post("not json");
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
