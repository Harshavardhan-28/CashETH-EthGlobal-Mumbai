// @vitest-environment node
import { describe, expect, it } from "vitest";
import { POST } from "./route";

const post = (body: string) =>
  POST(
    new Request("http://localhost/api/admin/login", { method: "POST", body }),
  );

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
