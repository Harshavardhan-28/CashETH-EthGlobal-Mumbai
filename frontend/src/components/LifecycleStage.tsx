"use client";

import { useEffect, useRef, useState } from "react";
import { LIFECYCLE } from "@/lib/content";
import {
  NODE_STEP,
  PACKET_LABELS,
  STEP_COUNT,
  buildScene,
  nextStep,
  packetPose,
  prevStep,
  type AgentKey,
  type NodeKey,
} from "@/lib/stage";
import { usePrefersReducedMotion } from "@/lib/useInView";
import {
  BuyerFigure,
  LendersFigure,
  MerchantFigure,
  OrchFigure,
  SellerFigure,
  WorkersFigure,
  type FigureSize,
} from "./Figures";
import styles from "./LifecycleStage.module.css";

const STEP_MS = 4400;
const RESUME_DELAY_MS = 300;
const REDUCED_MOTION_STEP = 6;
const ROTATION = -40;
// The rotated board is ~610px across and ~470px tall in the scene; scale so it never clips.
const REFERENCE_WIDTH = 680;
const REFERENCE_HEIGHT = 470;
const MAX_SCALE = 1.4;

const AGENT_VIEW: Record<AgentKey, { name: string; Art: (p: FigureSize) => React.JSX.Element }> = {
  seller: { name: "Seller agent", Art: SellerFigure },
  buyer: { name: "Buyer agent", Art: BuyerFigure },
  orch: { name: "Orchestrator", Art: OrchFigure },
  lenders: { name: "Lenders", Art: LendersFigure },
  workers: { name: "Worker agents", Art: WorkersFigure },
  merchant: { name: "x402 merchant", Art: MerchantFigure },
};
const AGENT_ORDER: AgentKey[] = ["seller", "buyer", "orch", "lenders", "workers", "merchant"];

/**
 * Isometric lifecycle board. Hover a node to jump to its step; autoplay holds while
 * the pointer is on the board and resumes shortly after it leaves.
 */
export function LifecycleStage() {
  const reduce = usePrefersReducedMotion();
  const [step, setStep] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [hovering, setHovering] = useState(false);
  const [scale, setScale] = useState(1);

  const stageRef = useRef<HTMLDivElement>(null);
  const packetRef = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Reduced motion: show a finished state and never autoplay.
  useEffect(() => {
    if (!reduce) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStep(REDUCED_MOTION_STEP);
    setPlaying(false);
  }, [reduce]);

  useEffect(() => {
    if (!playing || hovering) return;
    const id = setInterval(() => setStep(nextStep), STEP_MS);
    return () => clearInterval(id);
  }, [playing, hovering]);

  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  // Fit the board to whichever of width or height is tighter.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !("ResizeObserver" in window)) return;
    const ro = new ResizeObserver(() =>
      setScale(Math.min(el.clientWidth / REFERENCE_WIDTH, el.clientHeight / REFERENCE_HEIGHT, MAX_SCALE) || 1),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The data packet is driven imperatively so it animates at frame rate without re-rendering.
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const loop = (now: number) => {
      const el = packetRef.current;
      if (el) {
        const p = packetPose(step, now - start, reduce);
        el.style.opacity = p.opacity.toFixed(3);
        el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, ${p.z.toFixed(1)}px)`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [step, reduce]);

  const enterNode = (node: NodeKey) => {
    clearTimeout(leaveTimer.current);
    setHovering(true);
    setStep(NODE_STEP[node]);
  };
  const leaveNode = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHovering(false), RESUME_DELAY_MS);
  };
  const go = (fn: (s: number) => number) => {
    setStep(fn);
    setPlaying(false);
  };

  const { faces, figures, badges } = buildScene(step, ROTATION);
  const cur = LIFECYCLE[step - 1];
  const nodeProps = (node: NodeKey | null) =>
    node ? { "data-node": node, onMouseEnter: () => enterNode(node), onMouseLeave: leaveNode } : {};

  return (
    <div className={styles.root}>
      <div ref={stageRef} data-testid="stage" className={styles.stage}>
        <div
          data-testid="plane"
          className={styles.plane}
          style={{ transform: `scale(${scale}) rotateX(58deg) rotateZ(${ROTATION}deg)` }}
        >
          <div className={styles.board} />

          {faces.map((f, i) => (
            <div
              key={i}
              {...nodeProps(f.node)}
              className={styles.face}
              style={{
                left: f.left,
                top: f.top,
                width: f.width,
                height: f.height,
                transformOrigin: f.origin,
                transform: f.transform,
                background: f.bg,
                borderRadius: f.radius,
                boxShadow: f.shadow,
                alignItems: f.alignItems,
                justifyContent: f.justifyContent,
                padding: f.padding,
                fontSize: f.fontSize,
                color: f.color,
                cursor: f.node ? "pointer" : "default",
                pointerEvents: f.kind === "wire" ? "none" : undefined,
              }}
            >
              {f.text}
            </div>
          ))}

          {badges.map((b) => (
            <div key={b.text} className={styles.anchor} style={{ transform: b.transform }}>
              <span className={styles.badge} style={{ background: b.bg, color: b.color }}>
                {b.text}
              </span>
            </div>
          ))}

          {AGENT_ORDER.map((k) => {
            const fig = figures[k];
            const { name, Art } = AGENT_VIEW[k];
            return (
              <div key={k} className={styles.anchor} style={{ transform: fig.transform }}>
                <div
                  {...nodeProps(fig.node)}
                  data-figure=""
                  className={styles.figure}
                  style={{ opacity: fig.opacity, filter: fig.filter }}
                >
                  <span className={styles.nameplate} style={{ borderColor: fig.borderColor }}>
                    {name}
                  </span>
                  <Art />
                </div>
              </div>
            );
          })}

          <div ref={packetRef} className={styles.anchor} style={{ opacity: 0 }}>
            <div style={{ transform: `rotateZ(${-ROTATION}deg) rotateX(-58deg)` }}>
              <span className={styles.packet}>{PACKET_LABELS[step - 1]}</span>
            </div>
          </div>
        </div>

        <div className={styles.platform}>
          <span className={styles.hbar}>ℏ</span>PLATFORM = HEDERA TESTNET · EVM 296
        </div>
      </div>

      <div className={styles.pill}>
        <span className={styles.now} aria-live="polite">
          <span className={styles.nowNumber} data-testid="step-number">
            {cur.n}
          </span>
          <span className={styles.nowTitle} data-testid="step-title">
            {cur.title}
          </span>
          <span className={styles.nowActor} data-testid="step-actor">
            {cur.actor}
          </span>
        </span>

        <div className={styles.segments}>
          {Array.from({ length: STEP_COUNT }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              className={styles.segment}
              aria-label={`Step ${n}`}
              aria-current={n === step ? "step" : undefined}
              onClick={() => go(() => n)}
            >
              <span
                style={{
                  background:
                    n < step ? "var(--accent)" : n === step ? "var(--ink)" : "rgb(var(--ink-rgb) / 0.12)",
                }}
              />
            </button>
          ))}
        </div>

        <span className={styles.controls}>
          <button type="button" className={styles.round} aria-label="Previous step" onClick={() => go(prevStep)}>
            ‹
          </button>
          <button
            type="button"
            className={styles.playBtn}
            aria-label="Play or pause"
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button type="button" className={styles.round} aria-label="Next step" onClick={() => go(nextStep)}>
            ›
          </button>
        </span>
      </div>
    </div>
  );
}
