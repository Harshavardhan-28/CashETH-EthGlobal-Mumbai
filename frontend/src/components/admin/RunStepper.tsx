import type { Run } from "@/lib/admin/derive";
import { relativeTime } from "@/lib/admin/format";
import styles from "./Admin.module.css";

/** The invoice lifecycle as 5 steps: done (filled check), current (ring), to do (number). */
export function RunStepper({ run, nowMs, horizontal = false }: { run: Run; nowMs: number; horizontal?: boolean }) {
  return (
    <ol className={horizontal ? styles.hstepper : styles.stepper} aria-label={`${run.title} progress`}>
      {run.steps.map((step, i) => {
        const state = step.done ? styles.stepDone : step.current ? styles.stepCurrent : styles.stepTodo;
        return (
          <li key={step.label} className={`${horizontal ? styles.hstep : styles.step} ${state}`} data-done={step.done}>
            <span className={styles.dot}>{step.done ? "✓" : i + 1}</span>
            <div>
              <div className={styles.stepLabel}>{step.label}</div>
              <div className={styles.stepMeta}>
                {step.done && step.who ? `${step.who} · ${relativeTime(step.ts!, nowMs)}` : step.current ? "Next up" : "Waiting"}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
