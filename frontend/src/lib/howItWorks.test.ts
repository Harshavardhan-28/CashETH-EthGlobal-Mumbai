import { describe, expect, it } from "vitest";
import { SCENE_COUNT, heroScrollFx, nearestScene, sceneState } from "./howItWorks";

describe("nearestScene", () => {
  it("picks the block whose centre is closest to the middle of the viewport", () => {
    expect(nearestScene([100, 500, 900, 1300], 520, 0)).toBe(1);
    expect(nearestScene([-1200, -600, 0, 600], 400, 0)).toBe(3);
  });

  it("keeps the current scene when there is nothing to measure", () => {
    expect(nearestScene([], 400, 2)).toBe(2);
  });
});

describe("sceneState", () => {
  it("has four scenes", () => {
    expect(SCENE_COUNT).toBe(4);
  });

  it("shows only the active scene and lets only it take pointer events", () => {
    const s = sceneState(2);
    expect(s.map((x) => x.visible)).toEqual([false, false, true, false]);
    expect(s.map((x) => x.pointerEvents)).toEqual(["none", "none", "auto", "none"]);
  });

  it("slides inactive scenes down and settles the active one", () => {
    const s = sceneState(0);
    expect(s[0].transform).toBe("none");
    expect(s[1].transform).toBe("translateY(16px)");
  });

  it("dims the copy of inactive steps", () => {
    expect(sceneState(1).map((x) => x.copyOpacity)).toEqual([0.28, 1, 0.28, 0.28]);
  });

  it("fills the funding bar only on the capital scene", () => {
    expect(sceneState(1)[1].fund).toBe("60%");
    expect(sceneState(0)[1].fund).toBe("0%");
    expect(sceneState(3)[1].fund).toBe("0%");
  });

  it("splits the repayment only on the final scene, lenders first", () => {
    expect(sceneState(3)[3].repay).toEqual({ a: "40.23%", b: "20.14%", s: "39.63%" });
    expect(sceneState(1)[3].repay).toEqual({ a: "0%", b: "0%", s: "0%" });
  });

  it("highlights progress up to and including the active scene", () => {
    expect(sceneState(2).map((x) => x.reached)).toEqual([true, true, true, false]);
  });
});

describe("heroScrollFx", () => {
  it("leaves the hero untouched at the top of the page", () => {
    expect(heroScrollFx(0, 800)).toEqual({ transform: "", opacity: "1.000" });
  });

  it("fades and drifts the hero away over about one screen of scrolling", () => {
    expect(heroScrollFx(720, 800)).toEqual({ transform: "translateY(80.0px) scale(0.9600)", opacity: "0.100" });
  });

  it("stops changing past that point", () => {
    expect(heroScrollFx(5000, 800)).toEqual(heroScrollFx(720, 800));
  });
});
