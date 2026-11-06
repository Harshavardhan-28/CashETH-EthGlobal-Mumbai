"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import { BuyerFigure, LendersFigure, MerchantFigure, OrchFigure, SellerFigure, WorkersFigure } from "./Figures";
import styles from "./LifecycleStage.module.css";

const STEP_MS = 4400;
const REDUCED_MOTION_STEP = 6;
const REFERENCE_WIDTH = 560;
const START_ROTATION = -40;

const AGENT_VIEW: Record<AgentKey, { name: string; Art: () => React.JSX.Element }> = {
  seller: { name: "Seller agent", Art: SellerFigure },
  buyer: { name: "Buyer agent", Art: BuyerFigure },
  orch: { name: "Orchestrator", Art: OrchFigure },
  lenders: { name: "Lenders", Art: LendersFigure },
  workers: { name: "Worker agents", Art: WorkersFigure },
  merchant: { name: "x402 merchant", Art: MerchantFigure },
};
const AGENT_ORDER: AgentKey[] = ["seller", "buyer", "orch", "lenders", "workers", "merchant"];

export function LifecycleStage() {
  const reduce = usePrefersReducedMotion();
  const [step, setStep] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [rot, setRot] = useState(START_ROTATION);
  const [dragging, setDragging] = useState(false);
  const [scale, setScale] = useState(1);

  const stageRef = useRef<HTMLDivElement>(null);
  const packetRef = useRef<HTMLDivElement>(null);
  const dragMoved = useRef(false);
  const stopDrag = useRef<(() => void) | null>(null);

  // Reduced motion: show a finished state and never autoplay.
  useEffect(() => {
    if (!reduce) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStep(REDUCED_MOTION_STEP);
    setPlaying(false);
  }, [reduce]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setStep(nextStep), STEP_MS);
    return () => clearInterval(id);
  }, [playing]);

  // Shrink the board on narrow screens.
  useEffect(() => {
    const el = stageRef.current;
    if (!el || !("ResizeObserver" in window)) return;
    const ro = new ResizeObserver(() => setScale(Math.min(1, el.clientWidth / REFERENCE_WIDTH)));
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

  useEffect(() => () => stopDrag.current?.(), []);

  const select = useCallback((n: number) => {
    if (dragMoved.current) return;
    setStep(n);
    setPlaying(false);
  }, []);
  const go = (fn: (s: number) => number) => {
    setStep(fn);
    setPlaying(false);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startRot = rot;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 4) moved = true;
      if (moved) {
        setRot(startRot + dx * 0.4);
        setDragging(true);
      }
    };
    const up = () => {
      cleanup();
      dragMoved.current = moved;
      setDragging(false);
      // Let the click that ends a drag pass before node clicks work again.
      setTimeout(() => {
        dragMoved.current = false;
      }, 0);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      stopDrag.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    stopDrag.current = cleanup;
  };

  const { faces, figures, badges } = buildScene(step, rot);
  const cur = LIFECYCLE[step - 1];
  const easing = dragging ? "none" : "transform .7s cubic-bezier(.2,.7,.2,1)";

  const nodeProps = (node: NodeKey | null) =>
    node ? { "data-node": node, onClick: () => select(NODE_STEP[node]) } : {};

  return (
    <div className={styles.root}>
      <div className={styles.bar}>
        <span className={styles.title}>
          <span className={styles.live} />
          <b>LIFECYCLE</b>
          <span>INV-2207 · $10,000 · Net 30</span>
        </span>
        <span className={styles.controls}>
          <button type="button" className={styles.round} aria-label="Previous step" onClick={() => go(prevStep)}>
            ‹
          </button>
          <button type="button" className={styles.play} onClick={() => setPlaying((p) => !p)}>
            {playing ? "Pause" : "Play"}
          </button>
          <button type="button" className={styles.round} aria-label="Next step" onClick={() => go(nextStep)}>
            ›
          </button>
        </span>
      </div>

      <div
        ref={stageRef}
        data-testid="stage"
        className={styles.stage}
        style={{ cursor: dragging ? "grabbing" : "grab" }}
        onPointerDown={onPointerDown}
      >
        <div
          data-testid="plane"
          className={styles.plane}
          style={{
            transform: `scale(${scale}) rotateX(58deg) rotateZ(${rot}deg)`,
            transition: dragging ? "none" : "transform .5s ease",
          }}
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
            <div key={b.text} className={styles.anchor} style={{ transform: b.transform, transition: easing }}>
              <span className={styles.badge} style={{ background: b.bg, color: b.color }}>
                {b.text}
              </span>
            </div>
          ))}

          {AGENT_ORDER.map((k) => {
            const fig = figures[k];
            const { name, Art } = AGENT_VIEW[k];
            return (
              <div key={k} className={styles.anchor} style={{ transform: fig.transform, transition: easing }}>
                <div
                  {...nodeProps(fig.node)}
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
            <div style={{ transform: `rotateZ(${-rot}deg) rotateX(-58deg)` }}>
              <span className={styles.packet}>{PACKET_LABELS[step - 1]}</span>
            </div>
          </div>
        </div>

        <div className={styles.hint}>
          <span>DRAG TO ROTATE · CLICK A NODE</span>
          <span className={styles.platform}>
            <span className={styles.hbar}>ℏ</span>PLATFORM = HEDERA TESTNET · EVM 296
          </span>
        </div>
      </div>

      <div className={styles.caption}>
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
        <div className={styles.copy} aria-live="polite">
          <span className={styles.stepNo} data-testid="step-status">
            Step {step} of {STEP_COUNT} · {cur.actor}
          </span>
          <span className={styles.stepTitle}>{cur.title}</span>
          <span className={styles.stepBody}>{cur.body}</span>
        </div>
      </div>
    </div>
  );
}
