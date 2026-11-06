import type { Metadata } from "next";
import Link from "next/link";
import { DocsHeader } from "@/components/docs/DocsHeader";
import { DocsShell } from "@/components/docs/DocsShell";
import { CodeBlock } from "@/components/docs/CodeBlock";
import styles from "@/components/docs/Docs.module.css";
import {
  ARCHITECTURE,
  CONFIG,
  ERROR_CODES,
  FAKE_BUYER_CONTROLS,
  INVARIANTS,
  KYA_LEVELS,
  MCP_ENV,
  MCP_ERROR_CODES,
  MCP_TOOLS,
  READ_API,
  REGISTRY_RULES,
  ROLE_SCOPES,
  ROLE_COLOR,
  X402_STEPS,
} from "@/lib/content";

export const metadata: Metadata = {
  title: "Docs - CashETH",
  description: "Build spec for CashETH: connecting agents to the MCP server, its 20 tools, the read API, contracts and error codes.",
};

export default function DocsPage() {
  return (
    <>
      <DocsHeader />
      <DocsShell>
        <section id="overview" data-doc-sec="overview" className={styles.sec}>
          <span className="eyebrow" style={{ letterSpacing: "0.12em" }}>GETTING STARTED</span>
          <h1>
            Autonomous working capital on <em>Hedera</em>
          </h1>
          <p className={styles.lead}>
            A seller agent turns a buyer-agent-signed receivable into USDC working capital that its worker agents can
            spend through x402. When the buyer agent pays, lenders are repaid first, automatically.
          </p>
          <div className={styles.flow}>
            <span className={styles.chip}><small>AGENTS</small>seller · buyer · worker · lender</span>
            <span className={styles.arrow}>→</span>
            <span className={styles.chip}><small>ACCESS</small>MCP server + auth</span>
            <span className={styles.arrow}>→</span>
            <span className={styles.chip}><small>BRAIN</small>orchestrator</span>
            <span className={styles.arrow}>→</span>
            <span className={`${styles.chip} ${styles.chipOn}`}><small>HEDERA EVM</small>registry · facility · router · Aqua</span>
          </div>
          <div className={styles.callout}>
            <b>ROOT OF TRUST</b>
            <span>
              Nothing is financeable without a buyer-signed EIP-712 confirmation. Credit decisions are deterministic
              — AI explains a decision but never approves one.
            </span>
          </div>
        </section>

        <section id="quickstart" data-doc-sec="quickstart" className={styles.sec}>
          <h2>Quickstart</h2>
          <p className={styles.p}>
            Every agent needs an ECDSA secp256k1 key and a Hedera testnet account with an EVM alias. Fund accounts with
            testnet USDC from the Circle faucet, then drive all eight steps from scripted agents.
          </p>
          <CodeBlock title=".env">
{`HEDERA_OPERATOR_ID=0.0.x
HEDERA_OPERATOR_KEY=0x…            `}<span className={styles.c}># ECDSA</span>{`
COORDINATOR_KEY=0x…  COSIGNER_KEY=0x…  KYA_ISSUER_KEY=0x…
SELLER_KEY  BUYER_KEY  WORKER_RESEARCH_KEY  WORKER_COMPUTE_KEY
LENDER_A_KEY  LENDER_B_KEY  LENDER_C_KEY
HCS_AUDIT_TOPIC_ID=0.0.x
USDC_TOKEN_ID=0.0.429274
X402_FACILITATOR_URL=https://api.testnet.blocky402.com`}
          </CodeBlock>
          <CodeBlock title="terminal">
            <span className={styles.c}>$</span>{` pnpm install && pnpm -r build
`}<span className={styles.c}>$</span>{` pnpm setup:accounts            `}<span className={styles.c}># demo accounts → .env.accounts (run once)</span>{`
`}<span className={styles.c}>$</span>{` pnpm -F @casheth/merchant start   `}<span className={styles.c}># x402 merchant · :3003</span>{`
`}<span className={styles.c}>$</span>{` pnpm -F @casheth/auth start       `}<span className={styles.c}># authorization server · :4020</span>{`
`}<span className={styles.c}>$</span>{` pnpm -F @casheth/mcp start        `}<span className={styles.c}># MCP server + read API · :4030</span>{`
`}<span className={styles.c}>$</span>{` pnpm demo                         `}<span className={styles.c}># drives all eight steps</span>
          </CodeBlock>
        </section>

        <section id="connect" data-doc-sec="connect" className={styles.sec}>
          <h2>Connect an agent</h2>
          <p className={styles.p}>
            Agents reach CashETH through one MCP endpoint, <code>http://localhost:4030/mcp</code>: stateless Streamable
            HTTP, <code>POST</code> only, JSON responses, no session id. Any MCP client works; point it at the endpoint
            and it discovers the authorization server from the <code>401</code>.
          </p>
          <CodeBlock title=".mcp.json">
{`{
  "mcpServers": {
    "casheth": {
      "type": "http",
      "url": "http://localhost:4030/mcp"
    }
  }
}`}
          </CodeBlock>
          <p className={styles.p}>
            The MCP server is an OAuth 2.1 resource server. An agent signs a JWT with its ECDSA secp256k1 key and
            exchanges it (RFC 7523 JWT-bearer) at the CashETH authorization server for a 10-minute token bound to the
            MCP audience. Identity is the token&apos;s <code>agent</code> claim; role and scopes come from its{" "}
            <code>KYARegistry</code> entry. Tokens are never passed through to other services.
          </p>
          <CodeBlock title="auth flow">
{`1  POST /mcp, no token          → `}<span className={styles.w}>401</span>{` + resource_metadata
2  GET /.well-known/oauth-protected-resource/mcp
3  POST {AUTH_ISSUER}/token  grant_type=jwt-bearer  assertion=<agent JWT>  resource=…/mcp
4  ← { access_token, expires_in: 600, scope }
5  POST /mcp  Authorization: Bearer …  → `}<span className={styles.k}>200</span>
          </CodeBlock>
          <div className={styles.tableWrap}>
            <table className={styles.tableWide}>
              <thead>
                <tr>
                  <th>ROLE</th>
                  <th>SCOPES (KYA LEVEL ≥ 2)</th>
                </tr>
              </thead>
              <tbody>
                {ROLE_SCOPES.map(([role, scopes]) => (
                  <tr key={role}>
                    <td>
                      <span className={styles.role}>
                        <i style={{ background: ROLE_COLOR[role] }} />
                        {role}
                      </span>
                    </td>
                    <td className={styles.scope} style={{ whiteSpace: "normal" }}>{scopes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.callout}>
            <b>IDEMPOTENT BY DESIGN</b>
            <span>
              Every state-changing tool takes an <code>idempotencyKey</code> (8–128 chars). A repeat returns the stored
              result with <code>_meta.replayed: true</code> and no side effects; the same key with different arguments
              is <code>IDEMPOTENCY_KEY_REUSED</code>. Human MCP clients such as Claude Code can use the demo
              authorization-code grant (<code>AUTH_DEMO_GRANT=true</code>, local only).
            </span>
          </div>
        </section>

        <section id="architecture" data-doc-sec="architecture" className={styles.sec}>
          <h2>Architecture</h2>
          <p className={styles.p}>
            Everything runs on Hedera testnet, so lock and lend happen in one transaction. Off-chain trust is limited
            to the coordinator, whose every limit the contracts re-check, and the policy co-signer, which can refuse a
            payment but cannot move funds alone.
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>LAYER</th>
                  <th>COMPONENT</th>
                  <th>RESPONSIBILITY</th>
                </tr>
              </thead>
              <tbody>
                {ARCHITECTURE.map((a) => (
                  <tr key={a.component}>
                    <td className={styles.dim}>{a.layer}</td>
                    <td className={styles.mono}>{a.component}</td>
                    <td>{a.job}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="agents" data-doc-sec="agents" className={styles.sec}>
          <h2>Agents &amp; KYA</h2>
          <p className={styles.p}>
            Every agent has an ECDSA key, an HCS-14 UAID with its profile on HCS, and a <code>KYARegistry</code> entry
            holding role, level, owner-group hash, expiry and revocation.
          </p>
          <div className={styles.cards4}>
            {KYA_LEVELS.map((l) => (
              <div key={l.level} className={`${styles.card} ${l.highlight ? styles.cardOn : ""}`}>
                <span className={styles.big} style={{ color: l.color }}>{l.level}</span>
                <span>{l.text}</span>
              </div>
            ))}
          </div>
          <h3>Fake-buyer controls</h3>
          <div className={styles.rows}>
            {FAKE_BUYER_CONTROLS.map(([k, v]) => (
              <div key={k} className={styles.kv}>
                <span>{k}</span>
                <span>{v}</span>
              </div>
            ))}
          </div>
          <CodeBlock title="EIP-712 · owner → agent mandate">
            <span className={styles.k}>AgentMandate</span>{`(address agent, uint8 role, uint256 maxPerTx, uint256 maxDaily,
             address[] merchants, uint64 expiresAt, uint256 nonce)`}
          </CodeBlock>
        </section>

        <section id="receivables" data-doc-sec="receivables" className={styles.sec}>
          <h2>Receivables</h2>
          <p className={styles.p}>
            The buyer agent signs a typed confirmation whose <code>payTo</code> must equal the repayment router. Only
            commitments, amounts and states go on-chain; the invoice and its salt are shared with matched lenders only.
          </p>
          <CodeBlock title='domain "AgentReceivables" · v1 · chainId 296'>
            <span className={styles.k}>struct</span>{` ReceivableConfirmation {
    address seller;            `}<span className={styles.c}>{"// seller agent EVM address"}</span>{`
    address buyer;             `}<span className={styles.c}>{"// buyer agent (the signer)"}</span>{`
    address currency;          `}<span className={styles.c}>{"// USDC ERC-20 facade"}</span>{`
    uint256 amount;            `}<span className={styles.c}>{"// base units, 6 decimals"}</span>{`
    uint64  dueDate;
    bytes32 buyerRef;          `}<span className={styles.c}>{"// buyer's PO / AP reference"}</span>{`
    bytes32 detailsCommitment; `}<span className={styles.c}>{"// keccak256(invoiceDocHash, salt)"}</span>{`
    address payTo;             `}<span className={styles.c}>{"// MUST equal RepaymentRouter"}</span>{`
    uint256 nonce;
    uint64  deadline;
}

id = keccak256(abi.encode(buyer, buyerRef))`}
          </CodeBlock>
          <h3>State machine</h3>
          <div className={styles.states}>
            <span className={`${styles.state}`} style={{ color: "var(--muted)" }}>None</span>
            <span className={styles.arrow}>→</span>
            <span className={styles.state}>Confirmed</span>
            <span className={styles.arrow}>→</span>
            <span className={styles.state}>Financed</span>
            <span className={styles.arrow}>→</span>
            <span className={`${styles.state} ${styles.stateDone}`}>Repaid</span>
          </div>
          <div className={styles.states}>
            <span style={{ color: "var(--faint)" }}>exits</span>
            <span className={`${styles.state} ${styles.stateErr}`}>Overdue</span>
            <span className={styles.arrow}>→</span>
            <span className={`${styles.state} ${styles.stateErr}`}>Defaulted</span>
            <span className={`${styles.state} ${styles.stateMuted}`}>Cancelled · before Financed</span>
          </div>
          <h3>Registry rules</h3>
          <div className={styles.rows}>
            {REGISTRY_RULES.map(([rule, err], i) => (
              <div key={err} className={styles.rule}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                <span>{rule}</span>
                <code>{err}</code>
              </div>
            ))}
          </div>
        </section>

        <section id="facility" data-doc-sec="facility" className={styles.sec}>
          <h2>Credit facility</h2>
          <p className={styles.p}>
            One contract holds many facilities, keyed by receivable ID. <code>openAndFund</code> fills strategies
            cheapest-first and marks the ID Financed in the same transaction — any failure reverts everything.
          </p>
          <CodeBlock title="CreditFacility.sol">
            <span className={styles.k}>function</span>{` openAndFund(bytes32 id, Fill[] calldata fills, uint16 advanceBps,
                     uint256 limit, bytes calldata coordinatorSig) external onlyCoordinator;
`}<span className={styles.c}>{`// 1. registry.state(id) == Confirmed
// 2. sum(fills) <= amount * advanceBps / 1e4 and <= limit
// 3. fills sorted by aprBps ascending
// 4. router.swap(...) per fill → credit opcode → onCreditFill
// 5. registry.markFinanced(id)
// 6. HSS: markOverdue @ due+7d, markDefaulted @ due+30d`}</span>
          </CodeBlock>
          <h3>Invariants</h3>
          <div className={styles.cardsInv}>
            {INVARIANTS.map((i) => (
              <div key={i} className={styles.inv}>{i}</div>
            ))}
          </div>
        </section>

        <section id="aqua" data-doc-sec="aqua" className={styles.sec}>
          <h2>Aqua &amp; SwapVM</h2>
          <p className={styles.p}>
            We redeploy the official Aqua registry and a SwapVM router with one extra instruction.{" "}
            <code>_receivableCredit</code> runs first in each lender&apos;s program and gates every fill on the on-chain
            receivable state. USDC stays in the lender&apos;s wallet until a fill.
          </p>
          <CodeBlock title="opcodes/ReceivableCredit.sol">
{`taker == facility                       `}<span className={styles.c}>{"// only our facility can fill"}</span>{`
registry.state(id) == Confirmed         `}<span className={styles.c}>{"// the core rule"}</span>{`
dueDate - now <= maxTenorDays
advance <= maxAdvanceBps
kya.reputation(buyer).onTime >= minBuyerOnTime
makerExposure(buyer) + amount <= maxPerBuyer
`}<span className={styles.k}>→</span>{` price 1 RCN : 1 USDC, facility.onCreditFill(id, maker, amount, aprBps)`}
          </CodeBlock>
          <h3>Solver, worked example</h3>
          <div className={styles.solver}>
            <div><span>Lender A</span><span style={{ color: "var(--muted)" }}>7.00%</span><span className={styles.filled}>$4,000 filled</span></div>
            <div><span>Lender B</span><span style={{ color: "var(--muted)" }}>8.50%</span><span className={styles.filled}>$2,000 filled</span></div>
            <div style={{ color: "var(--faint)" }}><span>Lender C</span><span>13.00%</span><span style={{ textAlign: "right" }}>not needed</span></div>
          </div>
        </section>

        <section id="x402" data-doc-sec="x402" className={styles.sec}>
          <h2>x402 spending</h2>
          <p className={styles.p}>
            x402 on Hedera debits the client&apos;s own account, so a contract cannot pay directly. Each worker pays
            from a spend wallet with a 2-of-2 threshold key — worker plus policy co-signer — that holds zero balance
            between payments.
          </p>
          <div className={styles.cardsX402}>
            {X402_STEPS.map((s) => (
              <div key={s.label} className={styles.card}>
                <span className={styles.step} style={{ color: s.accent ? "var(--accent)" : "var(--muted)" }}>{s.label}</span>
                <span>{s.body}</span>
              </div>
            ))}
          </div>
          <CodeBlock title="merchant · paid research API">
{`GET /research?topic=…
`}<span className={styles.w}>402 Payment Required</span>{`
  network   hedera:testnet
  asset     0.0.429274 (USDC)
  amount    250000           `}<span className={styles.c}># $0.25</span>{`
  payTo     0.0.…  feePayer  facilitator`}
          </CodeBlock>
          <h3 className={styles.h3}>External x402 merchants</h3>
          <p className={styles.p}>
            Workers can buy from any x402 merchant through the same reserve → <code>pay_x402</code> → commit flow and
            guardrails. Nothing is trusted from a merchant&apos;s catalogue: the MCP server fetches only origins listed
            in <code>MERCHANT_ORIGINS</code>, the seller&apos;s budget must allow the payee, and the co-signer signs only
            when the 402&apos;s <code>payTo</code> equals the reservation&apos;s merchant. A rogue payee is refused as{" "}
            <code>COSIGNER_REFUSED</code> and recorded as <code>SpendRejected</code>.
          </p>
        </section>

        <section id="waterfall" data-doc-sec="waterfall" className={styles.sec}>
          <h2>Repayment waterfall</h2>
          <p className={styles.p}>
            Partial payments go to lenders first. A payment after a default still reaches lenders first. Spending stops
            at the due date; overdue and default checks are scheduled through HSS and are also permissionless.
          </p>
          <div className={styles.formula}>
            <div><b>fee_i</b>     = principal_i × apr_i × max(elapsed, minTerm) / 365d</div>
            <div><b>lenderDue</b> = Σ (principal_i + fee_i)</div>
            <div><b>payment</b>   → lenders pro rata → seller remainder</div>
          </div>
          <div className={styles.ledger}>
            <div><span>Receivable · Net 30 · 75% advance</span><span>$10,000.00</span></div>
            <div><span>Funded · A $4,000 @ 7% + B $2,000 @ 8.5%</span><span>$6,000.00</span></div>
            <div><span>Fees · A $23.01 + B $13.97</span><span>$36.99</span></div>
            <div className={styles.hl}><span>Lenders receive</span><span>$6,036.99</span></div>
            <div className={styles.hl}><span style={{ color: "var(--ink)" }}>Seller agent receives</span><span style={{ color: "var(--ink)" }}>$3,963.01 + undrawn</span></div>
          </div>
        </section>

        <section id="mcp" data-doc-sec="mcp" className={styles.sec}>
          <span className="eyebrow" style={{ letterSpacing: "0.12em" }}>REFERENCE</span>
          <h2>MCP tools</h2>
          <p className={styles.p}>
            {MCP_TOOLS.length} tools. Each checks the token&apos;s scope, then its role, then that the caller is the
            right party; a failure is a tool result with a <code>code</code>, not an HTTP error. Every result is one
            JSON text item. Mutating tools also take an <code>idempotencyKey</code>. Tools that need an agent&apos;s own
            key return calldata for the agent to sign unless the demo key flags are on.
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.tableWide}>
              <thead>
                <tr>
                  <th>TOOL</th>
                  <th>ROLE</th>
                  <th>SCOPE</th>
                  <th>EFFECT</th>
                </tr>
              </thead>
              <tbody>
                {MCP_TOOLS.map((t) => (
                  <tr key={t.name}>
                    <td className={styles.tool}>{t.name}</td>
                    <td>
                      {t.roles.map((role) => (
                        <span key={role} className={styles.role}>
                          <i style={{ background: ROLE_COLOR[role] }} />
                          {role}
                        </span>
                      ))}
                    </td>
                    <td className={styles.scope}>{t.scope}</td>
                    <td className={styles.effect}>{t.effect}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="read-api" data-doc-sec="read-api" className={styles.sec}>
          <h2>Read API</h2>
          <p className={styles.p}>
            The same server answers unauthenticated <code>GET</code> requests on <code>http://localhost:4030</code> for
            dashboards, including the admin console at <code>/admin</code>. It returns only hashes, addresses, amounts and
            states. Amounts are USDC base units as strings (6 decimals: <code>&quot;250000&quot;</code> is $0.25). Browser
            origins must be listed in <code>CORS_ORIGINS</code>.
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.tableWide}>
              <thead>
                <tr>
                  <th>ENDPOINT</th>
                  <th>RETURNS</th>
                </tr>
              </thead>
              <tbody>
                {READ_API.map((r) => (
                  <tr key={r.path}>
                    <td className={styles.tool}>
                      {r.method} {r.path}
                    </td>
                    <td className={styles.effect}>{r.returns}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CodeBlock title="GET /events · one AuditEvent">
{`{
  "v": 1, "type": "SpendCommitted", "seq": 42, "prevSeq": 41,
  "ts": "2026-11-07T12:04:31.000Z",
  "id": "0x…",                 `}<span className={styles.c}># receivable id</span>{`
  "spendId": "0x…", "amount": "800000", "merchant": "0.0.…",
  "agent": "0x…",              `}<span className={styles.c}># the calling agent</span>{`
  "hashscan": "https://hashscan.io/testnet/transaction/…",
  "hcsSeq": 214                `}<span className={styles.c}># same message on the HCS audit topic</span>{`
}`}
          </CodeBlock>
        </section>

        <section id="errors" data-doc-sec="errors" className={styles.sec}>
          <h2>Error codes</h2>
          <p className={styles.p}>
            The same names are used by the engine, the contracts and the MCP server, so a rejection reads the same
            wherever it is caught.
          </p>
          <div className={styles.errs}>
            {ERROR_CODES.map(([code, layer]) => (
              <div key={code} className={styles.err}>
                <code>{code}</code>
                <span>{layer}</span>
              </div>
            ))}
          </div>
          <p className={styles.p}>
            A contract revert outside this list is <code>CONTRACT_REVERTED</code>. The MCP server adds its own codes:
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.tableWide}>
              <thead>
                <tr>
                  <th>CODE</th>
                  <th>MEANING</th>
                </tr>
              </thead>
              <tbody>
                {MCP_ERROR_CODES.map(([code, meaning]) => (
                  <tr key={code}>
                    <td className={styles.tool}>{code}</td>
                    <td className={styles.effect}>{meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="config" data-doc-sec="config" className={styles.sec}>
          <h2>Configuration</h2>
          <div className={styles.rows}>
            {CONFIG.map(([k, v]) => (
              <div key={k} className={styles.cfg}>
                <span>{k}</span>
                <code>{v}</code>
              </div>
            ))}
          </div>
          <h3 className={styles.h3}>MCP server environment</h3>
          <div className={styles.tableWrap}>
            <table className={styles.tableWide}>
              <thead>
                <tr>
                  <th>VARIABLE</th>
                  <th>DEFAULT</th>
                  <th>USE</th>
                </tr>
              </thead>
              <tbody>
                {MCP_ENV.map(([name, dflt, use]) => (
                  <tr key={name}>
                    <td className={styles.tool}>{name}</td>
                    <td className={styles.scope}>{dflt}</td>
                    <td className={styles.effect}>{use}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.p}>Contract addresses are read from deployments/testnet/addresses.json on every call, never hard-coded.</p>
          <Link href="/" className={styles.back}>
            <span>
              <small>BACK TO</small>
              <b>Overview</b>
            </span>
            <span>↑</span>
          </Link>
        </section>
      </DocsShell>
    </>
  );
}
