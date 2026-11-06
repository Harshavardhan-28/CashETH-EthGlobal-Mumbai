"use client";

import { useEffect, useRef, type HTMLAttributes } from "react";

const MAX_STAGGER = 6;
const STAGGER_MS = 80;

/**
 * Fades and lifts its content in once it scrolls into view. Content is visible until the
 * client takes over, and stays visible for reduced motion or without IntersectionObserver.
 */
export function Reveal({ index = 0, children, ...rest }: HTMLAttributes<HTMLDivElement> & { index?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;

    const delay = Math.min(MAX_STAGGER, index) * STAGGER_MS;
    el.style.opacity = "0";
    el.style.transform = "translateY(36px)";
    el.style.transition = `opacity 1.1s cubic-bezier(.2,.7,.2,1) ${delay}ms, transform 1.1s cubic-bezier(.2,.7,.2,1) ${delay}ms`;

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const t = e.target as HTMLElement;
          t.style.opacity = "1";
          t.style.transform = "none";
          io.unobserve(t);
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [index]);

  return (
    <div ref={ref} {...rest}>
      {children}
    </div>
  );
}
