import { useMemo } from "react";
import { SETUP_RUN_ID, addUnits, groupRuns, type Run } from "@/lib/admin/derive";
import { formatUsdc, relativeTime } from "@/lib/admin/format";
import styles from "./Admin.module.css";
import { ActivityFeed } from "./ActivityFeed";
import { PageHead } from "./Chrome";
import type { ViewProps } from "./Overview";
import { Empty, StatusChip } from "./primitives";
import { RunStepper } from "./RunStepper";

const sum = (run: Run, type: string) => run.events.filter((e) => e.type === type && e.amount).reduce((acc, e) => addUnits(acc, e.amount!), "0");

export function RunsView(props: ViewProps & { runId?: string }) {
  const { all, nowMs, go, runId } = props;
  const runs = useMemo(() => groupRuns(all), [all]);

  if (runId) {
    const run = runs.find((r) => r.id.toLowerCase() === runId.toLowerCase());
    return run ? <RunDetail run={run} {...props} /> : <RunNotFound go={go} />;
  }

  return (
    <>
      <PageHead title="Runs" subtitle="Every invoice an agent has financed, from upload to repayment" />
      <section className={styles.card}>
        {!runs.length ? (
          <Empty title="No runs yet">A run starts when a seller agent uploads an invoice.</Empty>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Status</th>
                  <th>Amount</th>
                  <th>Progress</th>
                  <th>Started</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const setup = run.id === SETUP_RUN_ID;
                  return (
                    <tr key={run.id} className={styles.rowClick} onClick={() => go({ view: "runs", run: run.id })}>
                      <td className={styles.whoName}>{run.title}</td>
                      <td>{setup ? <span className={styles.when}>Registrations, strategies</span> : <StatusChip kind={run.status} />}</td>
                      <td className={styles.mono}>{run.amount ? formatUsdc(run.amount) : "—"}</td>
                      <td>
                        {setup ? (
                          <span className={styles.when}>—</span>
                        ) : (
                          <span className={styles.dots} aria-label={`${run.steps.filter((s) => s.done).length} of 5 steps done`}>
                            {run.steps.map((s) => (
                              <i key={s.label} className={s.done ? styles.dotOn : undefined} />
                            ))}
                          </span>
                        )}
                      </td>
                      <td className={styles.when}>{relativeTime(run.startedAt, nowMs)}</td>
                      <td className={styles.mono}>{run.events.length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Total({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${styles.card} ${styles.tile}`}>
      <div className={styles.miniLabel}>{label}</div>
      <div className={styles.kpiValue}>{value}</div>
    </div>
  );
}

function RunDetail({ run, nowMs, go }: ViewProps & { run: Run }) {
  const setup = run.id === SETUP_RUN_ID;
  const timeline = [...run.events].reverse(); // newest first, like every feed
  return (
    <>
      <PageHead
        back={{ label: "All runs", onClick: () => go({ view: "runs" }) }}
        title={
          <span className={styles.detailHead}>
            {run.title}
            {!setup && <StatusChip kind={run.status} />}
          </span>
        }
        subtitle={`Started ${relativeTime(run.startedAt, nowMs)} · last action ${relativeTime(run.lastAt, nowMs)}`}
      />
      {!setup && (
        <>
          <section className={styles.card}>
            <RunStepper run={run} nowMs={nowMs} horizontal />
          </section>
          <section className={styles.totals}>
            <Total label="Financed by lenders" value={formatUsdc(sum(run, "FacilityFunded"))} />
            <Total label="Spent by agents (x402)" value={formatUsdc(sum(run, "SpendCommitted"))} />
            <Total label="Repaid by buyer" value={formatUsdc(sum(run, "Repaid"))} />
          </section>
        </>
      )}
      <section className={styles.card}>
        <div className={styles.cardHead}>
          <h2>Timeline</h2>
          <span>{run.events.length} on-chain records</span>
        </div>
        <ActivityFeed items={timeline} nowMs={nowMs} onSelectAgent={(key) => go({ view: "agents", agent: key })} />
      </section>
    </>
  );
}

function RunNotFound({ go }: { go: ViewProps["go"] }) {
  return (
    <>
      <PageHead back={{ label: "All runs", onClick: () => go({ view: "runs" }) }} title="Run not found" />
      <div className={styles.card}>
        <Empty title="Run not found">No invoice with this id has been recorded.</Empty>
      </div>
    </>
  );
}
