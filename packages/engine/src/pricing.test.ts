import { describe, expect, it } from "vitest";
import { aprBpsFor, creditScore, slabOf } from "./pricing.js";

const DAY = 86_400n;

/** The same table `contracts/test/RiskPricing.t.sol` asserts, so the server and the opcode price identically. */
describe("risk pricing (parity with RiskPricing.sol)", () => {
  it("scores the seller's record and the tenor", () => {
    const score = (onTime: number, late: number, defaults: number, tenor: bigint) => creditScore({ onTime, late, defaults }, tenor);
    expect(score(0, 0, 0, 30n * DAY)).toBe(600);
    expect(score(10, 0, 0, 30n * DAY)).toBe(750);
    expect(score(14, 0, 0, 30n * DAY)).toBe(750);
    expect(score(3, 1, 0, 30n * DAY)).toBe(605);
    expect(score(0, 0, 1, 30n * DAY)).toBe(400);
    expect(score(0, 0, 0, 61n * DAY)).toBe(550);
    expect(score(0, 0, 0, 60n * DAY)).toBe(600);
    expect(score(0, 0, 4, 30n * DAY)).toBe(-200);
  });

  it("puts a score in its slab", () => {
    expect([750, 700, 699, 600, 599, 500, 499, -200].map(slabOf)).toEqual(["low", "low", "medium", "medium", "high", "high", "none", "none"]);
  });

  it("prices linearly inside each slab and continuously across them", () => {
    const table: [number, number][] = [
      [800, 600],
      [750, 600],
      [725, 700],
      [701, 796],
      [700, 800],
      [650, 950],
      [601, 1097],
      [600, 1100],
      [520, 1340],
      [500, 1400],
    ];
    for (const [score, apr] of table) expect(aprBpsFor(score), `score ${score}`).toBe(apr);
  });

  it("has no price below the financeable score", () => {
    expect(aprBpsFor(499)).toBeUndefined();
  });
});
