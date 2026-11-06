"use client";

import { useEffect, useRef, type HTMLAttributes } from "react";
import { heroScrollFx } from "@/lib/howItWorks";

/** Wraps the hero content so it drifts down and fades as the page scrolls. */
export function HeroFx({ children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    const apply = () => {
      frame = 0;
      const fx = heroScrollFx(window.scrollY, window.innerHeight);
      el.style.transform = fx.transform;
      el.style.opacity = fx.opacity;
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={ref} {...rest}>
      {children}
    </div>
  );
}
