"use client";

import { useEffect, useMemo, useState } from "react";
import { DOC_NAV } from "@/lib/content";
import styles from "./Docs.module.css";

const GROUPS: { label: string; items: readonly (readonly [string, string])[] }[] = [
  { label: "GETTING STARTED", items: DOC_NAV.start },
  { label: "CONCEPTS", items: DOC_NAV.concepts },
  { label: "REFERENCE", items: DOC_NAV.ref },
];

/** Sidebar (filter + scroll-spy) wrapping the server-rendered doc sections. */
export function DocsShell({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState("overview");
  const [q, setQ] = useState("");

  useEffect(() => {
    const onScroll = () => {
      let cur = "overview";
      document.querySelectorAll<HTMLElement>("[data-doc-sec]").forEach((s) => {
        if (s.getBoundingClientRect().top <= 140) cur = s.dataset.docSec ?? cur;
      });
      setActive(cur);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const groups = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return GROUPS.map((g) => ({
      ...g,
      items: g.items.filter(([, label]) => !ql || label.toLowerCase().includes(ql)),
    })).filter((g) => g.items.length);
  }, [q]);

  return (
    <div className={styles.layout}>
      <aside className={styles.aside} aria-label="Documentation sections">
        <label className={styles.filter}>
          <span aria-hidden="true">/</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter sections"
            aria-label="Filter sections"
          />
        </label>
        {groups.map((g) => (
          <nav key={g.label} className={styles.group} aria-label={g.label}>
            <span className={styles.groupLabel}>{g.label}</span>
            {g.items.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                onClick={() => setActive(id)}
                aria-current={id === active ? "true" : undefined}
                className={`${styles.link} ${id === active ? styles.active : ""}`}
              >
                <i />
                {label}
              </a>
            ))}
          </nav>
        ))}
        {!groups.length && <span className={styles.none}>No sections match.</span>}
      </aside>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
