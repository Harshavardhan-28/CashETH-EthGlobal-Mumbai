/**
 * Pure model of the hero's isometric lifecycle stage. `buildScene` turns the current
 * step and camera rotation into styled faces; the component only renders them.
 */

export const STEP_COUNT = 8;

export type NodeKey =
  | "seller"
  | "buyer"
  | "orch"
  | "merchant"
  | "workers"
  | "lenders"
  | "registry"
  | "facility"
  | "router"
  | "aqua";

/** Board position of each node, relative to the centre of the platform. */
export const NODES: Record<NodeKey, readonly [number, number]> = {
  seller: [-165, -75],
  buyer: [-165, 75],
  orch: [-40, -172],
  merchant: [100, -182],
  workers: [182, -28],
  lenders: [168, 88],
  registry: [-40, -40],
  facility: [40, -40],
  router: [-40, 40],
  aqua: [40, 40],
};

/** The lifecycle step each node jumps to when clicked. */
export const NODE_STEP: Record<NodeKey, number> = {
  seller: 1,
  buyer: 2,
  orch: 3,
  registry: 4,
  lenders: 5,
  aqua: 5,
  facility: 6,
  workers: 7,
  merchant: 7,
  router: 8,
};

/** Nodes highlighted at each step (index 0 = step 1). */
export const ACTIVE: ReadonlyArray<ReadonlyArray<NodeKey>> = [
  ["seller", "orch"],
  ["buyer", "orch"],
  ["orch"],
  ["orch", "registry"],
  ["lenders", "aqua"],
  ["seller", "aqua", "facility"],
  ["facility", "workers", "merchant"],
  ["buyer", "router", "lenders", "seller"],
];

/** Route the data packet travels at each step. A single node means it hovers there. */
export const PATHS: ReadonlyArray<ReadonlyArray<NodeKey>> = [
  ["seller", "orch"],
  ["buyer", "orch"],
  ["orch"],
  ["orch", "registry"],
  ["lenders", "aqua"],
  ["aqua", "facility"],
  ["facility", "workers", "merchant"],
  ["buyer", "router", "lenders"],
];

/** Wires drawn on the board: [from, to, steps during which the wire is lit]. */
export const EDGES: ReadonlyArray<readonly [NodeKey, NodeKey, ReadonlyArray<number>]> = [
  ["seller", "orch", [1]],
  ["buyer", "orch", [2]],
  ["orch", "registry", [4]],
  ["lenders", "aqua", [5]],
  ["aqua", "facility", [6]],
  ["facility", "workers", [7]],
  ["workers", "merchant", [7]],
  ["buyer", "router", [8]],
  ["router", "lenders", [8]],
  ["router", "seller", [8]],
];

export const PACKET_LABELS = [
  "INVOICE",
  "EIP-712 SIG",
  "KYA ✓",
  "NFT #1",
  "APR 7–13%",
  "$6,000 USDC",
  "$0.25 · x402",
  "$10,000 USDC",
] as const;

export const nextStep = (s: number) => (s >= STEP_COUNT ? 1 : s + 1);
export const prevStep = (s: number) => (s <= 1 ? STEP_COUNT : s - 1);

/* ---------- packet ---------- */

const HOP_MS = 2100;
const HOLD_MS = 1100;

export function packetPose(step: number, elapsedMs: number, reduce: boolean) {
  const pts = PATHS[step - 1].map((k) => NODES[k]);
  const segs = Math.max(1, pts.length - 1);
  const dur = HOP_MS * segs;
  const raw = reduce ? 0.5 : (elapsedMs % (dur + HOLD_MS)) / dur;
  const linear = reduce ? 1 : Math.min(1, raw);
  const t = linear < 0.5 ? 2 * linear * linear : 1 - Math.pow(-2 * linear + 2, 2) / 2;

  if (pts.length === 1) {
    const [x, y] = pts[0];
    return { x: x + 6, y: y + 62, z: 46 + Math.sin(elapsedMs / 320) * 5, opacity: 1 };
  }

  const opacity = raw < 0.08 ? raw / 0.08 : raw > 0.86 ? Math.max(0, (1 - raw) / 0.14) : 1;
  const f = t * segs;
  const i = Math.min(segs - 1, Math.floor(f));
  const u = f - i;
  return {
    x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u,
    y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u,
    z: 46 + Math.sin(u * Math.PI) * 14,
    opacity,
  };
}

/* ---------- scene ---------- */

export type Face = {
  kind: "wire" | "block";
  node: NodeKey | null;
  left: number;
  top: number;
  width: number;
  height: number;
  radius: string;
  origin: string;
  transform: string;
  bg: string;
  shadow: string;
  text: string;
  fontSize: string;
  color: string;
  alignItems: string;
  justifyContent: string;
  padding: string;
};

export type AgentKey = "seller" | "buyer" | "orch" | "lenders" | "workers" | "merchant";

export type Figure = {
  node: NodeKey;
  transform: string;
  opacity: number;
  filter: string;
  borderColor: string;
};

export type Badge = { text: string; bg: string; color: string; transform: string };

const billboard = (x: number, y: number, z: number, rot: number) =>
  `translate3d(${x}px, ${y}px, ${z}px) rotateZ(${-rot}deg) rotateX(-58deg)`;

const shade = (c: string, k: number) => `color-mix(in oklch, ${c} ${k}%, #000)`;
const RING = "inset 0 0 0 1px rgb(var(--ink-rgb) / 0.16)";

type SlabOpts = { n?: number; node?: NodeKey; text?: string; fontSize?: string; color?: string; ring?: string };

const BLANK = {
  radius: "0",
  shadow: "none",
  text: "",
  fontSize: "10px",
  color: "transparent",
  origin: "50% 50%",
  alignItems: "flex-end",
  justifyContent: "flex-start",
  padding: "0",
};

/** A slab is a stack of identical flat faces, which reads as a solid block in 3D. */
function slab(
  out: Face[],
  [cx, cy]: readonly [number, number],
  w: number,
  d: number,
  h: number,
  z: number,
  top: string,
  side: string,
  radius: string,
  o: SlabOpts = {},
) {
  const n = o.n ?? 10;
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    out.push({
      ...BLANK,
      kind: "block",
      node: o.node ?? null,
      left: cx - w / 2,
      top: cy - d / 2,
      width: w,
      height: d,
      radius,
      transform: `translateZ(${(z + (i * h) / (n - 1)).toFixed(2)}px)`,
      bg: last ? top : i < 2 ? shade(side, 80) : side,
      shadow: last ? (o.ring ?? RING) : "none",
      text: last ? (o.text ?? "") : "",
      fontSize: o.fontSize ?? "10px",
      color: last ? (o.color ?? "transparent") : "transparent",
      padding: last && o.text ? "6px" : "0",
    });
  }
}

const MODULES: ReadonlyArray<readonly [NodeKey, string]> = [
  ["registry", "REGISTRY"],
  ["facility", "FACILITY"],
  ["router", "ROUTER"],
  ["aqua", "AQUA"],
];

const AGENTS: Record<AgentKey, readonly [number, number, string]> = {
  seller: [40, 8, "var(--seller)"],
  buyer: [40, 8, "var(--buyer)"],
  orch: [52, 14, "var(--ink)"],
  lenders: [72, 8, "var(--lender)"],
  workers: [60, 8, "var(--worker)"],
  merchant: [50, 8, "var(--warn)"],
};

const BADGES: ReadonlyArray<readonly [NodeKey, string, string]> = [
  ["registry", "ℏ HTS", "rgb(17 17 17 / 0.82)"],
  ["facility", "$ USDC", "rgb(39 117 202 / 0.85)"],
  ["router", "ℏ HCS", "rgb(17 17 17 / 0.82)"],
  ["aqua", "1inch", "rgb(15 26 46 / 0.85)"],
];

export function buildScene(step: number, rot: number) {
  const faces: Face[] = [];
  const active = new Set<NodeKey>(ACTIVE[step - 1]);

  // wires
  for (const [a, b, steps] of EDGES) {
    const [x1, y1] = NODES[a];
    const [x2, y2] = NODES[b];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    const lit = steps.includes(step);
    faces.push({
      ...BLANK,
      kind: "wire",
      node: null,
      origin: "0 50%",
      left: x1,
      top: y1 - (lit ? 0.75 : 0.5),
      width: len,
      height: lit ? 1.5 : 1,
      radius: "2px",
      transform: `translateZ(11px) rotateZ(${ang.toFixed(2)}deg)`,
      bg: lit ? "color-mix(in oklch, var(--accent) 80%, transparent)" : "transparent",
    });
  }

  // Hedera platform
  const hot = active.has("registry") || active.has("facility") || active.has("router") || active.has("aqua");
  slab(faces, [0, 0], 204, 204, 10, 0, "var(--blk-top)", "var(--blk-s1)", "22px", {
    n: 8,
    ring: hot ? "inset 0 0 0 1px color-mix(in oklch, var(--accent) 45%, transparent)" : RING,
  });

  // contract modules
  for (const [k, label] of MODULES) {
    const on = active.has(k);
    slab(
      faces,
      NODES[k],
      64,
      64,
      12,
      10 + (on ? 6 : 0),
      on ? "color-mix(in oklch, var(--accent) 38%, var(--blk-top))" : "var(--blk-top)",
      on ? "color-mix(in oklch, var(--accent) 45%, var(--blk-s1))" : "var(--blk-s1)",
      "14px",
      {
        n: 9,
        node: k,
        text: label,
        fontSize: "7.5px",
        color: "var(--muted)",
        ring: on ? "inset 0 0 0 1px color-mix(in oklch, var(--accent) 70%, transparent)" : RING,
      },
    );
  }

  // agent bases + standee figures
  const figures = {} as Record<AgentKey, Figure>;
  for (const k of Object.keys(AGENTS) as AgentKey[]) {
    const [dia, h, c] = AGENTS[k];
    const [x, y] = NODES[k];
    const on = active.has(k);
    const z = on ? 6 : 0;
    slab(
      faces,
      NODES[k],
      dia,
      dia,
      h,
      z,
      on ? `color-mix(in oklch, ${c} 42%, var(--blk-top))` : "var(--blk-top)",
      on ? `color-mix(in oklch, ${c} 48%, var(--blk-s1))` : "var(--blk-s1)",
      "50%",
      { n: 8, node: k, ring: on ? `inset 0 0 0 1px color-mix(in oklch, ${c} 80%, transparent)` : RING },
    );
    figures[k] = {
      node: k,
      transform: billboard(x, y, z + h, rot),
      opacity: on ? 1 : 0.5,
      filter: on ? "none" : "grayscale(0.85)",
      borderColor: on ? "color-mix(in oklch, var(--accent) 60%, transparent)" : "rgb(var(--ink-rgb) / 0.1)",
    };
  }

  const badges: Badge[] = BADGES.map(([k, text, bg]) => {
    const [x, y] = NODES[k];
    return { text, bg, color: "#ffffff", transform: billboard(x, y, active.has(k) ? 34 : 28, rot) };
  });

  return { faces, figures, badges };
}

export { billboard };
