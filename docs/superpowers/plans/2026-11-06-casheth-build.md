# CashETH Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build CashETH end to end on Hedera testnet: a seller agent turns a buyer-signed EIP-712 receivable into USDC working capital funded through a redeployed 1inch Aqua + modified SwapVM (one new credit opcode), worker agents spend it through real x402 payments, and the buyer's repayment pays lenders first. Nothing mocked on the demo path.

**Architecture:** One Foundry project holds our five core contracts plus the modified SwapVM router and credit opcode (1inch aqua and swap-vm vendored as pinned git submodules). One pnpm TypeScript monorepo holds shared types/ABIs, a Hedera package (viem for EVM, Hiero SDK for HTS/HCS/accounts, x402 client), an Aqua package (order builder, ship, solver), a deterministic engine (score, spend policy, co-signer policy, event store), an x402 merchant, an OAuth 2.1 authorization server with KYA, an MCP server exposing the agent tools, scripted agents, and a one-page dashboard. Every checkpoint ends with a gate that is verified on testnet and committed.

**Tech Stack:** Solidity 0.8.30 (via_ir, evm prague) + Foundry; swap-vm `f9f4acfed0ffa321c2108efe05ecf7a5e0bd8abc`, aqua `86abe30fa39f757a98fd0f917524035626ebf6f8`, solidity-utils `v7.0.3`, openzeppelin-contracts `v5.6.1`, forge-std `v1.11.0`. Node 22, pnpm, TypeScript, tsx, vitest, viem 2.x, `@hiero-ledger/sdk` 2.90.1, `@x402/core` + `@x402/hedera` + `@x402/express` + `@x402/fetch` 2.30.0, `@1inch/aqua-sdk` 0.4.0, `@modelcontextprotocol/sdk` 1.32.2, express 5, jose 6, `@hashgraph/hedera-agent-kit` 4.2.0, `@hashgraphonline/standards-sdk` 0.1.192 (HCS-14), `@anthropic-ai/sdk` (explain_decision only).

**Spec:** `BUILD.md` (repo root). This plan implements it with the decisions recorded under "Decisions made in this plan".

## Global Constraints

- Hedera testnet only: EVM chain ID `296`, JSON-RPC `https://testnet.hashio.io/api`, mirror node `https://testnet.mirrornode.hedera.com/api/v1`, explorer `https://hashscan.io/testnet`.
- USDC is HTS `0.0.429274`, EVM facade `0x0000000000000000000000000000000000068cda`, 6 decimals. Every contract that receives USDC calls `IHRC719(USDC).associate()` in its constructor.
- x402: scheme `exact`, network `hedera:testnet`, facilitator `https://x402.org/facilitator` (fee payer `0.0.9185802`); fallbacks `https://api.testnet.blocky402.com`, `https://testnet.facilitator.launa.dev`. Merchant price `0.25` USDC = `250000` units.
- HSS system contract `0x16b`: `scheduleCall(address,uint256,uint256,uint64,bytes) returns (int64,address)`; SUCCESS is `22`; horizon 62 days; the scheduling contract pays, so it must hold HBAR.
- Never `delegatecall` a system contract. Never use `block.number`. All time logic uses `block.timestamp`.
- Error names are identical in contracts, engine and MCP: `DUPLICATE_RECEIVABLE, BAD_BUYER_SIG, WRONG_PAYEE, BAD_NONCE, TERM_INELIGIBLE, KYA_FAIL, SELF_DEALING, NOT_CONFIRMED, BORROWING_BASE_EXCEEDED, NOT_CHEAPEST_FIRST, AGENT_BUDGET_EXCEEDED, TX_LIMIT_EXCEEDED, DAILY_LIMIT_EXCEEDED, MERCHANT_NOT_ALLOWED, GLOBAL_CREDIT_LIMIT_EXCEEDED, RESERVATION_EXPIRED, FACILITY_NOT_ACTIVE, PAUSED, INSUFFICIENT_SCOPE, KYA_LEVEL_TOO_LOW` plus `BAD_CURRENCY, BAD_STATE, FILL_MISMATCH, SCHEDULE_FAILED, RCN_TRANSFER_RESTRICTED` added here.
- Secrets live only in `.env` (gitignored). `.env.example` documents every variable. Keys never reach the browser.
- Commits: small, one per gate or sub-gate, conventional subject (`feat(contracts): ...`), **no Co-Authored-By trailer**. The 1inch track reads the commit history.
- AI never approves credit. `explain_decision` narrates a deterministic decision object and nothing else.
- EIP-712 domain for receivables: name `AgentReceivables`, version `1`, chainId = `block.chainid`, verifyingContract = `ReceivableRegistry`.
- Demo amounts (scaled to the testnet USDC we hold): receivable `10 USDC`, lenders A `4 USDC @ 700 bps`, B `2 USDC @ 850 bps`, C `3 USDC @ 1300 bps` (never filled), advance `7500 bps`, budgets research `1.0`, compute `3.0`, data `1.0`, reserve `1.0`, x402 payment `0.25`, rejected compute request `5.5`, minimum fee term `30 days`. Expected lender due on repayment: A `23013` + B `13972` fee units, total `6036985` units.

## Decisions made in this plan

- D-P1 All TypeScript, one pnpm workspace. BUILD.md's Python engine is replaced by `packages/engine` (TS). Same rules, same error codes.
- D-P2 One Foundry project `contracts/` with `lib/` submodules (`swap-vm`, `aqua`, `solidity-utils`, `openzeppelin-contracts`, `forge-std`) at the pins above. We never patch submodules; our opcode uses the free slot `Opcode._21` from `OpcodeList.sol` and our router overrides `_runOpcode`.
- D-P3 Order, maker-traits and taker-traits bytes are always produced on-chain by `CashEthOrderBuilder` (pure) using the pinned swap-vm libraries, and read by TypeScript through `eth_call`. The published `@1inch/swap-vm-sdk` targets the deployed v1.0.2 opcode table, which differs from the pinned source, so it is not used for bytecode. `@1inch/aqua-sdk` is used for `ship`/`dock` calldata and `Shipped` event decoding only.
- D-P4 Unit tests run on plain Foundry with `MockUSDC` (6 decimals, ERC-20 + a no-op `associate()`) and a `MockHSS` etched at `0x16b`. HTS facade and HSS behaviour are proven on testnet by the Phase 0 spikes and the deploy scripts, not by `hedera-forking`.
- D-P5 `openAndFund` is `onlyCoordinator`; the separate coordinator signature from BUILD.md §7.4 is dropped because the coordinator is `msg.sender`.
- D-P6 `KYARegistry`, `ReceivableRegistry`, `ReceivableCreditNote`, `CreditFacility` each expose a one-time `wire(...)` (owner only) to resolve the circular addresses; `CashEthSwapVMRouter` takes `registry`, `kya`, `facility` as constructor immutables and is deployed last.
- D-P7 JWT-bearer assertions are real JWTs signed `ES256K` with the agent's secp256k1 key (jose), carrying the public key in the `jwk` header; the AS checks `keccak(pubkey)[12:] == iss`. Access tokens are `ES256` JWTs from the AS, audience = MCP resource URL, 10 minutes.
- D-P8 The auth-code + PKCE path exists for human MCP clients but has no real owner login: `/authorize` shows the registered agents and a Grant button. Documented as demo-only.
- D-P9 Spend wallets are Hedera accounts with a 2-of-2 `KeyList` {worker key, co-signer key}. The x402 client signer is a wrapper that lets the default `@x402/hedera` signer sign with the worker key, then the co-signer policy adds the second signature before the request is retried. Fallback if spike S3 fails with threshold keys: single-key spend wallet funded just in time.
- D-P10 Large-contract deployment: `forge script` through Hashio first; if the router creation transaction is rejected for size, deploy that one contract with the Hiero SDK `ContractCreateFlow`.
- D-P11 HCS-14 UAIDs are produced with `@hashgraphonline/standards-sdk` (`hcs-14` module). Agent profiles are published to the same HCS audit topic.
- D-P12 Hedera Agent Kit is used by the agents for HCS message submission and token association (tools executed directly, no LLM framework). If the kit cannot execute tools without a framework, the implementer records that in the task and falls back to the Hiero SDK for that call, keeping the kit import for the HCS audit hook.

## Review Focus

1. A buyer signs a confirmation, then the seller submits it twice in the same block: the second `register` must revert `DUPLICATE_RECEIVABLE` and the first must stand. (Task 2.3)
2. A lender ships a strategy with virtual balance 4 USDC but only 1 USDC real balance or allowance: the solver must skip it and, if forced, `openAndFund` must revert as a whole with no partial funding. (Tasks 4.4, 4.5)
3. A worker reservation expires while the x402 request is in flight: `commit` after `expiry` must revert `RESERVATION_EXPIRED`, `release` must pull the USDC back, and the co-signer must refuse a second payment for the same `spendId`. (Tasks 3.4, 5.3)
4. The buyer repays after `markDefaulted`: lenders are paid first, state moves `Defaulted → Repaid`, and the seller gets the remainder. (Task 3.5)
5. An access token issued for `https://other.example/mcp` is presented to our MCP server: it must be rejected with `401 invalid_token`, never accepted because the signature verifies. (Task 6.2)

---

## Checkpoint map

| Checkpoint | Gate (verified before commit) | Commits |
|---|---|---|
| C0 Scaffold + accounts | `pnpm -r build` and `forge build` pass; demo accounts exist on testnet with HBAR and USDC; `docs/EVIDENCE.md` skeleton | 2 |
| C1 Spikes | S1 Aqua + unmodified router on testnet with one XYC fill moving HTS USDC; S2 contract associate + transferFrom through the facade; S3 x402 0.25 USDC settled, then from a 2-of-2 account; S4 contract self-schedules and the call executes; S5 USDC funding plan confirmed | 5 |
| C2 Identity + registry | KYA and receivable registries deployed; register, duplicate, bad sig, wrong payee, self-dealing all behave; NFT and HCS links in EVIDENCE | 4 |
| C3 Facility + repayment | RCN, facility, router deployed; mock-fill funding, budgets, reserve/commit/release, waterfall, HSS checks; fuzz + invariants pass | 5 |
| C4 Modified SwapVM + Aqua | Credit opcode router deployed; three lender strategies shipped; `openAndFund` fills A and B cheapest-first in one tx; unconfirmed id and foreign taker revert | 5 |
| C5 x402 spending | Merchant live; spend wallets; worker pays 0.25 USDC with no human; 5.5 request rejected by engine and contract; expired reservation released | 5 |
| C6 Auth + MCP | 401 with resource metadata; level-1 agent cannot confirm; wrong-audience token rejected; all tools work end to end | 4 |
| C7 Agents + demo | `pnpm demo` runs all eight steps from agents alone and writes EVIDENCE | 3 |
| C8 Dashboard + docs | Rail, evidence links, waterfall; README with settled Hedera tx id; video script | 3 |

---

## Repository layout

```
contracts/                      Foundry
  foundry.toml  remappings.txt
  lib/{forge-std,openzeppelin-contracts,solidity-utils,aqua,swap-vm}   (submodules)
  src/core/{KYARegistry,ReceivableRegistry,ReceivableCreditNote,CreditFacility,RepaymentRouter}.sol
  src/core/interfaces/{IKYARegistry,IReceivableRegistry,ICreditFacility,IReceivableCreditNote}.sol
  src/core/libs/CashEthTraits.sol
  src/hedera/{IHRC719,IHederaScheduleService,HederaResponseCodes}.sol
  src/aqua/{ReceivableCredit,CashEthSwapVMRouter,CashEthOrderBuilder}.sol
  src/spikes/{AssocProbe,AlarmProbe}.sol
  test/mocks/{MockUSDC,MockHSS,MockSwapRouter}.sol
  test/{KYARegistry,ReceivableRegistry,ReceivableCreditNote,CreditFacility,RepaymentRouter,ReceivableCredit,CashEthSwapVMRouter}.t.sol
  test/invariants/FacilityInvariants.t.sol
  script/{00_DeployAquaSpike,01_DeployCore,02_DeployAquaRouter,03_Wire}.s.sol
packages/shared     @casheth/shared     env, addresses, ABIs, EIP-712 types, error codes, hashscan helpers
packages/hedera     @casheth/hedera     viem clients, Hiero SDK helpers, accounts, HCS, NFT, HCS-14, x402 client signer
packages/aqua       @casheth/aqua       order builder calls, ship/dock, strategy discovery, solver
packages/engine     @casheth/engine     score, borrowing base, spend policy, co-signer policy, event store, idempotency
apps/merchant       @casheth/merchant   x402 research API
apps/auth-server    @casheth/auth       OAuth 2.1 AS with KYA
apps/mcp-server     @casheth/mcp        MCP tools + orchestrator wiring
apps/web            @casheth/web        dashboard (Vite + React)
agents/             @casheth/agents     seller, buyer, worker, lender, demo runner
scripts/            account setup, funding, sweep, abi sync
docs/               EVIDENCE.md, superpowers/
```

---

# Checkpoint C0: Scaffold and testnet accounts

### Task 0.1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.nvmrc` (`22`), `.editorconfig`, `README.md` (title + one paragraph + layout), `.env.example`
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts,src/env.ts,src/errors.ts,src/hashscan.ts}`
- Create: `packages/{hedera,aqua,engine}/{package.json,tsconfig.json,src/index.ts}`, `apps/{merchant,auth-server,mcp-server}/{package.json,tsconfig.json,src/index.ts}`, `agents/{package.json,tsconfig.json,src/index.ts}`
- Create: `contracts/foundry.toml`, `contracts/remappings.txt`, `contracts/.gitignore`
- Test: `packages/shared/src/env.test.ts`, `packages/shared/src/errors.test.ts`

**Interfaces:**
- Produces: `loadEnv(): Env` (zod-validated, reads repo-root `.env`; fields: `HEDERA_NETWORK, HEDERA_CHAIN_ID, HEDERA_JSON_RPC_URL, HEDERA_MIRROR_NODE_URL, HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY, MERCHANT_ACCOUNT_ID, MERCHANT_KEY, USDC_TOKEN_ID, USDC_EVM_ADDRESS, X402_FACILITATOR_URL, X402_NETWORK`, all later variables optional).
- Produces: `ErrorCode` string-literal union of the Global Constraints list; `isErrorCode(s): s is ErrorCode`.
- Produces: `hashscan.tx(txId)`, `hashscan.contract(addr)`, `hashscan.account(id)`, `hashscan.token(id)`, `hashscan.topic(id)`, `hashscan.schedule(id)` returning `https://hashscan.io/testnet/...` URLs.

- [ ] **Step 1: Write failing tests** `env.test.ts`: `loadEnv throws when HEDERA_OPERATOR_KEY missing`, `loadEnv parses chain id 296 as number`; `errors.test.ts`: `isErrorCode('DUPLICATE_RECEIVABLE') is true`, `isErrorCode('nope') is false`.
- [ ] **Step 2: Run** `pnpm -F @casheth/shared test` → FAIL (modules missing).
- [ ] **Step 3: Implement** workspace files. Root scripts: `build` (`pnpm -r build`), `test` (`pnpm -r test`), `lint` (`tsc -b`). `foundry.toml`: `solc = "0.8.30"`, `via_ir = true`, `evm_version = "prague"`, `optimizer_runs = 600`, `src = "src"`, `test = "test"`, `libs = ["lib"]`, profile `[rpc_endpoints] testnet = "${HEDERA_JSON_RPC_URL}"`. `remappings.txt`: `forge-std/=lib/forge-std/src/`, `@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/`, `@1inch/solidity-utils/=lib/solidity-utils/`, `@1inch/aqua/=lib/aqua/`, `@1inch/swap-vm/=lib/swap-vm/`.
- [ ] **Step 4: Add submodules** `git submodule add` forge-std@v1.11.0, openzeppelin-contracts@v5.6.1, solidity-utils@v7.0.3, aqua@86abe30f, swap-vm@f9f4acfe into `contracts/lib/` and `forge build` → PASS (swap-vm and aqua compile under our profile; if a library path differs, fix remappings, never edit submodules).
- [ ] **Step 5: Run** `pnpm install && pnpm -r build && pnpm -F @casheth/shared test` → PASS.
- [ ] **Step 6: Commit** `chore: scaffold pnpm workspace and foundry project with pinned 1inch submodules`

### Task 0.2: Testnet demo accounts and funding scripts

**Files:**
- Create: `packages/hedera/src/{client.ts,accounts.ts,tokens.ts,mirror.ts}`, `scripts/setup-accounts.ts`, `scripts/sweep-usdc.ts`, `docs/EVIDENCE.md`
- Test: `packages/hedera/src/mirror.test.ts` (live mirror-node read of `0.0.11333252`, asserts ECDSA key type)

**Interfaces:**
- Produces: `hieroClient(env): Client` (testnet, operator set, ECDSA), `evmClients(env, privateKey?): { public: PublicClient, wallet?: WalletClient }` (viem, chain 296 custom chain object `hederaTestnet`).
- Produces: `createEcdsaAccount(client, { initialHbar: number, label: string }): Promise<{ accountId: string, evmAddress: 0x…, privateKey: 0x… }>` using `AccountCreateTransaction.setECDSAKeyWithAlias` and `setMaxAutomaticTokenAssociations(10)`.
- Produces: `associateUsdc(client, accountId, privateKey)`, `transferUsdc(client, from, fromKey, to, units: bigint): Promise<txId>`.
- Produces: `mirror.account(idOrEvm)`, `mirror.tokenBalance(accountId, tokenId): bigint`, `mirror.txByHash(evmHash)` → `{ transactionId, status, hashscanUrl }`.
- Produces: `.env.accounts` (gitignored) written by `setup-accounts.ts` with `SELLER_ID/KEY, BUYER_ID/KEY, WORKER_RESEARCH_ID/KEY, WORKER_COMPUTE_ID/KEY, LENDER_A_ID/KEY, LENDER_B_ID/KEY, LENDER_C_ID/KEY, COORDINATOR_ID/KEY, COSIGNER_ID/KEY, KYA_ISSUER_ID/KEY` and the EVM address for each. `loadEnv()` merges `.env.accounts`.

- [ ] **Step 1: Write failing test** `mirror.test.ts`: `mirror.account('0.0.11333252') returns key._type ECDSA_SECP256K1`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the four modules and `setup-accounts.ts` (creates the ten accounts with 20 HBAR each, associates USDC, funds: lenderA 4 USDC, lenderB 2 USDC, lenderC 1 USDC from the operator; buyer 10 USDC from the merchant account; skips accounts already present in `.env.accounts`). `sweep-usdc.ts` moves all demo-account USDC back to the operator.
- [ ] **Step 4: Run** `pnpm tsx scripts/setup-accounts.ts` on testnet. Verify every account on the mirror node has ≥ 19 HBAR and the USDC balances above. Append the account ids as HashScan links to `docs/EVIDENCE.md` under "Accounts".
- [ ] **Step 5: Run** `pnpm -F @casheth/hedera test` → PASS.
- [ ] **Step 6: Commit** `feat(hedera): account, token and mirror helpers; testnet demo account setup`

---

# Checkpoint C1: Feasibility spikes (all on testnet)

### Task 1.1: S1 Aqua registry + unmodified AquaSwapVMRouter on Hedera with one XYC fill

**Files:**
- Create: `contracts/script/00_DeployAquaSpike.s.sol`, `contracts/src/spikes/SpikeTaker.sol`, `scripts/spikes/s1-aqua-xyc.ts`
- Modify: `docs/EVIDENCE.md`

**Interfaces:**
- Produces: `deployments/testnet/spike-aqua.json` with `aqua`, `router`, `taker` addresses; the proven deploy path (forge script or `ContractCreateFlow`) recorded in the task result for Task 4.3.
- `SpikeTaker` is a minimal contract that calls `router.swap(order, amount, takerData)` with `useTransferFromAndAquaPush = true`, holding the tokenIn.

- [ ] **Step 1: Deploy** `AquaRouter(owner)` and `AquaSwapVMRouter(aqua, WHBAR=0xb1F616b8134F602c3Bb465fB5b5e6565cCAd37Ed, owner, "CashETH SwapVM", "1.0.0")` with `forge script … --rpc-url testnet --broadcast --legacy`. If the router creation is rejected for size, deploy it with the Hiero SDK `ContractCreateFlow` from `scripts/spikes/s1-deploy-flow.ts` and record which path worked.
- [ ] **Step 2: Ship** from lender A: approve Aqua for USDC via the facade, build an XYC order (Salt + DynamicBalances is not needed on the Aqua path; use `XYCSwap` only) through a tiny pure helper in the spike script by calling `MakerTraitsLib.build` from a spike builder contract, `ship(router, abi.encode(order), [USDC, TOKENB], [1 USDC, 1 TOKENB])` where `TOKENB` is a 6-decimal `MockUSDC` deployed for the spike.
- [ ] **Step 3: Fill** from `SpikeTaker` for `0.1 TOKENB → USDC`. Verify on the mirror node that lender A's USDC decreased and the taker's increased.
- [ ] **Step 4: Record** tx ids and HashScan links in `docs/EVIDENCE.md` under "Spike S1". If any step fails, record the exact error and stop the plan here for a decision (the fallback in BUILD.md §14 Phase 0 applies).
- [ ] **Step 5: Commit** `spike(aqua): deploy official Aqua + SwapVM router on Hedera testnet and fill one XYC strategy`

### Task 1.2: S2 HTS facade from a contract (associate, approve, transferFrom)

**Files:**
- Create: `contracts/src/hedera/IHRC719.sol` (`associate() returns (uint256)`, `isAssociated() returns (bool)`), `contracts/src/spikes/AssocProbe.sol`, `scripts/spikes/s2-facade.ts`

- [ ] **Step 1: Implement** `AssocProbe` whose constructor calls `IHRC719(usdc).associate()`, with `pull(address from, uint256 amount)` doing `IERC20(usdc).transferFrom(from, address(this), amount)` and `push(address to, uint256 amount)` doing `transfer`.
- [ ] **Step 2: Run** deploy, approve the probe from the operator via the facade (`approve(probe, 1 USDC)` through viem), call `pull(operator, 0.5 USDC)`, then `push(operator, 0.5 USDC)`. Verify balances on the mirror node and that `isAssociated()` returns true.
- [ ] **Step 3: Record** links in EVIDENCE under "Spike S2". Note the gas used for `associate()` in the constructor (needed for deploy gas limits).
- [ ] **Step 4: Commit** `spike(hedera): prove HTS facade associate/approve/transferFrom from a contract`

### Task 1.3: S3 x402 payment of 0.25 USDC, single key then 2-of-2 threshold account

**Files:**
- Create: `apps/merchant/src/{server.ts,index.ts}`, `packages/hedera/src/x402/{client.ts,cosignedSigner.ts}`, `scripts/spikes/s3-x402.ts`
- Test: `packages/hedera/src/x402/cosignedSigner.test.ts`

**Interfaces:**
- Produces (merchant): Express 5 app, `GET /research?topic=` behind `@x402/express` `paymentMiddleware` configured with `x402ResourceServer(new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL }))` and `ExactHederaScheme({ defaultAssets: { 'hedera:testnet': { asset: '0.0.429274', decimals: 6 } } })`, price `"0.25"`, `payTo = MERCHANT_ACCOUNT_ID`. Response JSON `{ topic, summary, sources[], paidWith: { transactionId } }` where `transactionId` is read from the settlement header.
- Produces: `createCosignedHederaSigner({ accountId, workerKey, cosign: (txBase64, requirements) => Promise<string> }): ClientHederaSigner` that calls `createClientHederaSigner(accountId, workerKey, { network })`, then passes the base64 to `cosign`, which returns the base64 with the second signature added (`Transaction.fromBytes` → `.sign(cosignerKey)` → `toBytes`).
- Produces: `payX402(fetchImpl, url, signer): Promise<{ status, body, transactionId }>` using `wrapFetchWithPayment` from `@x402/fetch` with `x402Client().register('hedera:*', new ExactHederaScheme(signer))`.

- [ ] **Step 1: Write failing test** `cosignedSigner.test.ts`: `cosigned signer output carries two signatures for a 2-of-2 key list` (build a `TransferTransaction` with a fake node account list via `setNodeAccountIds`, freeze, run the signer wrapper with two generated ECDSA keys, assert `tx.getSignatures()` has two entries).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** merchant and signer. Start the merchant locally on port `4021`.
- [ ] **Step 4: Run** `s3-x402.ts` part A: pay from `WORKER_RESEARCH` (single key). Expect HTTP 200 and a settlement `transactionId`; verify the 0.25 USDC transfer on the mirror node.
- [ ] **Step 5: Run** part B: create a 2-of-2 account `KeyList([workerPub, cosignerPub], 2)` with `setKeyWithoutAlias`, associate USDC (both keys sign), fund it 0.5 USDC, pay with the co-signed signer. Expect 200. If the facilitator rejects the threshold signature, retry against the two fallback facilitators; if all reject, record the failure and switch this plan to the single-key fallback (D-P9) in Tasks 5.1–5.3.
- [ ] **Step 6: Record** both transaction ids in EVIDENCE under "Spike S3" (this is the headline x402 evidence) and `pnpm -F @casheth/hedera test` → PASS.
- [ ] **Step 7: Commit** `spike(x402): merchant endpoint and co-signed worker payment settled on Hedera testnet`

### Task 1.4: S4 HSS self-scheduled contract call

**Files:**
- Create: `contracts/src/hedera/IHederaScheduleService.sol` (only `scheduleCall`, `hasScheduleCapacity`, `deleteSchedule(address)`), `contracts/src/hedera/HederaResponseCodes.sol` (`SUCCESS = 22`), `contracts/src/spikes/AlarmProbe.sol`, `scripts/spikes/s4-hss.ts`

- [ ] **Step 1: Implement** `AlarmProbe` with `payable constructor`, `schedule(uint256 delaySeconds)` calling `IHederaScheduleService(0x16b).scheduleCall(address(this), block.timestamp + delaySeconds, 200_000, 0, abi.encodeCall(this.ring, (nonce)))`, `ring(uint256)` emitting `Rang(nonce, block.timestamp)` and `rings` counter, `cancel(address schedule)` calling `deleteSchedule`.
- [ ] **Step 2: Run** deploy with 5 HBAR, `schedule(90)`, poll the mirror node for the `Rang` log for up to 4 minutes. Expect `rings == 1`. Then `schedule(600)` and `cancel(scheduleAddress)` to prove deletion.
- [ ] **Step 3: Record** schedule entity ids and the executed call in EVIDENCE under "Spike S4".
- [ ] **Step 4: Commit** `spike(hss): contract schedules and executes a call to itself via HIP-1215`

### Task 1.5: S5 USDC funding plan

- [ ] **Step 1: Verify** mirror-node USDC balances after Tasks 1.1–1.3 and compute what the full demo needs (lenders 6, buyer 10, spend 0.25 + slack). If short, run `scripts/sweep-usdc.ts` to consolidate and re-run the funding part of `setup-accounts.ts`; if still short, write the exact faucet instruction (`https://faucet.circle.com`, Hedera Testnet, account id to fund) into `docs/EVIDENCE.md` "Funding" and the final message to the user.
- [ ] **Step 2: Commit** `docs: spike evidence and USDC funding notes`

---

# Checkpoint C2: Identity and receivable registry

### Task 2.1: `KYARegistry`

**Files:**
- Create: `contracts/src/core/interfaces/IKYARegistry.sol`, `contracts/src/core/KYARegistry.sol`
- Test: `contracts/test/KYARegistry.t.sol`

**Interfaces:**
- Produces:
  ```solidity
  struct Agent { bytes32 uaidHash; bytes32 ownerGroup; uint8 role; uint8 level; uint64 expiresAt; bool revoked; bytes32 mandateHash; }
  // roles: 1 Seller, 2 Buyer, 3 Worker, 4 Lender
  constructor(address issuer, address owner)
  function wire(address repaymentRouter, address facility) external onlyOwner   // once
  function register(address agent, Agent calldata a) external onlyIssuer
  function setLevel(address agent, uint8 level) external onlyIssuer
  function setMandate(address agent, bytes32 mandateHash) external onlyIssuer
  function revoke(address agent) external onlyIssuer
  function level(address agent) external view returns (uint8)          // 0 if revoked or expired
  function ownerGroup(address agent) external view returns (bytes32)
  function role(address agent) external view returns (uint8)
  function mandateHash(address agent) external view returns (bytes32)
  function agent(address a) external view returns (Agent memory)
  function recordRepayment(address buyer, address seller, bool onTime) external onlyRouter
  function recordDefault(address buyer, address seller) external onlyFacility
  function reputation(address agent) external view returns (uint32 onTime, uint32 late, uint32 defaults)
  event AgentRegistered(address indexed agent, bytes32 uaidHash, uint8 role, uint8 level, bytes32 ownerGroup);
  event LevelSet(address indexed agent, uint8 level); event AgentRevoked(address indexed agent);
  event RepaymentRecorded(address indexed buyer, address indexed seller, bool onTime); event DefaultRecorded(address indexed buyer, address indexed seller);
  error NOT_ISSUER(); error NOT_ROUTER(); error NOT_FACILITY(); error ALREADY_WIRED();
  ```
  Repayment updates both buyer (onTime/late) and seller (onTime) counters; default increments `defaults` for the buyer only.

- [ ] **Step 1: Write failing tests**: `test_register_setsFieldsAndEmits`, `test_level_zeroWhenRevoked`, `test_level_zeroWhenExpired` (warp past `expiresAt`), `test_register_revertsForNonIssuer`, `test_recordRepayment_onlyRouter`, `test_recordRepayment_updatesBothCounters`, `test_recordDefault_onlyFacility`, `test_wire_once`.
- [ ] **Step 2: Run** `forge test --match-contract KYARegistryTest` → FAIL.
- [ ] **Step 3: Implement** with OZ `Ownable`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(contracts): KYARegistry with levels, owner groups, mandates and repayment reputation`

### Task 2.2: `ReceivableRegistry` with EIP-712 confirmation

**Files:**
- Create: `contracts/src/core/interfaces/IReceivableRegistry.sol`, `contracts/src/core/ReceivableRegistry.sol`
- Test: `contracts/test/ReceivableRegistry.t.sol`

**Interfaces:**
- Produces:
  ```solidity
  enum State { None, Confirmed, Financed, Repaid, Overdue, Defaulted, Cancelled }
  struct ReceivableConfirmation { address seller; address buyer; address currency; uint256 amount; uint64 dueDate; bytes32 buyerRef; bytes32 detailsCommitment; address payTo; uint256 nonce; uint64 deadline; }
  struct Receivable { address seller; address buyer; address currency; uint256 amount; uint64 dueDate; bytes32 detailsCommitment; State state; uint64 registeredAt; }
  bytes32 constant CONFIRMATION_TYPEHASH = keccak256("ReceivableConfirmation(address seller,address buyer,address currency,uint256 amount,uint64 dueDate,bytes32 buyerRef,bytes32 detailsCommitment,address payTo,uint256 nonce,uint64 deadline)");
  bytes32 constant CANCEL_TYPEHASH = keccak256("CancelReceivable(bytes32 id)");
  constructor(IKYARegistry kya, address usdc, address owner)   // EIP712("AgentReceivables","1")
  function wire(address facility, address repaymentRouter) external onlyOwner  // once
  function register(ReceivableConfirmation calldata c, bytes calldata buyerSig) external returns (bytes32 id)
  function markFinanced(bytes32 id) external onlyFacility      // Confirmed -> Financed
  function markRepaid(bytes32 id) external onlyRouter          // Financed|Overdue|Defaulted -> Repaid
  function markOverdue(bytes32 id) external onlyFacility       // Financed -> Overdue
  function markDefaulted(bytes32 id) external onlyFacility     // Financed|Overdue -> Defaulted
  function cancel(bytes32 id, bytes calldata sellerSig, bytes calldata buyerSig) external  // Confirmed -> Cancelled
  function state(bytes32 id) external view returns (State)
  function get(bytes32 id) external view returns (Receivable memory)
  function computeId(address buyer, bytes32 buyerRef) external pure returns (bytes32)   // keccak256(abi.encode(buyer, buyerRef))
  function hashConfirmation(ReceivableConfirmation calldata c) external view returns (bytes32)  // _hashTypedDataV4
  function hashCancel(bytes32 id) external view returns (bytes32)
  function nonces(address buyer) external view returns (uint256)
  event Registered(bytes32 indexed id, address indexed seller, address indexed buyer, uint256 amount, uint64 dueDate, bytes32 detailsCommitment);
  event StateChanged(bytes32 indexed id, State from, State to);
  errors: DUPLICATE_RECEIVABLE, BAD_BUYER_SIG, WRONG_PAYEE, TERM_INELIGIBLE, BAD_NONCE, KYA_FAIL, SELF_DEALING, BAD_CURRENCY, BAD_STATE, NOT_FACILITY, NOT_ROUTER, ALREADY_WIRED
  ```
  Register order of checks: duplicate → signature (`ECDSA.recover`) → payee → `block.timestamp <= deadline` and `1 days <= dueDate - block.timestamp <= 120 days` → nonce → currency → KYA levels (buyer ≥ 3, seller ≥ 2) → owner separation.

- [ ] **Step 1: Write failing tests** (use `vm.sign` with the buyer key and a helper that builds the digest with the registry's `hashConfirmation`): `test_register_happyPath`, `test_register_duplicateReverts` (second call with a new nonce and different amount, same buyerRef), `test_register_badSig`, `test_register_wrongPayee`, `test_register_deadlinePassed`, `test_register_dueDateTooShort`, `test_register_dueDateTooLong`, `test_register_badNonce`, `test_register_badCurrency`, `test_register_buyerLevelTooLow`, `test_register_sellerLevelTooLow`, `test_register_selfDealing`, `test_stateMachine_edges` (every allowed edge passes, every other edge reverts BAD_STATE), `test_cancel_bothSigs_onlyBeforeFinanced`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with OZ `EIP712`, `ECDSA`, `Ownable`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(contracts): ReceivableRegistry verifies buyer EIP-712 confirmations and enforces the state machine`

### Task 2.3: Deploy C2 contracts, TypeScript EIP-712 signing, duplicate rejection on testnet

**Files:**
- Create: `contracts/script/01_DeployCore.s.sol` (this task deploys KYARegistry + ReceivableRegistry only; Task 3.6 extends it), `scripts/abi-sync.ts`, `packages/shared/src/{abis/index.ts,addresses.ts,eip712.ts}`, `packages/hedera/src/contracts.ts`, `scripts/c2-register-demo.ts`
- Test: `packages/shared/src/eip712.test.ts`

**Interfaces:**
- Produces: `deployments/testnet/addresses.json` `{ kyaRegistry, receivableRegistry, ... }` committed; `loadAddresses()`.
- Produces: `receivableConfirmationTypedData(domain, message)` (viem `TypedData` shape matching the Solidity typehash exactly) and `signReceivableConfirmation(account, domain, message): Promise<Hex>`; `computeReceivableId(buyer, buyerRef): Hex`.
- Produces: `contracts(env)` → typed viem contract instances `{ kya, registry }` from synced ABIs (`scripts/abi-sync.ts` copies `contracts/out/*.json` ABIs into `packages/shared/src/abis/*.json`).

- [ ] **Step 1: Write failing test** `eip712.test.ts`: `typed data hash equals registry hashConfirmation` (deploy nothing; compute `hashTypedData` with viem for a fixed message and compare to a vector produced by `forge test` helper `test_vector_hashConfirmation` that logs the digest; copy the hex into the test).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** modules and the deploy script. Deploy to testnet: `KYARegistry(issuer = KYA_ISSUER evm address, owner = operator)`, `ReceivableRegistry(kya, USDC, operator)`. Run `abi-sync`. The issuer registers seller (role 1, level 2, ownerGroup `keccak("seller-co")`), buyer (role 2, level 3, ownerGroup `keccak("buyer-co")`), workers (role 3, level 2, seller group), lenders (role 4, level 2).
- [ ] **Step 4: Run** `c2-register-demo.ts`: buyer signs the demo confirmation (10 USDC, due in 30 days, `buyerRef = keccak("PO-1001")`, `payTo` = a placeholder `0x…dead` until the router exists is NOT acceptable: use the registry's own address as a temporary `payTo` only in this spike script and note it; Task 3.6 re-registers with the real router). Then submit the same obligation again with a new nonce and expect revert `DUPLICATE_RECEIVABLE`; submit with a wrong-payee signature and expect `WRONG_PAYEE`.
- [ ] **Step 5: Record** contract addresses and the three tx links in EVIDENCE under "C2".
- [ ] **Step 6: Commit** `feat: deploy identity and receivable registries to testnet; TS EIP-712 signing and duplicate rejection`

### Task 2.4: HCS audit topic, HCS-14 profiles, receivable NFT

**Files:**
- Create: `packages/hedera/src/{hcs.ts,hcs14.ts,nft.ts}`, `scripts/c2-topic-and-nft.ts`
- Test: `packages/hedera/src/hcs14.test.ts`, `packages/hedera/src/hcs.test.ts` (live)

**Interfaces:**
- Produces: `createAuditTopic(client): topicId`, `publishAudit(client, topicId, event: AuditEvent): { sequenceNumber, txId }` where `AuditEvent = { v: 1, type: AuditType, id?, spendId?, agentUaid?, amount?, asset?, merchant?, txId?, prevSeq, ts }` and `AuditType` is the BUILD.md §12.1 list. Payload is JSON, hashes only, ≤ 1024 bytes.
- Produces: `buildUaid({ evmAddress, accountId, name, role }): { uaid: string, profile: object }` using the standards-sdk `hcs-14` module (read its exports first; do not invent the format), and `publishProfile(client, topicId, profile)`.
- Produces: `createReceivableCollection(client): tokenId` (HTS NFT, supply key = operator), `mintReceivableNft(client, tokenId, { id, hcsSeq }): { serial, txId }` with metadata `JSON.stringify({ id, seq })` ≤ 100 bytes.

- [ ] **Step 1: Write failing tests**: `hcs14.test.ts`: `buildUaid returns a string starting with "uaid:"`; `hcs.test.ts`: `publishAudit returns an increasing sequence number` (live, one message).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**. Run `c2-topic-and-nft.ts`: create the topic, publish `AgentRegistered` profiles for the ten agents, create the collection, mint one NFT for the C2 receivable id. Write `HCS_AUDIT_TOPIC_ID` and `RECEIVABLE_NFT_TOKEN_ID` into `.env.accounts` and `deployments/testnet/addresses.json`.
- [ ] **Step 4: Record** topic, profile message, NFT links in EVIDENCE under "C2".
- [ ] **Step 5: Commit** `feat(hedera): HCS audit topic, HCS-14 agent profiles and receivable NFT handle`

---

# Checkpoint C3: Facility and repayment (mock fill path)

### Task 3.1: `ReceivableCreditNote`

**Files:**
- Create: `contracts/src/core/interfaces/IReceivableCreditNote.sol`, `contracts/src/core/ReceivableCreditNote.sol`
- Test: `contracts/test/ReceivableCreditNote.t.sol`

**Interfaces:**
- Produces: ERC-20 `"CashETH Receivable Credit Note"`, `"RCN"`, 6 decimals. `constructor(address owner)`; `wire(address facility, address repaymentRouter, address swapRouter, address aqua) onlyOwner` once; `mint(address to, uint256) onlyFacility`; `burn(address from, uint256) onlyRepaymentRouter` (no allowance needed); `_update` allows a transfer only when `from == address(0) || to == address(0) || from ∈ peers || to ∈ peers` where peers = {facility, swapRouter, aqua}; otherwise `revert RCN_TRANSFER_RESTRICTED()`.

- [ ] **Step 1: Write failing tests**: `test_mint_onlyFacility`, `test_burn_onlyRouter_noAllowance`, `test_transfer_lenderToLenderReverts`, `test_transfer_lenderToFacilityAllowed`, `test_transfer_viaSwapRouterAllowed`, `test_decimals_is6`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(contracts): transfer-restricted ReceivableCreditNote`

### Task 3.2: `CashEthTraits` library and `MockSwapRouter`

**Files:**
- Create: `contracts/src/core/libs/CashEthTraits.sol`, `contracts/test/mocks/{MockUSDC,MockHSS,MockSwapRouter}.sol`
- Test: `contracts/test/CashEthTraits.t.sol`

**Interfaces:**
- Produces:
  ```solidity
  library CashEthTraits {
    function takerData(address facility, address rcn, address usdc, uint256 amount, bytes32 id, uint16 advanceBps) internal pure returns (bytes memory);
    // TakerTraitsLib.build(Args{ taker: facility, isExactIn: true, isAToB: rcn < usdc, useTransferFromAndAquaPush: true,
    //   isStrictThresholdAmount: true, threshold: abi.encode(amount), to: facility, instructionsArgs: abi.encodePacked(id, advanceBps), everything else false/empty })
    function takerArgs(bytes32 id, uint16 advanceBps) internal pure returns (bytes memory); // 34 bytes
  }
  ```
- `MockUSDC`: ERC-20 6 decimals, `mint`, `associate() returns (uint256 22)`, `isAssociated() returns true`.
- `MockHSS`: `scheduleCall(...)` stores the call and returns `(22, address(uint160(++n)))`; `deleteSchedule(address) returns 22`; `fire(address schedule)` executes the stored call as the facility would be called by the network (`msg.sender` = MockHSS is fine since the facility's `markOverdue` is permissionless after the grace period); tests `vm.etch` it at `address(0x16b)`.
- `MockSwapRouter`: `swap(Order, amount, takerData)` that pulls `amount` RCN from the taker, sends `amount` MockUSDC from a pre-funded pool to the taker, and calls `ICreditFacility(taker).onCreditFill(id, maker, amount, aprBps)` using `maker = order.maker` and `aprBps` from a per-order mapping set by the test. Its `fail(bool)` flag makes the next swap revert (for atomicity tests).

- [ ] **Step 1: Write failing test** `test_takerData_roundTrip` (parse with `TakerTraitsLib.parse` and assert `isExactIn`, `useTransferFromAndAquaPush`, `instructionsArgs == takerArgs(id, bps)`, `to == facility`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(contracts): taker-traits helper and test mocks for USDC, HSS and the swap router`

### Task 3.3: `CreditFacility` funding, positions, schedules

**Files:**
- Create: `contracts/src/core/interfaces/ICreditFacility.sol`, `contracts/src/core/CreditFacility.sol`
- Test: `contracts/test/CreditFacility.t.sol`

**Interfaces:**
- Produces (full surface; Task 3.4 adds budgets and reservations in the same file):
  ```solidity
  struct Fill { ISwapVM.Order order; uint256 amount; uint16 aprBps; }
  struct Position { uint256 principal; uint16 aprBps; uint64 start; uint256 paidPrincipal; uint256 paidFee; }
  struct FacilityInfo { address seller; address buyer; uint256 receivableAmount; uint64 dueDate; uint256 funded; uint256 committed; uint256 reserved; uint8 status; address overdueSchedule; address defaultSchedule; }
  // status: 0 None, 1 Active, 2 Frozen, 3 Closed
  constructor(IReceivableRegistry registry, IKYARegistry kya, IReceivableCreditNote rcn, address usdc, address coordinator, address owner)  // associates USDC
  function wire(address swapRouter, address repaymentRouter) external onlyOwner   // once
  function openAndFund(bytes32 id, Fill[] calldata fills, uint16 advanceBps, uint256 limit) external onlyCoordinator whenNotPaused
  function onCreditFill(bytes32 id, address maker, uint256 usdcIn, uint16 aprBps) external onlySwapRouter   // requires transient activeId == id
  function markOverdue(bytes32 id) external      // after dueDate + 7 days, anyone; Financed -> Overdue, status Frozen
  function markDefaulted(bytes32 id) external    // after dueDate + 30 days, anyone; -> Defaulted, kya.recordDefault
  function flagDispute(bytes32 id) external      // seller, buyer or coordinator; status Frozen
  function recordRepayment(bytes32 id, address maker, uint256 principalPaid, uint256 feePaid) external onlyRepaymentRouter
  function closeFacility(bytes32 id) external onlyRepaymentRouter   // status Closed, deleteSchedule x2, transfer undrawn USDC (funded - committed - reserved) to seller
  function pause() external onlyOwner; function unpause() external onlyOwner
  function facilityInfo(bytes32 id) external view returns (FacilityInfo memory)
  function makers(bytes32 id) external view returns (address[] memory)
  function position(bytes32 id, address maker) external view returns (Position memory)
  function available(bytes32 id) external view returns (uint256)
  event FacilityFunded(bytes32 indexed id, uint256 funded, uint16 advanceBps, address[] makers);
  event PositionOpened(bytes32 indexed id, address indexed maker, uint256 principal, uint16 aprBps);
  event Overdue(bytes32 indexed id); event Defaulted(bytes32 indexed id); event Disputed(bytes32 indexed id); event FacilityClosed(bytes32 indexed id, uint256 undrawnToSeller);
  event Scheduled(bytes32 indexed id, address overdueSchedule, address defaultSchedule);
  ```
  `openAndFund`: `registry.state(id) == Confirmed` else `NOT_CONFIRMED`; fills non-empty and `aprBps` non-decreasing else `NOT_CHEAPEST_FIRST`; `total <= amount * advanceBps / 10_000 && total <= limit` else `BORROWING_BASE_EXCEEDED`; set transient `activeId`; per fill: `rcn.mint(this, amount)`, `rcn.approve(swapRouter, amount)`, `usdcBefore`, `ISwapVM(swapRouter).swap(fill.order, amount, CashEthTraits.takerData(...))`, require `usdc.balanceOf(this) - usdcBefore == amount` else `FILL_MISMATCH`; clear `activeId`; store info, `registry.markFinanced(id)`; schedule `markOverdue` at `dueDate + 7 days` and `markDefaulted` at `dueDate + 30 days` through `0x16b` with gas `400_000`, skipping any schedule whose expiry exceeds `block.timestamp + 62 days - 1 hours` (then `markOverdue` schedules the default check when it runs); a non-SUCCESS code reverts `SCHEDULE_FAILED`.

- [ ] **Step 1: Write failing tests** (setup: MockUSDC, KYA, Registry with a registered Confirmed receivable, RCN, MockSwapRouter, MockHSS at 0x16b, facility funded with 1 ether of test ETH for schedules): `test_openAndFund_fillsAandB_marksFinanced_andSchedules`, `test_openAndFund_revertsNotConfirmed`, `test_openAndFund_revertsNotCheapestFirst`, `test_openAndFund_revertsBorrowingBase_advance`, `test_openAndFund_revertsBorrowingBase_limit`, `test_openAndFund_atomic_whenSecondFillFails` (no RCN supply, no positions, state still Confirmed), `test_onCreditFill_revertsWithoutActiveId`, `test_onCreditFill_onlySwapRouter`, `test_markOverdue_beforeGraceReverts_afterGraceWorks`, `test_markDefaulted_recordsDefault`, `test_schedule_skippedBeyondHorizon` (dueDate 100 days out: overdue scheduled, default not), `test_pause_blocksOpenAndFund`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (OZ `Ownable`, `Pausable`, transient `activeId` via `tstore/tload` assembly or Solidity `transient`). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(contracts): CreditFacility funds Confirmed receivables atomically and self-schedules overdue/default checks`

### Task 3.4: `CreditFacility` budgets and two-phase spend

**Files:**
- Modify: `contracts/src/core/CreditFacility.sol`, `contracts/src/core/interfaces/ICreditFacility.sol`
- Test: `contracts/test/CreditFacilitySpend.t.sol`

**Interfaces:**
- Produces:
  ```solidity
  struct Limits { uint256 maxPerTx; uint256 maxDaily; address[] merchants; }
  struct Budget { uint256 alloc; uint256 spent; uint256 reserved; uint256 maxPerTx; uint256 maxDaily; uint256 dailySpent; uint64 dayStart; }
  struct Reservation { bytes32 id; address worker; address spendWallet; address merchant; uint256 amount; uint64 expiry; uint8 status; bytes32 txIdHash; } // 0 None 1 Open 2 Committed 3 Released
  function setBudgets(bytes32 id, address[] calldata workers, uint256[] calldata alloc, Limits[] calldata limits) external   // msg.sender == seller; sum(alloc) <= funded else BUDGETS_EXCEED_FUNDED; replaces merchant allowlist
  function reserve(bytes32 id, bytes32 spendId, address worker, address spendWallet, address merchant, uint256 amount, uint64 expiry) external onlyCoordinator whenNotPaused
  function commit(bytes32 spendId, bytes32 hederaTxIdHash) external onlyCoordinator
  function release(bytes32 spendId) external   // coordinator any time, anyone after expiry
  function budget(bytes32 id, address worker) external view returns (Budget memory)
  function isMerchantAllowed(bytes32 id, address worker, address merchant) external view returns (bool)
  function reservation(bytes32 spendId) external view returns (Reservation memory)
  event BudgetsSet(bytes32 indexed id, address[] workers, uint256[] alloc);
  event SpendReserved(bytes32 indexed id, bytes32 indexed spendId, address worker, address merchant, uint256 amount, uint64 expiry);
  event SpendCommitted(bytes32 indexed spendId, bytes32 hederaTxIdHash); event SpendReleased(bytes32 indexed spendId, uint256 returned);
  ```
  `reserve` check order: status Active and `block.timestamp < dueDate` else `FACILITY_NOT_ACTIVE`; `amount <= alloc - spent - reserved` else `AGENT_BUDGET_EXCEEDED`; `amount <= maxPerTx` else `TX_LIMIT_EXCEEDED`; rolling day (`dayStart + 1 days`) `dailySpent + amount <= maxDaily` else `DAILY_LIMIT_EXCEEDED`; merchant allowlisted else `MERCHANT_NOT_ALLOWED`; `amount <= available(id)` else `GLOBAL_CREDIT_LIMIT_EXCEEDED`; then `usdc.transfer(spendWallet, amount)`, reserved += amount. `commit`: status Open and `block.timestamp <= expiry` else `RESERVATION_EXPIRED`; reserved −= amount, committed += amount, spent += amount, dailySpent += amount. `release`: status Open; `usdc.transferFrom(spendWallet, this, amount)` (standing allowance), reserved −= amount.

- [ ] **Step 1: Write failing tests**: `test_setBudgets_onlySeller`, `test_setBudgets_sumExceedsFunded`, `test_reserve_movesUsdcToWallet`, `test_reserve_agentBudgetExceeded_5500`, `test_reserve_txLimit`, `test_reserve_dailyLimit_resetsNextDay`, `test_reserve_merchantNotAllowed`, `test_reserve_globalCreditLimit`, `test_reserve_frozenFacility`, `test_commit_afterExpiryReverts`, `test_release_pullsBack_afterExpiry_byAnyone`, `test_release_beforeExpiry_onlyCoordinator`, `test_accounting_committedPlusReservedPlusAvailableEqualsFunded`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(contracts): per-worker budgets, limits, merchant allowlist and two-phase spend reservations`

### Task 3.5: `RepaymentRouter` waterfall

**Files:**
- Create: `contracts/src/core/RepaymentRouter.sol`
- Test: `contracts/test/RepaymentRouter.t.sol`

**Interfaces:**
- Produces:
  ```solidity
  uint256 constant MIN_TERM = 30 days;
  constructor(IReceivableRegistry registry, IKYARegistry kya, ICreditFacility facility, IReceivableCreditNote rcn, address usdc)   // associates USDC
  function repay(bytes32 id, uint256 amount) external   // usdc.transferFrom(msg.sender, this, amount) then distribute
  function feeOf(uint256 principal, uint16 aprBps, uint64 start, uint64 at) public pure returns (uint256)  // principal * aprBps * max(at - start, MIN_TERM) / (365 days * 10_000)
  function dueOf(bytes32 id, address maker) public view returns (uint256 principalDue, uint256 feeDue)
  function lenderDue(bytes32 id) public view returns (uint256)
  event Repaid(bytes32 indexed id, address indexed payer, uint256 amount, uint256 toLenders, uint256 toSeller);
  event LenderPaid(bytes32 indexed id, address indexed maker, uint256 principal, uint256 fee);
  ```
  Distribution: if `registry.state(id) == Repaid` send everything to the seller. Else compute each maker's due (fee first, then principal), pay pro rata of total due (last maker takes the rounding remainder), `rcn.burn(maker, principalPaid)`, `facility.recordRepayment(...)`. If total due reaches zero: `registry.markRepaid(id)`, `kya.recordRepayment(buyer, seller, block.timestamp <= dueDate)`, `facility.closeFacility(id)`, remainder to seller.

- [ ] **Step 1: Write failing tests** (facility funded via MockSwapRouter with A 4e6 @700 and B 2e6 @850): `test_feeOf_minTerm_vectors` (A → 23013, B → 13972), `test_repay_full_10e6_paysLenders6036985_sellerRemainder`, `test_repay_partial_lendersFirst_sellerZero`, `test_repay_twoPartials_closeOnSecond`, `test_repay_afterDefault_stillLendersFirst_stateRepaid`, `test_repay_afterRepaid_allToSeller`, `test_repay_burnsRcnFromMakers`, `test_repay_updatesReputation_onTimeVsLate`, `test_close_sendsUndrawnToSeller_andDeletesSchedules`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(contracts): RepaymentRouter pays lenders principal plus fee first, seller the remainder`

### Task 3.6: Fuzz and invariant tests, deploy C3 to testnet

**Files:**
- Create: `contracts/test/invariants/FacilityInvariants.t.sol`, `contracts/test/invariants/FacilityHandler.sol`
- Modify: `contracts/script/01_DeployCore.s.sol`, `contracts/script/03_Wire.s.sol`, `deployments/testnet/addresses.json`, `docs/EVIDENCE.md`

- [ ] **Step 1: Write invariants** with a handler that randomly funds (mock router), sets budgets, reserves, commits, releases, warps, repays: `invariant_debtNeverExceedsBorrowingBase`, `invariant_budgetsNeverExceedFunded`, `invariant_sellerGetsNothingWhileLendersOwed`, `invariant_stateOnlyMovesForward`, `invariant_committedPlusReservedPlusAvailableEqualsFunded`. Fuzz `feeOf` for monotonicity in `at` and no overflow for principal ≤ 1e12.
- [ ] **Step 2: Run** `forge test` (fuzz runs 512, invariant runs 128 depth 32) → PASS.
- [ ] **Step 3: Deploy** to testnet: `ReceivableCreditNote`, `CreditFacility` (coordinator = COORDINATOR evm), `RepaymentRouter`; fund the facility with 20 HBAR; wire `registry.wire(facility, router)`, `kya.wire(router, facility)`, `rcn.wire(facility, router, swapRouter = address(0) placeholder is NOT allowed: deploy the SwapVM router first in Task 4.3 and run `03_Wire` there)`. So in this task deploy and fund only, run `abi-sync`, update `addresses.json`.
- [ ] **Step 4: Record** addresses in EVIDENCE under "C3".
- [ ] **Step 5: Commit** `test(contracts): facility fuzz and invariant suite; deploy RCN, facility and repayment router to testnet`

---

# Checkpoint C4: Modified SwapVM and Aqua

### Task 4.1: `ReceivableCredit` opcode library

**Files:**
- Create: `contracts/src/aqua/ReceivableCredit.sol`
- Test: `contracts/test/ReceivableCredit.t.sol` (through a tiny harness router `TestCreditRouter is SwapVM, AquaOpcodes` in the test file)

**Interfaces:**
- Produces:
  ```solidity
  library ReceivableCredit {
    Opcode constant opcode = Opcode._21;   // free slot in the conditions bank (0x20-0x3f)
    struct Args { uint16 maxTenorDays; uint16 maxAdvanceBps; uint32 minBuyerOnTime; uint128 maxPerBuyer; uint16 aprBps; }  // 26 bytes packed, in this order
    function build(Args memory a) internal pure returns (bytes memory);                        // InstructionBuilder header + packed args
    function parse(bytes calldata args) internal pure returns (Args memory);
    struct Storage { mapping(address maker => mapping(address buyer => uint256)) exposure; }
    function store() internal pure returns (Storage storage);   // slot keccak256("casheth.ReceivableCredit.v1")
    function exec(Context memory ctx, bytes calldata args, IReceivableRegistry registry, IKYARegistry kya, address facility) internal;
    errors: NotFacilityTaker(address taker); ReceivableNotConfirmed(bytes32 id); TenorTooLong(uint256 days, uint16 max); AdvanceTooHigh(uint16 req, uint16 max);
            BuyerReputationTooLow(uint32 onTime, uint32 min); WrongTokenOut(address); InsufficientLiquidity(uint256 need, uint256 have); BuyerExposureExceeded(uint256 would, uint128 max);
  }
  ```
  `exec`: taker check → chop 34 taker-arg bytes (`id`, `advanceBps`) → `registry.get(id)` state Confirmed → tenor `(dueDate - block.timestamp) <= maxTenorDays * 1 days` → advance → `kya.reputation(buyer).onTime >= minBuyerOnTime` → `ctx.query.tokenOut == r.currency` → `amount = isExactIn ? amountIn : amountOut`, `amount <= ctx.swap.balanceOut`, `exposure[maker][buyer] + amount <= maxPerBuyer` → set the other register 1:1 → if `!ctx.vm.isStaticContext`: `exposure += amount; ICreditFacility(facility).onCreditFill(id, ctx.query.maker, amount, a.aprBps)`.

- [ ] **Step 1: Write failing tests** (harness router wires the opcode; Aqua is the real `AquaRouter` from the submodule; MockUSDC as currency; RCN real; facility replaced by a `MockFacilityTaker` that records `onCreditFill` and calls `swap`): `test_build_parse_roundTrip`, `test_exec_revertsForeignTaker`, `test_exec_revertsNotConfirmed`, `test_exec_revertsTenor`, `test_exec_revertsAdvance`, `test_exec_revertsReputation`, `test_exec_pricesOneToOne_exactIn`, `test_exec_pricesOneToOne_exactOut`, `test_exec_revertsInsufficientLiquidity`, `test_exec_exposureAccumulatesAcrossFills_andCaps`, `test_quote_doesNotCallFacility_orMutate`, `test_fullAquaFill_movesUsdcToTakerAndRcnToMaker` (ship from a maker EOA with USDC approval to Aqua, then swap through the harness).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(swapvm): ReceivableCredit opcode gates fills on the on-chain receivable state`

### Task 4.2: `CashEthSwapVMRouter` and `CashEthOrderBuilder`

**Files:**
- Create: `contracts/src/aqua/CashEthSwapVMRouter.sol`, `contracts/src/aqua/CashEthOrderBuilder.sol`
- Test: `contracts/test/CashEthSwapVMRouter.t.sol`

**Interfaces:**
- Produces:
  ```solidity
  contract CashEthSwapVMRouter is Simulator, SwapVM, AquaOpcodes {
    IReceivableRegistry public immutable REGISTRY; IKYARegistry public immutable KYA; address public immutable FACILITY;
    constructor(address aqua, address weth, address owner, string memory name, string memory version, address registry, address kya, address facility)
    function exposure(address maker, address buyer) external view returns (uint256)
    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override { _runOpcode(ctx, opcode, args); }
    function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal override  // ReceivableCredit first, else super
  }
  contract CashEthOrderBuilder {
    function buildLenderOrder(address maker, address rcn, address usdc, ReceivableCredit.Args calldata a, uint64 salt) external pure returns (ISwapVM.Order memory order, bytes memory strategy)  // program = Salt(salt) ‖ ReceivableCredit(a); MakerTraitsLib.build with useAquaInsteadOfSignature = true, tokens sorted, no hooks; strategy = abi.encode(order)
    function decodeLenderOrder(ISwapVM.Order calldata order) external pure returns (ReceivableCredit.Args memory a, uint64 salt, address tokenA, address tokenB)
    function takerData(address facility, address rcn, address usdc, uint256 amount, bytes32 id, uint16 advanceBps) external pure returns (bytes memory)  // CashEthTraits
  }
  ```
- [ ] **Step 1: Write failing tests**: `test_router_dispatchesCreditOpcode`, `test_router_stillRunsAquaOpcodes_xycSwap`, `test_orderBuilder_roundTrip_decode`, `test_orderHash_equalsAquaStrategyHash` (`router.hash(order) == keccak256(strategy)`), `test_endToEnd_openAndFund_realRouter_fillsAandB_skipsC` (real `CreditFacility`, real `AquaRouter`, three makers; C at 1300 bps omitted by the caller; assert positions, RCN balances of A and B, USDC in facility == 6e6, state Financed), `test_endToEnd_revertsWhenIdNotConfirmed`, `test_endToEnd_revertsWhenTakerIsNotFacility`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; also `forge build --sizes` and record the router runtime size (must be < 24576 bytes).
- [ ] **Step 5: Commit** `feat(swapvm): CashEthSwapVMRouter with the credit opcode and on-chain order builder`

### Task 4.3: Deploy the modified router, order builder, and wire everything on testnet

**Files:**
- Create: `contracts/script/02_DeployAquaRouter.s.sol`
- Modify: `contracts/script/03_Wire.s.sol`, `deployments/testnet/addresses.json`, `docs/EVIDENCE.md`, `scripts/c4-reregister.ts`

- [ ] **Step 1: Deploy** `AquaRouter` (fresh, ours), `CashEthSwapVMRouter(aqua, WHBAR, operator, "CashETH SwapVM", "1.0.0", registry, kya, facility)`, `CashEthOrderBuilder`, using the path proven in S1 (D-P10).
- [ ] **Step 2: Wire** `rcn.wire(facility, repaymentRouter, swapRouter, aqua)`, `facility.wire(swapRouter, repaymentRouter)`, `registry.wire(facility, repaymentRouter)`, `kya.wire(repaymentRouter, facility)`; `abi-sync`; update `addresses.json`.
- [ ] **Step 3: Run** `c4-reregister.ts`: buyer signs a fresh confirmation with `payTo = repaymentRouter`, `buyerRef = keccak("PO-1002")`, registered on testnet; mint its NFT; publish `ReceivableConfirmed` + `NftMinted` to HCS.
- [ ] **Step 4: Record** all addresses, the registration tx, and `forge build --sizes` output in EVIDENCE under "C4".
- [ ] **Step 5: Commit** `feat: deploy Aqua registry and modified SwapVM router to Hedera testnet and wire the core contracts`

### Task 4.4: `@casheth/aqua` strategy builder, ship, discovery

**Files:**
- Create: `packages/aqua/src/{orderBuilder.ts,ship.ts,discover.ts,index.ts}`
- Test: `packages/aqua/src/discover.test.ts` (live, after shipping)

**Interfaces:**
- Produces: `buildLenderOrder(env, { maker, args: CreditArgs, salt }): Promise<{ order: Order, strategy: Hex }>` (eth_call `CashEthOrderBuilder.buildLenderOrder`); `CreditArgs = { maxTenorDays, maxAdvanceBps, minBuyerOnTime, maxPerBuyer: bigint, aprBps }`.
- Produces: `approveAquaUsdc(lender, amount)`, `shipLenderStrategy(lender, { order, strategy, usdcAmount }): Promise<{ strategyHash, txHash, hashscanUrl }>` using `AquaProtocolContract(new Address(addresses.aqua)).ship({ app: swapRouter, strategy, amountsAndTokens: [{ token: USDC, amount }, { token: RCN, amount: 0n }] })` from `@1inch/aqua-sdk`, sent with viem; `dockStrategy(lender, strategyHash)`.
- Produces: `listOpenStrategies(env): Promise<LenderStrategy[]>` reading `Shipped` and `Docked` logs for `app == swapRouter` via `getLogs` (chunked by 1,000 blocks; Hashio limits range), decoding with `ShippedEvent.fromLog`, abi-decoding the strategy into `Order`, calling `decodeLenderOrder`, and reading `aqua.safeBalances(maker, swapRouter, hash, USDC, RCN)` plus the maker's real USDC balance and allowance to Aqua. `LenderStrategy = { maker, strategyHash, order, args, virtualUsdc, realUsdc, allowance }`.

- [ ] **Step 1: Write failing test** `listOpenStrategies returns the three demo strategies sorted by aprBps` (live).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; ship from A (4 USDC, 700 bps, tenor 60, advance 8000, minOnTime 0, maxPerBuyer 5 USDC), B (2 USDC, 850 bps, same), C (3 USDC, 1300 bps, same). Note: Aqua `ship` must list both tokens for `safeBalances` to work; RCN amount is 0.
- [ ] **Step 4: Run** test → PASS. Record the three `Shipped` tx links in EVIDENCE under "C4 strategies".
- [ ] **Step 5: Commit** `feat(aqua): lender strategy builder, ship/dock and open-strategy discovery on Hedera`

### Task 4.5: Solver and `openAndFund` with real fills on testnet

**Files:**
- Create: `packages/aqua/src/solver.ts`, `packages/engine/src/{score.ts,index.ts}`, `scripts/c4-open-facility.ts`
- Test: `packages/aqua/src/solver.test.ts`, `packages/engine/src/score.test.ts`

**Interfaces:**
- Produces: `scoreReceivable({ amount, dueDate, now, buyerReputation: { onTime, late, defaults }, sellerLevel, buyerLevel }): Decision` where `Decision = { approved: boolean, score: number, advanceBps: number, limit: bigint, reasons: string[] }`. Rules: base 600; `+15 * min(onTime, 10)`; `-40 * late`; `-200 * defaults`; `-50` if tenor > 60 days; `advanceBps = score >= 700 ? 8000 : score >= 600 ? 7500 : score >= 500 ? 6000 : 0`; `approved = advanceBps > 0 && buyerLevel >= 3 && sellerLevel >= 2`; `limit = min(amount * advanceBps / 10000, sellerLevel >= 3 ? 10_000_000_000n : 1_000_000_000n)`.
- Produces: `solve({ receivable, strategies, advanceBps, limit }): { fills: Fill[], total: bigint, skipped: { strategyHash, reason }[] }` where eligibility = tenor, advance, reputation, `virtualUsdc > 0`, `min(virtualUsdc, realUsdc, allowance) > 0`, and a successful `router.quote(order, take, takerData)` via `eth_call` with `account = facility`; sorted by `aprBps` ascending, greedy `take = min(remaining, capacity)`; `Fill = { order, amount, aprBps }`.

- [ ] **Step 1: Write failing tests**: `score.test.ts`: `demo buyer with zero history scores 600 and gets 7500 bps`, `one default declines`, `level-2 seller limit caps at 1000 USDC`; `solver.test.ts` (pure, strategies as fixtures): `takes A then B and skips C when base is 7.5 USDC`, `skips a strategy whose real balance is below its virtual balance`, `skips when tenor exceeds maxTenorDays`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Run** `c4-open-facility.ts` on testnet: score → solve → coordinator calls `openAndFund(id, fills, 7500, limit)`. Verify on the mirror node: one transaction, facility USDC `6 USDC`, A and B hold RCN, state `Financed`, two schedule entities created. Then call `openAndFund` for an unregistered id and from the seller key: both revert (record the revert reasons).
- [ ] **Step 6: Record** the funding tx (the 1inch track headline) and both reverts in EVIDENCE under "C4 funding".
- [ ] **Step 7: Commit** `feat: deterministic credit score, cheapest-first solver, and first on-chain Aqua-funded facility`

---

# Checkpoint C5: x402 spending

### Task 5.1: Spend wallets and standing allowance

**Files:**
- Create: `packages/hedera/src/spendWallet.ts`, `scripts/c5-spend-wallets.ts`
- Test: `packages/hedera/src/spendWallet.test.ts` (live)

**Interfaces:**
- Produces: `createSpendWallet(client, { workerPub, cosignerPub, label }): { accountId, evmAddress }` (2-of-2 `KeyList`, `setKeyWithoutAlias`, 5 HBAR, `maxAutomaticTokenAssociations 10`), `associateSpendWalletUsdc(...)` (both keys sign), `approveFacilityAllowance(client, walletId, workerKey, cosignerKey, facilityEvm, units)` via `AccountAllowanceApproveTransaction.approveTokenAllowance(USDC, wallet, facilityContractId, units)` (resolve the facility's contract id from the mirror node).
- `.env.accounts` gains `SPEND_WALLET_RESEARCH_ID/EVM`, `SPEND_WALLET_COMPUTE_ID/EVM`.

- [ ] **Step 1: Write failing test** `spend wallet has a 2-of-2 key list on the mirror node`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**, run the script for both workers with allowance `1_000_000_000` units. **Step 4: Run** → PASS; record links in EVIDENCE "C5 wallets".
- [ ] **Step 5: Commit** `feat(hedera): 2-of-2 spend wallets with a standing USDC allowance to the facility`

### Task 5.2: Engine spend policy, co-signer policy, event store, idempotency

**Files:**
- Create: `packages/engine/src/{spendPolicy.ts,cosigner.ts,events.ts,idempotency.ts}`
- Test: `packages/engine/src/{spendPolicy,cosigner,events,idempotency}.test.ts`

**Interfaces:**
- Produces: `checkSpend({ amount, budget: Budget, available, mandate: { maxPerTx, maxDaily, merchants }, merchant, now }): { ok: true } | { ok: false, code: ErrorCode }` with the same order of checks as the contract.
- Produces: `approvePayment({ requirements: PaymentRequirements, reservation: OpenReservation, usdcTokenId, network }): { ok: boolean, reason?: string }` where `OpenReservation = { spendId, spendWalletId, merchantAccountId, amount: bigint, expiry }`; approves only when `scheme === 'exact' && network matches && asset === usdcTokenId && payTo === merchantAccountId && BigInt(amount) <= reservation.amount && now < expiry`.
- Produces: `EventStore` (append-only JSONL at `data/events.jsonl`, `append(event)`, `list()`, `byId(id)`), and `IdempotencyLedger` (`data/idempotency.json`, `get(key)`, `put(key, result)`).

- [ ] **Step 1: Write failing tests** covering each rejection code, the 5.5 USDC compute case → `AGENT_BUDGET_EXCEEDED`, the global case, co-signer refusing wrong payTo / wrong asset / larger amount / expired, event store ordering, idempotent replay returning the stored result.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(engine): spend policy, co-signer policy, event store and idempotency ledger`

### Task 5.3: Reserve → pay → commit → release on testnet

**Files:**
- Create: `packages/hedera/src/facilityOps.ts`, `apps/mcp-server/src/orchestrator/spend.ts`, `scripts/c5-spend-demo.ts`
- Modify: `docs/EVIDENCE.md`

**Interfaces:**
- Produces: `reserveSpend(ctx, { id, worker, spendWallet, merchantEvm, amount, ttlSeconds }): { spendId, txHash }` (engine check first, then coordinator `facility.reserve`), `commitSpend(ctx, spendId, hederaTxId)`, `releaseSpend(ctx, spendId)`; `spendId = keccak256(id ‖ worker ‖ nonce)`.
- Produces: `payWithReservation(ctx, { spendId, url }): { transactionId, body }` = cosigned signer whose `cosign` runs `approvePayment` against the open reservation and signs with `COSIGNER_KEY` only on approval.
- Produces: HCS audit events `SpendReserved`, `SpendCommitted`, `SpendReleased`, `SpendRejected`.

- [ ] **Step 1: Run** `c5-spend-demo.ts` with the merchant running: seller sets budgets (research 1.0, compute 3.0, data 1.0, reserve 1.0; `maxPerTx 0.5`, `maxDaily 2.0` for research; merchant allowlist = merchant EVM address). Research worker: reserve 0.25 → pay → commit; mirror node shows the facility → spend wallet transfer, the x402 settlement, and `SpendCommitted`. Compute worker: 5.5 → engine returns `AGENT_BUDGET_EXCEEDED`; the script then calls the contract directly with 5.5 and records the revert `AGENT_BUDGET_EXCEEDED`. A third reservation with `ttl 30s` is left unpaid; after expiry `release` pulls 0.25 back and the co-signer refuses a late payment for that spendId.
- [ ] **Step 2: Record** all tx links in EVIDENCE under "C5 spend" (this plus S3 is the x402 track evidence).
- [ ] **Step 3: Commit** `feat: two-phase x402 spending with co-signed worker payments, rejections and release on testnet`

### Task 5.4: Merchant catalog and discovery

**Files:**
- Modify: `apps/merchant/src/server.ts` (add `GET /catalog` → `[{ name: "research", url, price: "0.25", asset: "0.0.429274", network: "hedera:testnet" }]`)
- Create: `packages/hedera/src/x402/discover.ts` (`discoverServices(catalogUrls[]): Service[]`, `cheapest(services, name)`)
- Test: `packages/hedera/src/x402/discover.test.ts` (catalog fixture)

- [ ] Steps 1–4 as usual (failing test `cheapest picks the lower price`, implement, pass).
- [ ] **Step 5: Commit** `feat(x402): merchant service catalog and worker-side discovery`

---

# Checkpoint C6: Authorization server and MCP server

### Task 6.1: Authorization server (JWT-bearer with KYA, auth code + PKCE)

**Files:**
- Create: `apps/auth-server/src/{index.ts,server.ts,keys.ts,provider.ts,jwtBearer.ts,kya.ts,assertion.ts}`
- Create: `packages/shared/src/auth.ts` (claims types, scope list, role→scope table from BUILD.md §5.3)
- Test: `apps/auth-server/src/{assertion,jwtBearer,provider}.test.ts`

**Interfaces:**
- Produces (agent side, in `packages/shared/src/auth.ts`): `signAgentAssertion({ privateKey, uaid, audience, mandateHash, kyaEvidence? }): Promise<string>` — jose `SignJWT` alg `ES256K`, header `jwk` = agent public JWK, claims `{ iss: agentEvmAddress, sub: uaid, aud, jti, iat, exp: +5min, mandateHash, kya_evidence? }`.
- Produces (AS): `POST /token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=…&resource=…` → `{ access_token, token_type: "Bearer", expires_in: 600, scope }`. Verification: JWT signature with the header `jwk`; `keccak(pubkey)[12:] == iss`; `aud == AUTH_ISSUER`; `jti` unused; `KYARegistry.agent(iss)` not revoked, not expired, `mandateHash` matches; level ≥ 1 else `KYA_LEVEL_TOO_LOW`; scopes = `roleScopes[role]` filtered by level (level 1 → read scopes only); `resource` must equal `MCP_RESOURCE_URL`. Optional `kya_evidence`: if a Skyfire `kya+jwt` is present and `SKYFIRE_JWKS_ISSUER` is configured, verify it against the issuer's `/.well-known/jwks.json` and raise the level to 3 for this token.
- Produces: access token JWT `ES256` (`keys.ts` generates/loads `data/as-keys.json`), claims `{ iss: AUTH_ISSUER, sub: uaid, agent, role, kya_level, owner_group, scope, aud: MCP_RESOURCE_URL, jti, exp }`; `GET /.well-known/jwks.json`; `GET /.well-known/oauth-authorization-server` via `mcpAuthRouter` with `provider.ts` implementing `OAuthServerProvider` for the auth-code path (D-P8), in-memory clients store with dynamic registration enabled.

- [ ] **Step 1: Write failing tests**: `assertion signed by key X verifies and iss equals its address`, `assertion with mismatched iss is rejected`, `jwt-bearer issues a token with seller scopes for a level-2 seller`, `level-1 agent gets read scopes only`, `revoked agent is rejected with KYA_FAIL`, `resource mismatch is rejected`, `auth-code + PKCE round trip issues a token for the chosen agent`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (KYA reads through viem against testnet addresses; tests use a `KyaReader` interface with an in-memory fake). **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(auth): OAuth 2.1 authorization server issuing audience-bound tokens from KYA-checked agent assertions`

### Task 6.2: MCP server with resource metadata, token validation and all tools

**Files:**
- Create: `apps/mcp-server/src/{index.ts,server.ts,auth.ts,tools/*.ts,orchestrator/{receivables.ts,facility.ts,repay.ts,explain.ts}}`
- Test: `apps/mcp-server/src/{auth,tools}.test.ts`

**Interfaces:**
- Produces: Express 5 app on `MCP_PORT`; `mcpAuthMetadataRouter({ oauthMetadata (fetched from AS), resourceServerUrl: MCP_RESOURCE_URL, scopesSupported })`; `POST /mcp` behind `requireBearerAuth({ verifier: { verifyAccessToken } (jose jwtVerify against AS JWKS, issuer, audience), resourceMetadataUrl, expectedResource: new URL(MCP_RESOURCE_URL) })`; `StreamableHTTPServerTransport` per request (stateless); `GET /events` (event store, no auth) and `GET /health`.
- Produces tools (names, input schemas, role/scope checks exactly as BUILD.md §5.3; every mutating tool takes `idempotencyKey`): `register_agent`, `upload_receivable` → `{ pendingId, confirmationRequest: { typedData } }`, `confirm_receivable({ pendingId, signature })` → runs verify/dedupe/score/KYA then `registry.register`, NFT mint, HCS → `{ id, txHash, hashscan, nftSerial, hcsSeq, decision }`, `get_receivable_status`, `get_quotes({ id })` → strategies + solver preview, `open_facility({ id })`, `set_budgets`, `reserve_spend`, `pay_x402({ spendId, url })`, `commit_spend`, `repay_receivable({ id, amount })` (buyer approves router then `repay`), `explain_decision({ id })`.
- Scope failure inside a tool returns `isError` with `{ code: "INSUFFICIENT_SCOPE", required }`.
- `explain_decision` uses `@anthropic-ai/sdk` with model `claude-haiku-5-5` when `ANTHROPIC_API_KEY` is set, prompt = the decision JSON and the rule list, system instruction "explain, never change"; without a key it returns a templated explanation and `{ source: "template" }`.

- [ ] **Step 1: Write failing tests** (supertest; fake KYA, fake chain via an in-memory `Orchestrator` interface for unit tests): `unauthenticated POST /mcp returns 401 with WWW-Authenticate resource_metadata`, `token for another audience is rejected 401`, `expired token rejected`, `level-1 token calling confirm_receivable returns INSUFFICIENT_SCOPE`, `idempotent replay returns the first result`, `tools/list returns all 12 tools`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Run live**: start AS + MCP, use the MCP Inspector or a small script to obtain a token via JWT-bearer for the seller and call `get_receivable_status` for the C4 id. Record the 401 body and a successful call in EVIDENCE "C6".
- [ ] **Step 6: Commit** `feat(mcp): MCP server with protected-resource metadata, audience-bound bearer auth and the CashETH tool set`

### Task 6.3: Wire the orchestrator to the chain end to end

- [ ] **Step 1: Run** the full tool sequence against testnet through MCP with raw clients for a new receivable `PO-1003` (upload → confirm → get_quotes → open_facility → set_budgets → reserve_spend → pay_x402 → commit_spend → repay_receivable). Verify every HashScan link; verify `repay` paid A `4023013`, B `2013972` units and the seller the rest; state `Repaid`; reputation updated.
- [ ] **Step 2: Record** in EVIDENCE "C6 end to end".
- [ ] **Step 3: Commit** `feat: orchestrator drives the full lifecycle through MCP tools on testnet`

### Task 6.4: Metered `get_quotes` (optional x402 extra)

- [ ] Add `X402_METER_QUOTES=true` support: when set, `get_quotes` requires an x402 payment of `0.01 USDC` to the operator account through the same `@x402/express` middleware on a sidecar route `POST /mcp-paid/quotes` that the tool proxies to. Skip if time is short; it is not on the demo path.
- [ ] **Commit** `feat(mcp): optional x402-metered get_quotes`

---

# Checkpoint C7: Agents and demo runner

### Task 7.1: MCP agent client and the four agents

**Files:**
- Create: `agents/src/{mcpClient.ts,seller.ts,buyer.ts,worker.ts,lender.ts,kit.ts,index.ts}`
- Test: `agents/src/mcpClient.test.ts`

**Interfaces:**
- Produces: `AgentClient.connect({ agentKey, uaid, role }): AgentClient` (discovers `/.well-known/oauth-protected-resource`, follows `authorization_servers[0]`, obtains a JWT-bearer token, connects `StreamableHTTPClientTransport` with the bearer header, refreshes on 401) with `call(tool, args)`.
- Produces: `sellerAgent.run({ invoice })`, `buyerAgent.confirm(pendingId)` (signs typed data with viem), `buyerAgent.repay(id, amount)`, `workerAgent.buy({ id, service, budgetHint })` (discover catalog → compare prices → reserve → pay → commit; on rejection logs the error code), `lenderAgent.ship(params)` (direct Aqua, no MCP), `kit.ts`: Hedera Agent Kit instance per agent used for `submit_topic_message` (agent-side HCS notes) and `associate_token` (D-P12).

- [ ] **Step 1: Write failing test** `AgentClient obtains a token and lists tools against a local MCP server` (spawn AS + MCP in-process with fakes).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(agents): seller, buyer, worker and lender agents as MCP clients with KYA auth`

### Task 7.2: Demo runner writes EVIDENCE

**Files:**
- Create: `agents/src/demo.ts`, root script `"demo": "pnpm -F @casheth/agents demo"`

- [ ] **Step 1: Implement** the eight steps plus the duplicate submission and the two rejections, each printing the HashScan link and appending to `docs/EVIDENCE.md` under a dated "Demo run" heading; exit non-zero if any step lacks a Hedera transaction id. Starts and stops the merchant, AS and MCP servers itself (or expects them via `DEMO_SERVERS=external`).
- [ ] **Step 2: Run** `pnpm demo` on testnet → PASS with all links.
- [ ] **Step 3: Commit** `feat: one-command demo drives all eight steps from agents and records evidence`

### Task 7.3: Optional multi-agent negotiation

- [ ] Seller and buyer agents exchange `{ amount, dueDate }` proposals over an HCS thread (two messages) before the buyer signs; recorded as `Negotiated` events. Skip if time is short.
- [ ] **Commit** `feat(agents): seller-buyer term negotiation over HCS`

---

# Checkpoint C8: Dashboard, docs, video

### Task 8.1: Dashboard

**Files:**
- Create: `apps/web/` (Vite + React + TypeScript), `src/{App.tsx,Rail.tsx,Evidence.tsx,Waterfall.tsx,api.ts}`
- Test: `apps/web/src/Waterfall.test.tsx` (fee math display for the demo numbers)

- [ ] **Step 1: Write failing test** `renders lenders 6.036985 and seller 3.963015 for the demo repayment`.
- [ ] **Step 2: Implement**: polls `GET /events` every 3 s; eight-step rail with status per step; evidence list with HashScan links; waterfall table; rejection badges (`DUPLICATE_RECEIVABLE`, `AGENT_BUDGET_EXCEEDED`, `GLOBAL_CREDIT_LIMIT_EXCEEDED`); "AI explains, never approves" panel showing `explain_decision` output. Use the `frontend-design` skill for the visual pass; keep one page.
- [ ] **Step 3: Run** test → PASS; `pnpm -F @casheth/web build` → PASS.
- [ ] **Step 4: Commit** `feat(web): eight-step rail, evidence links and repayment waterfall`

### Task 8.2: README, EVIDENCE, video script

- [ ] **Step 1: Write** `README.md`: what it is, architecture diagram (`diagrams/architecture-hedera.png`), how to run (`.env`, `pnpm install`, `pnpm setup:accounts`, `forge script` deploys, `pnpm demo`), the payment flow, the modified SwapVM section (opcode, router, addresses, `forge build --sizes`), **a settled Hedera x402 transaction id**, the funding transaction id, prize-track checklists mapped to evidence, "Powered by Aqua — © Degensoft Ltd 2025" attribution and the license note for the modified router (source published under `LicenseRef-Degensoft-SwapVM-1.1` terms; changes marked and dated), next steps (sybil resistance, IRN cross-registry, GST evidence).
- [ ] **Step 2: Write** `docs/DEMO_SCRIPT.md` from BUILD.md §16 with the real links filled in.
- [ ] **Step 3: Commit** `docs: README with testnet evidence, demo script and license attribution`

### Task 8.3: Final verification

- [ ] **Step 1: Run** `forge test`, `pnpm test`, `pnpm demo` from a clean clone (`git clone --recurse-submodules`), confirm `docs/EVIDENCE.md` links resolve (script `scripts/check-evidence.ts` fetches each HashScan link's mirror-node counterpart).
- [ ] **Step 2: Commit** `chore: evidence link checker and final verification`

---

## Self-review notes

- Spec coverage: §1 prizes (C1 S3, C4, C5, README), §4 identity (2.1, 2.4), §5 MCP/KYA (6.1, 6.2), §6 EIP-712 (2.2, 2.3), §7 contracts (3.x), §8 Aqua/SwapVM (4.x), §9 x402 (1.3, 5.x), §10 waterfall (3.5), §11 services (packages/apps), §12 events/errors (2.4, 5.2, shared), §13 layout, §14 phases (checkpoints), §15 testing (each task), §16 demo (7.2, 8.2), §17 config (0.1), §18 tooling (used), §19 risks (1.x spikes, D-P9/D-P10). GST stretch (§6.6) is intentionally not scheduled.
- Type consistency: `Fill`, `Position`, `Reservation`, `Limits`, `Budget`, `ReceivableCredit.Args`, `CashEthTraits.takerData`, `Decision`, `LenderStrategy`, `AuditEvent`, `AgentClient` are defined once and referenced by name afterwards.
- Review Focus tests are attached to Tasks 2.3, 4.4/4.5, 3.4/5.3, 3.5, 6.2.
