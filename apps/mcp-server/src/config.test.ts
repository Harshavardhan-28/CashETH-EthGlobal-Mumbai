import type { Env } from "@casheth/shared";
import { describe, expect, it } from "vitest";
import { agentKeyRoles } from "./config.js";

const env = (value?: string) => (value === undefined ? {} : { AGENT_KEYS_IN_PROCESS: value }) as unknown as Env;

describe("agentKeyRoles (AGENT_KEYS_IN_PROCESS)", () => {
  it("holds no agent key when unset or false", () => {
    expect(agentKeyRoles(env())).toEqual([]);
    expect(agentKeyRoles(env("false"))).toEqual([]);
  });

  it("holds the seller, buyer and worker keys for true", () => {
    expect(agentKeyRoles(env("true"))).toEqual(["seller", "buyer", "worker"]);
  });

  it("holds only the listed roles, so the buyer can stay non-custodial while the worker pays x402", () => {
    expect(agentKeyRoles(env("seller, worker"))).toEqual(["seller", "worker"]);
    expect(agentKeyRoles(env("WORKER"))).toEqual(["worker"]);
  });

  it("refuses an unknown role instead of silently holding fewer keys", () => {
    expect(() => agentKeyRoles(env("seller,lender"))).toThrow(/AGENT_KEYS_IN_PROCESS.*lender/);
  });
});
