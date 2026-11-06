"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { HOW_STEPS } from "@/lib/content";
import { nearestScene, sceneState, SCENE_COUNT } from "@/lib/howItWorks";
import { BuyerFigure, LendersFigure, SellerFigure, WorkersFigure } from "./Figures";
import { Reveal } from "./Reveal";
import styles from "./HowItWorks.module.css";

const delay = (ms: number) => ({ "--d": `${ms}ms` }) as CSSProperties;

const SPEND_ROWS = [
  ["Research API", "$0.25", false],
  ["GPU compute", "$1.20", false],
  ["Market data", "$0.40", false],
  ["Compute · over budget", "$5,500", true],
] as const;

/**
 * Four scenes pinned beside four blocks of copy; whichever block is nearest the middle of
 * the viewport decides which scene is showing.
 */
export function HowItWorks() {
  const [active, setActive] = useState(0);
  const copyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const blocks = copyRef.current?.querySelectorAll("[data-hw]");
      if (!blocks) return;
      const centers = [...blocks].map((b) => {
        const r = b.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      setActive((cur) => nearestScene(centers, window.innerHeight / 2, cur));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  const scenes = sceneState(active);

  const scrollToBlock = (i: number) => {
    const el = copyRef.current?.querySelector(`[data-hw="${i}"]`) as HTMLElement | null;
    if (!el) return;
    window.scrollTo({
      top: el.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2 + el.offsetHeight / 2,
      behavior: "smooth",
    });
  };

  const scene = (i: number) => ({
    "data-scene": i + 1,
    "data-active": String(scenes[i].visible),
    className: styles.scene,
    style: { opacity: scenes[i].visible ? 1 : 0, pointerEvents: scenes[i].pointerEvents },
  });

  return (
    <section id="flow" className={styles.section} aria-labelledby="how-title">
      <Reveal className={styles.head}>
        <span className={styles.badge}>
          <span className={styles.badgeDot} />
          HOW IT WORKS
        </span>
        <h2 id="how-title" className={styles.title}>
          From invoice to spendable capital in <span>four moves.</span>
        </h2>
      </Reveal>

      <div className={styles.layout}>
        <div className={styles.sticky}>
          <div className={styles.panel}>
            <div className={styles.glowA} />
            <div className={styles.glowB} />

            <div {...scene(0)}>
              <div className={styles.row}>
                <div className={styles.item} style={delay(0)}>
                  <div className={styles.agent}>
                    <SellerFigure width={64} height={70} />
                    <span>Seller agent</span>
                  </div>
                </div>
                <div className={`${styles.link} ${styles.item}`} style={delay(120)}>
                  <span>uploads</span>
                  <i className={styles.lineR} />
                </div>
                <div className={`${styles.invoice} ${styles.item}`} style={delay(200)}>
                  <div className={styles.invoiceHead}>
                    <b>Invoice</b>
                    <span>INV-2207</span>
                  </div>
                  <i className={styles.skel} style={{ width: "80%" }} />
                  <i className={styles.skel} style={{ width: "62%" }} />
                  <div className={styles.invoiceTotal}>
                    <span>Net 30</span>
                    <b>$10,000</b>
                  </div>
                  <span className={`${styles.sig} ${styles.item}`} style={delay(650)}>
                    ✓ EIP-712 signed
                  </span>
                </div>
                <div className={`${styles.link} ${styles.item}`} style={delay(400)}>
                  <span>signs</span>
                  <i className={styles.lineL} />
                </div>
                <div className={styles.item} style={delay(320)}>
                  <div className={styles.agent}>
                    <BuyerFigure width={64} height={70} />
                    <span>Buyer agent</span>
                  </div>
                </div>
              </div>
              <span className={`${styles.note} ${styles.item}`} style={delay(800)}>
                Registered on Hedera · receivable NFT #1
              </span>
            </div>

            <div {...scene(1)}>
              <div className={styles.item} style={delay(0)}>
                <LendersFigure width={84} height={46} />
              </div>
              <div className={`${styles.chips} ${styles.item}`} style={delay(120)}>
                <div className={styles.chip}>
                  <span>Lender A · 7.00%</span>
                  <span className={styles.chipSub}>$4,000</span>
                </div>
                <div className={styles.chip}>
                  <span>Lender B · 8.50%</span>
                  <span className={styles.chipSub}>$2,000</span>
                </div>
                <div className={`${styles.chip} ${styles.chipOff}`}>
                  <span>Lender C · 13.00%</span>
                  <span className={styles.struck}>not needed</span>
                </div>
              </div>
              <span className={`${styles.aqua} ${styles.item}`} style={delay(260)}>
                1inch Aqua · cheapest first
              </span>
              <div className={`${styles.meter} ${styles.item}`} style={delay(400)}>
                <div className={styles.meterHead}>
                  <span>Working capital</span>
                  <b>
                    $6,000 <small>USDC</small>
                  </b>
                </div>
                <div className={styles.track}>
                  <div
                    data-testid="fund-bar"
                    className={styles.fund}
                    style={{ width: scenes[1].fund }}
                  />
                  <div className={styles.cap} />
                </div>
                <div className={styles.scale}>
                  <span>$0</span>
                  <span>75% cap</span>
                  <span>$10,000</span>
                </div>
              </div>
            </div>

            <div {...scene(2)}>
              <div className={`${styles.workers} ${styles.item}`} style={delay(0)}>
                <WorkersFigure width={96} height={70} />
                <div>
                  <b>Worker agents</b>
                  <span>pay per request over x402</span>
                </div>
              </div>
              <div className={styles.rows}>
                {SPEND_ROWS.map(([name, amount, blocked], i) => (
                  <div
                    key={name}
                    className={`${styles.spend} ${blocked ? styles.spendBlocked : ""} ${styles.item}`}
                    style={delay(150 + i * 130)}
                  >
                    <span>{name}</span>
                    <span className={styles.amount}>{amount}</span>
                    <span className={blocked ? styles.bad : styles.ok}>{blocked ? "✕ blocked" : "✓ settled"}</span>
                  </div>
                ))}
              </div>
              <span className={`${styles.note} ${styles.item}`} style={delay(700)}>
                Budgets can never exceed what lenders funded
              </span>
            </div>

            <div {...scene(3)}>
              <div className={`${styles.payer} ${styles.item}`} style={delay(0)}>
                <BuyerFigure width={64} height={70} />
                <div>
                  <span>Buyer pays the router</span>
                  <b>$10,000</b>
                </div>
              </div>
              <div className={`${styles.split} ${styles.item}`} style={delay(200)}>
                <div className={styles.splitBar}>
                  <div style={{ width: scenes[3].repay.a, background: "var(--lender)", transitionDelay: ".4s" }} />
                  <div
                    style={{
                      width: scenes[3].repay.b,
                      background: "color-mix(in oklch, var(--lender) 65%, var(--bg))",
                      transitionDelay: "1.1s",
                    }}
                  />
                  <div style={{ width: scenes[3].repay.s, background: "var(--seller)", transitionDelay: "1.6s" }} />
                </div>
                <div className={styles.legend}>
                  {[
                    ["1 · Lender A", "$4,023", "var(--lender)"],
                    ["1 · Lender B", "$2,014", "color-mix(in oklch, var(--lender) 65%, var(--bg))"],
                    ["2 · Seller", "$3,963", "var(--seller)"],
                  ].map(([label, amt, color]) => (
                    <div key={label}>
                      <span>
                        <i style={{ background: color }} />
                        {label}
                      </span>
                      <b>{amt}</b>
                    </div>
                  ))}
                </div>
              </div>
              <span className={`${styles.done} ${styles.item}`} style={delay(900)}>
                <span>✓</span>Repaid · buyer reputation updated
              </span>
            </div>

            <div className={styles.progress}>
              {HOW_STEPS.map((s, i) => (
                <button
                  key={s.n}
                  type="button"
                  className={styles.tick}
                  aria-current={i === active ? "step" : undefined}
                  style={{ color: i === active ? "var(--ink)" : "var(--faint)" }}
                  onClick={() => scrollToBlock(i)}
                >
                  <span style={{ background: scenes[i].reached ? "var(--accent)" : "rgb(var(--ink-rgb) / 0.14)" }} />
                  {s.n} {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div ref={copyRef} className={styles.copy}>
          {HOW_STEPS.slice(0, SCENE_COUNT).map((s, i) => (
            <div key={s.n} data-hw={i} className={styles.block} style={{ opacity: scenes[i].copyOpacity }}>
              <span className={styles.num}>{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <div className={styles.tools}>
                {s.tools.map((t) => (
                  <code key={t}>{t}</code>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
