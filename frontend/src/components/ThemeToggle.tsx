"use client";

import { useEffect, useState } from "react";
import styles from "./ThemeToggle.module.css";

type Theme = "dark" | "light";

export function ThemeToggle({ variant = "labelled" }: { variant?: "labelled" | "icon" }) {
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    // Sync with the value the pre-paint script applied.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(current === "light" ? "light" : "dark");
  }, []);

  const toggle = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("casheth-theme", next);
    } catch {}
    setTheme(next);
  };

  const next = theme === "light" ? "Dark" : "Light";

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label="Toggle color theme"
        title={`${next} mode`}
        className={styles.icon}
      >
        <span className={styles.glyphLg} />
      </button>
    );
  }

  return (
    <button type="button" onClick={toggle} aria-label="Toggle color theme" className={styles.btn}>
      <span className={styles.glyph} />
      {next}
    </button>
  );
}
