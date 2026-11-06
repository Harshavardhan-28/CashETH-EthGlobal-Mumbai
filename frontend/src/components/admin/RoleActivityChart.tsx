import type { RoleBucket } from "@/lib/admin/derive";
import type { ActorRole } from "@/lib/admin/narrate";
import styles from "./Admin.module.css";
import { ROLE_COLOR, ROLE_PLURAL } from "./primitives";

const ORDER: ActorRole[] = ["seller", "buyer", "lender", "worker", "mcp"];

function label(ms: number, spanMs: number): string {
  const d = new Date(ms);
  return spanMs > 2 * 86_400_000
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Stacked bars of actions per time bucket, coloured by the role of the agent that acted. */
export function RoleActivityChart({ buckets, nowMs }: { buckets: RoleBucket[]; nowMs: number }) {
  const W = 600;
  const H = 180;
  const totals = buckets.map((b) => ORDER.reduce((s, r) => s + b.counts[r], 0));
  const max = Math.max(1, ...totals);
  const slot = W / Math.max(1, buckets.length);
  const bar = slot * 0.62;
  const used = ORDER.filter((r) => buckets.some((b) => b.counts[r] > 0));
  const start = buckets[0]?.start ?? nowMs;
  const span = nowMs - start;

  return (
    <div>
      <svg className={styles.chart} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Actions per time period by agent role">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1="0" x2={W} y1={H - f * (H - 8)} y2={H - f * (H - 8)} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {buckets.map((b, i) => {
          let y = H;
          return (
            <g key={i} transform={`translate(${i * slot + (slot - bar) / 2},0)`}>
              {ORDER.map((r) => {
                const n = b.counts[r];
                if (!n) return null;
                const h = (n / max) * (H - 8);
                y -= h;
                return (
                  <rect key={r} y={y} width={bar} height={Math.max(h - 1.5, 1)} rx="3" fill={ROLE_COLOR[r]}>
                    <title>{`${ROLE_PLURAL[r]}: ${n} action${n === 1 ? "" : "s"}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className={styles.axis}>
        <span>{label(start, span)}</span>
        <span>{label(start + span / 2, span)}</span>
        <span>Now</span>
      </div>
      <div className={styles.legend}>
        {(used.length ? used : (["seller", "buyer", "worker", "lender"] as ActorRole[])).map((r) => (
          <span key={r}>
            <i style={{ background: ROLE_COLOR[r] }} />
            {ROLE_PLURAL[r]}
          </span>
        ))}
      </div>
    </div>
  );
}
