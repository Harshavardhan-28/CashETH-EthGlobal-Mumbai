import a from "@/components/admin/Admin.module.css";
import { Avatar, ROLE_COLOR, jobOf } from "@/components/admin/primitives";
import type { AgentStats, LenderYield } from "@/lib/admin/api";
import { formatUsdc, initials, shortAddress } from "@/lib/admin/format";
import { formatHbar, type Wallet } from "@/lib/dashboard/live";
import d from "./Dashboard.module.css";
import { Icons } from "./parts";

type Props = { me: AgentStats; lenders: LenderYield[]; wallet: Wallet; sample: boolean; lastAction?: string; onSwitch(): void };

/** Who the agent is (KYA identity) next to what its wallet holds right now, read from the Hedera mirror node. */
export function Identity({ me, lenders, wallet, sample, lastAction, onSwitch }: Props) {
  const name = me.label || shortAddress(me.address);
  const lender = lenders.find((l) => l.address.toLowerCase() === me.address.toLowerCase());
  const account = wallet.accountId ?? me.address;
  const walletNote = sample ? "Sample data: no live wallet read" : wallet.status === "loading" ? "Reading the Hedera mirror node…" : wallet.status === "error" ? "Mirror node unavailable" : undefined;

  return (
    <section className={`${a.card} ${d.identity}`} aria-label="Agent">
      <div className={d.idMain}>
        <Avatar actor={{ name, role: me.role, initials: initials(name) }} size={52} />
        <div style={{ minWidth: 0 }}>
          <div className={d.idName}>
            {name}
            <span className={d.rolePill} style={{ background: ROLE_COLOR[me.role] }}>
              {me.role}
            </span>
          </div>
          <div className={d.idJob}>{jobOf(me.role, lender)}</div>
          <div className={d.idFacts}>
            <span>
              Address <b className={a.mono}>{shortAddress(me.address)}</b>
            </span>
            <span>
              KYA <b>level {me.level}</b>
            </span>
            <span>
              Trust score <b>{Math.round(me.score)} / 100</b>
            </span>
            {lastAction && (
              <span>
                Last MCP call <b>{lastAction}</b>
              </span>
            )}
            <span title={me.uaid}>
              UAID <b className={a.mono}>{me.uaid.length > 28 ? `${me.uaid.slice(0, 26)}…` : me.uaid}</b>
            </span>
            <button type="button" className={a.link} onClick={onSwitch}>
              Switch agent
            </button>
          </div>
        </div>
      </div>
      <div className={d.wallet}>
        <div className={d.walletLabel}>
          <span className={a.kpiIcon}>
            <Icons.wallet />
          </span>
          Wallet balance
        </div>
        <div className={d.walletUsdc} data-testid="wallet-usdc">
          {formatUsdc(wallet.usdc)}
          <small>USDC</small>
        </div>
        <div className={d.walletMeta}>
          <span>{formatHbar(wallet.hbar)} for gas</span>
          {walletNote ? (
            <span>{walletNote}</span>
          ) : (
            <a href={`https://hashscan.io/testnet/account/${account}`} target="_blank" rel="noopener noreferrer">
              {wallet.accountId ?? "Account"} on HashScan ↗
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
