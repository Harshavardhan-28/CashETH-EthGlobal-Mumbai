import { describe, expect, it } from "vitest";
import {
  ACTIVE,
  EDGES,
  NODES,
  NODE_STEP,
  PACKET_LABELS,
  PATHS,
  STEP_COUNT,
  buildScene,
  nextStep,
  packetPose,
  prevStep,
} from "./stage";
import { LIFECYCLE } from "./content";

describe("step navigation", () => {
  it("has one step per lifecycle entry", () => {
    expect(STEP_COUNT).toBe(LIFECYCLE.length);
  });

  it("advances by one and wraps from the last step to the first", () => {
    expect(nextStep(1)).toBe(2);
    expect(nextStep(STEP_COUNT)).toBe(1);
  });

  it("goes back by one and wraps from the first step to the last", () => {
    expect(prevStep(5)).toBe(4);
    expect(prevStep(1)).toBe(STEP_COUNT);
  });
});

describe("scene data", () => {
  it("defines a path, an active set and a packet label for every step", () => {
    expect(PATHS).toHaveLength(STEP_COUNT);
    expect(ACTIVE).toHaveLength(STEP_COUNT);
    expect(PACKET_LABELS).toHaveLength(STEP_COUNT);
  });

  it("only references nodes that exist", () => {
    const known = new Set(Object.keys(NODES));
    for (const path of PATHS) for (const k of path) expect(known.has(k)).toBe(true);
    for (const set of ACTIVE) for (const k of set) expect(known.has(k)).toBe(true);
    for (const [a, b] of EDGES) {
      expect(known.has(a)).toBe(true);
      expect(known.has(b)).toBe(true);
    }
    for (const k of Object.keys(NODE_STEP)) expect(known.has(k)).toBe(true);
  });

  it("maps every node to a valid step", () => {
    for (const s of Object.values(NODE_STEP)) {
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(STEP_COUNT);
    }
  });
});

describe("packetPose", () => {
  const [sx, sy] = NODES.seller;
  const [ox, oy] = NODES.orch;

  it("starts invisible at the origin node of a multi-node path", () => {
    const p = packetPose(1, 0, false);
    expect(p.x).toBeCloseTo(sx);
    expect(p.y).toBeCloseTo(sy);
    expect(p.opacity).toBe(0);
  });

  it("is halfway between nodes halfway through the travel time, lifted off the board", () => {
    const p = packetPose(1, 1050, false);
    expect(p.x).toBeCloseTo((sx + ox) / 2);
    expect(p.y).toBeCloseTo((sy + oy) / 2);
    expect(p.opacity).toBe(1);
    expect(p.z).toBeCloseTo(46 + 14);
  });

  it("rests at the destination and is hidden while it waits to loop", () => {
    const p = packetPose(1, 2100 + 500, false);
    expect(p.x).toBeCloseTo(ox);
    expect(p.y).toBeCloseTo(oy);
    expect(p.opacity).toBe(0);
  });

  it("loops after the hold", () => {
    const a = packetPose(1, 1050, false);
    const b = packetPose(1, 1050 + 2100 + 1100, false);
    expect(b.x).toBeCloseTo(a.x);
    expect(b.opacity).toBe(a.opacity);
  });

  it("takes proportionally longer on a path with more hops", () => {
    // step 7: facility -> workers -> merchant, 2 segments of 2100ms
    const [wx, wy] = NODES.workers;
    const p = packetPose(7, 2100, false);
    expect(p.x).toBeCloseTo(wx);
    expect(p.y).toBeCloseTo(wy);
  });

  it("hovers beside the node on single-node steps and stays visible", () => {
    const p = packetPose(3, 0, false);
    expect(p.x).toBeCloseTo(ox + 6);
    expect(p.y).toBeCloseTo(oy + 62);
    expect(p.opacity).toBe(1);
  });

  it("parks fully visible at the destination under reduced motion", () => {
    const p = packetPose(1, 0, true);
    expect(p.x).toBeCloseTo(ox);
    expect(p.y).toBeCloseTo(oy);
    expect(p.opacity).toBe(1);
  });
});

describe("buildScene", () => {
  const litWires = (step: number) =>
    buildScene(step, 0).faces.filter((f) => f.kind === "wire" && f.bg.includes("var(--accent) 80%"));

  it("lights only the wires that carry the current step", () => {
    expect(litWires(1)).toHaveLength(1);
    expect(litWires(3)).toHaveLength(0);
    expect(litWires(8)).toHaveLength(3);
  });

  it("builds the same number of faces regardless of step", () => {
    const n = buildScene(1, 0).faces.length;
    for (let s = 2; s <= STEP_COUNT; s++) expect(buildScene(s, 0).faces.length).toBe(n);
  });

  it("makes every contract module and agent clickable via its node", () => {
    const nodes = new Set(buildScene(1, 0).faces.map((f) => f.node).filter(Boolean));
    for (const k of ["registry", "facility", "router", "aqua", "seller", "buyer", "orch", "lenders", "workers", "merchant"]) {
      expect(nodes.has(k as never)).toBe(true);
    }
  });

  it("highlights the agents in play and dims the rest", () => {
    const { figures } = buildScene(1, 0);
    expect(figures.seller.opacity).toBe(1);
    expect(figures.orch.opacity).toBe(1);
    expect(figures.buyer.opacity).toBe(0.5);
    expect(figures.buyer.filter).toBe("grayscale(0.85)");
    expect(figures.seller.filter).toBe("none");
  });

  it("raises an active module and colours its top face", () => {
    const top = (step: number) => {
      const faces = buildScene(step, 0).faces.filter((f) => f.node === "registry");
      return faces[faces.length - 1];
    };
    expect(top(4).bg).toContain("var(--accent) 38%");
    expect(top(1).bg).toBe("var(--blk-top)");
    expect(top(4).transform).not.toBe(top(1).transform);
  });

  it("counter-rotates figures and badges so they always face the viewer", () => {
    const scene = buildScene(1, -40);
    expect(scene.figures.seller.transform).toContain("rotateZ(40deg)");
    expect(scene.badges.every((b) => b.transform.includes("rotateZ(40deg)"))).toBe(true);
  });

  it("badges the four on-chain modules", () => {
    const badges = buildScene(1, 0).badges;
    expect(badges.map((b) => b.text)).toEqual(["ℏ HTS", "$ USDC", "ℏ HCS", "1inch"]);
  });
});
