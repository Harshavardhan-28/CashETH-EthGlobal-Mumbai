/**
 * Pure description of the opening animation: an invoice is verified, minted into
 * coins, poured into the liquidity pool and revealed as working capital.
 * Components only apply what these functions return.
 */

/** [milliseconds after mount, phase entered]. */
export const INTRO_TIMELINE: ReadonlyArray<readonly [number, number]> = [
  [120, 1],
  [1150, 2],
  [2000, 3],
  [2650, 4],
  [3700, 5],
  [4800, 6],
  [5650, 7],
];

/** Phase at which the overlay is unmounted. */
export const FINAL_PHASE = 7;
/** Phase at which the overlay starts to dissolve and the page becomes usable. */
export const REVEAL_PHASE = 6;
/** Phase at which the amount starts counting up. */
export const COUNT_PHASE = 4;
export const INTRO_AMOUNT = 7500;
export const COUNT_MS = 1300;
export const SKIP_DISSOLVE_MS = 800;

export function formatAmount(n: number) {
  return "$" + n.toLocaleString("en-US") + ".00";
}

function caption(ph: number) {
  if (ph <= 2) return "A buyer-signed invoice";
  if (ph <= 4) return "becomes liquidity";
  return "your agents can spend";
}

export function introFrame(ph: number, vh: number) {
  const scale = Math.max(0.6, Math.min(1, (vh - 220) / 600));
  return {
    caption: caption(ph),
    overlayOpacity: ph >= REVEAL_PHASE ? 0 : 1,
    overlayTransform: ph >= REVEAL_PHASE ? "translateY(-2%)" : "none",
    overlayPointerEvents: ph >= REVEAL_PHASE ? ("none" as const) : ("auto" as const),
    invoiceOpacity: ph === 0 || ph >= 3 ? 0 : 1,
    invoiceTransform:
      ph === 0
        ? `translateY(26px) scale(${scale * 0.96})`
        : ph >= 3
          ? `translateY(-40px) scale(${scale * 0.2}) rotate(-8deg)`
          : `translateY(0) scale(${scale})`,
    stampOpacity: ph === 2 ? 1 : 0,
    stampTransform: ph >= 2 ? "rotate(-12deg) scale(1)" : "rotate(-12deg) scale(1.6)",
    poolOpacity: ph >= 3 ? 1 : ph >= 1 ? 0.45 : 0,
    poolHeight: ph >= 4 ? "64%" : "0%",
    waveOpacity: ph >= 4 ? 1 : 0,
    labelOpacity: ph >= 5 ? 1 : 0,
    labelTransform: ph >= 5 ? "translateY(0)" : "translateY(14px)",
  };
}

type CoinType = "usdc" | "hbar" | "eth";
const TOKEN: Record<CoinType, { bg: string; glyph: string }> = {
  usdc: { bg: "#2775CA", glyph: "$" },
  hbar: { bg: "#1b1b1b", glyph: "ℏ" },
  eth: { bg: "#627EEA", glyph: "Ξ" },
};

export type Coin = {
  type: CoinType;
  /** burst position */
  bx: number;
  by: number;
  rot: number;
  /** resting x inside the pool and which row it falls onto */
  px: number;
  row: 0 | 1;
};

export const COINS: Coin[] = Array.from({ length: 20 }, (_, i) => {
  const type: CoinType = i % 4 === 1 ? "hbar" : i % 4 === 3 ? "eth" : "usdc";
  const a = (i / 20) * Math.PI * 2 + (i % 2 ? 0.18 : -0.1);
  const r = 150 + (i % 3) * 48;
  return {
    type,
    bx: Math.cos(a) * r,
    by: -70 + Math.sin(a) * r * 0.82,
    rot: ((i * 47) % 360) - 180,
    px: -150 + (i % 10) * 33 + (i >= 10 ? 16 : 0),
    row: i >= 10 ? 1 : 0,
  };
});

export function coinFrame(coin: Coin, index: number, ph: number, vh: number) {
  const { bg, glyph } = TOKEN[coin.type];
  const poolY = vh * 0.4 - 130 + 28;
  let transform: string;
  let opacity = 1;
  let transition: string;
  if (ph < 3) {
    transform = "translate(0px, -70px) scale(0.2) rotate(0deg)";
    opacity = 0;
    transition = "none";
  } else if (ph === 3) {
    transform = `translate(${coin.bx.toFixed(1)}px, ${coin.by.toFixed(1)}px) scale(1) rotate(${coin.rot}deg)`;
    transition = `transform .6s cubic-bezier(.15,.85,.3,1) ${index * 14}ms, opacity .25s ease ${index * 14}ms`;
  } else {
    transform = `translate(${coin.px}px, ${poolY + coin.row * 16}px) scale(0.78) rotate(${coin.rot / 4}deg)`;
    opacity = ph >= 5 ? 0 : 1;
    transition = `transform .75s cubic-bezier(.55,0,.85,.45) ${index * 32}ms, opacity .5s ease ${ph >= 5 ? index * 10 : 0}ms`;
  }
  return { transform, opacity, transition, background: bg, glyph };
}
