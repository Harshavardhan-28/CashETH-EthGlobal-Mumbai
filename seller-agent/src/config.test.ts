import { describe, expect, it } from "vitest";
import { configFrom } from "./config.js";

describe("configFrom", () => {
  it("defaults to the local Ollama, qwen3:8b, the live paid API's price feed, 30 steps and a 1 USDC cap", () => {
    expect(configFrom({}, [])).toEqual({
      ollamaBaseUrl: "http://localhost:11434",
      model: "qwen3:8b",
      numCtx: 16384,
      paidApiUrl: "https://casheth-paid-apis-177290233934.asia-southeast1.run.app/price-feed?symbols=HBAR",
      maxSteps: 30,
      spendCap: 1_000_000n,
      invoiceUsdc: "2.00",
      startServers: false,
    });
  });

  it("reads the environment, and command-line flags win over it", () => {
    const env = { OLLAMA_BASE_URL: "http://gpu:11434", CASHETH_LLM_MODEL: "qwen2.5:7b", SELLER_AGENT_MAX_STEPS: "12", SELLER_AGENT_SPEND_CAP: "600000", SELLER_AGENT_NUM_CTX: "32768" };
    const config = configFrom(env, ["--model", "llama3.1:8b", "--start-servers", "--paid-url", "http://localhost:8080/price-feed?symbols=HBAR"]);
    expect(config).toMatchObject({
      ollamaBaseUrl: "http://gpu:11434",
      model: "llama3.1:8b",
      maxSteps: 12,
      spendCap: 600_000n,
      numCtx: 32768,
      startServers: true,
      paidApiUrl: "http://localhost:8080/price-feed?symbols=HBAR",
    });
  });

  it("accepts the -- separator pnpm passes before the flags", () => {
    expect(configFrom({}, ["--", "--start-servers"]).startServers).toBe(true);
  });

  it("refuses a max step count that is not a positive integer", () => {
    expect(() => configFrom({ SELLER_AGENT_MAX_STEPS: "0" }, [])).toThrow(/max steps/i);
    expect(() => configFrom({}, ["--max-steps", "ten"])).toThrow(/max steps/i);
  });
});
