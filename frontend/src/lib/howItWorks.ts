/** Pure logic for the scroll-driven "How it works" section and the hero scroll effect. */

export const SCENE_COUNT = 4;

/** Index of the copy block whose centre is nearest `mid`; `current` if there is nothing to measure. */
export function nearestScene(centers: number[], mid: number, current: number) {
  let best = current;
  let bestDistance = Infinity;
  centers.forEach((c, i) => {
    const d = Math.abs(c - mid);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return best;
}

export type SceneState = {
  visible: boolean;
  transform: string;
  pointerEvents: "auto" | "none";
  copyOpacity: number;
  reached: boolean;
  fund: string;
  repay: { a: string; b: string; s: string };
};

/** What each of the four scenes should look like when scene `active` is in view. */
export function sceneState(active: number): SceneState[] {
  return Array.from({ length: SCENE_COUNT }, (_, i) => {
    const on = i === active;
    return {
      visible: on,
      transform: on ? "none" : "translateY(16px)",
      pointerEvents: on ? "auto" : "none",
      copyOpacity: on ? 1 : 0.28,
      reached: i <= active,
      fund: i === 1 && on ? "60%" : "0%",
      repay: i === 3 && on ? { a: "40.23%", b: "20.14%", s: "39.63%" } : { a: "0%", b: "0%", s: "0%" },
    };
  });
}

/** The hero drifts down and fades over roughly one screen of scrolling. */
export function heroScrollFx(scrollY: number, viewportHeight: number) {
  const p = Math.min(1, Math.max(0, scrollY / (viewportHeight * 0.9)));
  return {
    transform: p ? `translateY(${(p * 80).toFixed(1)}px) scale(${(1 - p * 0.04).toFixed(4)})` : "",
    opacity: (1 - p * 0.9).toFixed(3),
  };
}
