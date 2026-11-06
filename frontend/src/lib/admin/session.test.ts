// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { checkPassword, isValidSession, sessionToken } from "./session";

const original = process.env.ADMIN_PASSWORD;

afterEach(() => {
  if (original === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = original;
});

describe("checkPassword", () => {
  it("accepts the default demo password", () => {
    delete process.env.ADMIN_PASSWORD;
    expect(checkPassword("admin@01")).toBe(true);
  });

  it("rejects a wrong or empty password", () => {
    delete process.env.ADMIN_PASSWORD;
    expect(checkPassword("admin@02")).toBe(false);
    expect(checkPassword("")).toBe(false);
  });

  it("uses ADMIN_PASSWORD when set", () => {
    process.env.ADMIN_PASSWORD = "x";
    expect(checkPassword("x")).toBe(true);
    expect(checkPassword("admin@01")).toBe(false);
  });
});

describe("isValidSession", () => {
  it("accepts the issued token", () => {
    expect(isValidSession(sessionToken())).toBe(true);
  });

  it("rejects a missing, tampered or wrong-length value", () => {
    expect(isValidSession(undefined)).toBe(false);
    expect(isValidSession("")).toBe(false);
    expect(isValidSession(sessionToken().slice(1) + "0")).toBe(false);
    expect(isValidSession(sessionToken().slice(1))).toBe(false);
  });
});
