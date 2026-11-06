"use client";

import { useEffect, useRef } from "react";
import styles from "./Hero.module.css";

const G = 32; // grid cell, matches the dot grid

type Packet = {
  gx: number;
  gy: number;
  dx: number;
  dy: number;
  t: number;
  v: number;
  c: string;
  lx: number | null;
  ly: number | null;
};

const isLight = () => document.documentElement.getAttribute("data-theme") === "light";

function pick(light: boolean) {
  const x = Math.random();
  if (x < 0.55) return light ? "rgba(20,24,21,0.3)" : "rgba(236,235,227,0.42)";
  if (x < 0.8) return light ? "#5a8c14" : "#c6ef6a";
  const tints = light
    ? ["#3f8a4a", "#2f7fae", "#c04f84", "#c06a2a"]
    : ["#7ec482", "#5cb6e4", "#ec8fb5", "#f09a64"];
  return tints[Math.floor(Math.random() * 4)];
}

/** Packets travelling along the dot grid, a nod to payments routing between agents. */
export function PacketCanvas({ density = 26 }: { density?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    let w = 0;
    let h = 0;
    let light = isLight();
    const packets: Packet[] = [];

    const resize = () => {
      const d = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      w = r.width;
      h = r.height;
      canvas.width = Math.round(w * d);
      canvas.height = Math.round(h * d);
      ctx.setTransform(d, 0, 0, d, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // Re-colour packets when the theme flips.
    const mo = new MutationObserver(() => {
      light = isLight();
      packets.length = 0;
      ctx.clearRect(0, 0, w, h);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const spawn = (anywhere: boolean): Packet => ({
      gx: anywhere ? Math.floor(Math.random() * (w / G)) : -1 - Math.floor(Math.random() * 6),
      gy: Math.floor(Math.random() * (h / G)),
      dx: 1,
      dy: 0,
      t: 0,
      v: 0.035 + Math.random() * 0.05,
      c: pick(light),
      lx: null,
      ly: null,
    });

    const frame = () => {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.05)";
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
      while (packets.length < density) packets.push(spawn(packets.length === 0 && w > 0));

      for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i];
        p.t += p.v;
        if (p.t >= 1) {
          p.gx += p.dx;
          p.gy += p.dy;
          p.t -= 1;
          if (p.dy === 0 && Math.random() < 0.18) {
            p.dx = 0;
            p.dy = Math.random() < 0.5 ? -1 : 1;
          } else if (p.dy !== 0 && Math.random() < 0.6) {
            p.dx = 1;
            p.dy = 0;
          }
          if (Math.random() < 0.05) {
            ctx.strokeStyle = p.c;
            ctx.lineWidth = 1;
            ctx.strokeRect(p.gx * G + G / 2 - 4.5, p.gy * G + G / 2 - 4.5, 9, 9);
          }
        }
        const x = (p.gx + p.dx * p.t) * G + G / 2;
        const y = (p.gy + p.dy * p.t) * G + G / 2;
        if (p.lx !== null && p.ly !== null) {
          ctx.strokeStyle = p.c;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(p.lx, p.ly);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        p.lx = x;
        p.ly = y;
        if (x > w + G || y < -G || y > h + G) packets.splice(i, 1);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
    };
  }, [density]);

  return <canvas ref={ref} className={styles.canvas} aria-hidden="true" />;
}
