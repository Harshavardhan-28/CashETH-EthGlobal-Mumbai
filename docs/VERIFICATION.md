# Verification report

Date: 2026-11-06. Code under test: `c209b0d` (main) plus the verifier added in this commit. Network: Hedera testnet, read through the public mirror node (`https://testnet.mirrornode.hedera.com`).

Everything below can be reproduced with one command per row:

| Check | Command |
| --- | --- |
| Every HashScan link in `README.md` and `docs/EVIDENCE.md` exists on testnet with the claimed result | `pnpm verify:evidence` |
| TypeScript workspaces compile | `pnpm -r build` |
| Unit tests | `pnpm -r test` (see the note on the aqua package below) |
| Verifier parser tests | `pnpm test:scripts` |

## Test suites

| Suite | Result | Notes |
| --- | --- | --- |
| Foundry (`forge test`) | 181 passed, 0 failed | **Not re-run here.** Cited from `.superpowers/sdd/2026-11-06-casheth-build/task-4.5L-fix-report.md` (run on main at the CreditFacility one-schedule fix, commit `b2a4ab1`; the only contract changes since are license-header comments and a deploy script). This worktree has empty `contracts/lib` submodules, so contracts cannot be built in it. Includes the fuzz and invariant suites described in `docs/EVIDENCE.md`. |
| `pnpm -r build` | green (8 projects) | `shared`, `engine`, `aqua`, `hedera`, `merchant`, `auth-server`, `mcp-server`, `agents`. |
| `@casheth/shared` | 20 passed | |
| `@casheth/engine` | 41 passed | |
| `@casheth/hedera` | 46 passed | Includes every test the package has; none is gated behind a live flag. |
| `@casheth/aqua` unit project | 18 passed, 1 skipped | `vitest run --project unit`. The skipped test is `discover.live.test.ts` (reads live testnet; opt-in). |
| `@casheth/aqua` anvil project | not run here | Needs Foundry (`anvil`, `forge`) and a built `contracts/out`, neither available in this worktree, so `pnpm -r test` stops at this package with `Foundry not found`. The 4.5L report records the full aqua run on main as 25 passed, 1 skipped (18 unit plus 7 anvil). |
| `@casheth/merchant` | 1 passed | |
| `@casheth/auth-server` | 26 passed | |
| `@casheth/mcp-server` | 55 passed | |
| `agents` | 45 passed | |
| `scripts/` (evidence parser) | 10 passed | `pnpm test:scripts`. |

Run here: all of the above except the Foundry suite and the aqua anvil project. Total TypeScript tests executed in this worktree: 262 passed, 1 skipped. `pnpm demo` has not been run (the demo run is still in progress, see the checklist).

## Evidence links against the mirror node

`pnpm verify:evidence` parses every HashScan link in `README.md` and `docs/EVIDENCE.md`, de-duplicates them (268 occurrences, 187 distinct entities) and asks the mirror node about each one:

- transactions must exist and report their expected result: `SUCCESS`, or the failure the surrounding text claims (`CONTRACT_REVERT_EXECUTED` for the revert proofs, a named status such as `NO_SCHEDULING_ALLOWED_AFTER_SCHEDULED_RECURSION` where the text names one, otherwise any non-`SUCCESS` result);
- contracts must exist with runtime bytecode; accounts, topics (at least one message), tokens and schedules must exist;
- links in archived or first-deployment sections are queried too, but their failures would not change the exit code (none failed);
- `TODO` and `pending demo run` markers are listed as pending and never fail the run;
- requests are limited to 5 per second, with retry and backoff on 429, 5xx and network errors.

**Result: 187 distinct links checked, 187 ok, 0 failed, 0 archived failures ignored, 5 pending demo run markers. Exit code 0.** (62 of the 187 are links in archived first-deployment sections; all of them still resolve.)

### Judge checklist

Evidence for each prize-track requirement. "Pending demo run" means the final end-to-end demo run is still in progress and the link will be added when it lands (`README.md` carries the matching `TODO(8.2-final)` markers).

**Hedera track: x402 payments with agent working capital**

| Requirement | Evidence |
| --- | --- |
| Settled x402 payment on Hedera testnet (mechanism proven) | Single-key settlement [0.0.9185802-1793964900-434830214](https://hashscan.io/testnet/transaction/0.0.9185802-1793964900-434830214) and 2-of-2 co-signed settlement [0.0.9185802-1793964918-249682742](https://hashscan.io/testnet/transaction/0.0.9185802-1793964918-249682742) (spike S3, `docs/EVIDENCE.md`). |
| Settled x402 payment in the final run, paid from a spend wallet | Pending demo run. |
| Agent-driven (an agent, not a human, pays and borrows) | Agent code and tests run green here (`agents`: 45 tests; `mcp-server`: 55). The 2-of-2 spend wallets agents pay from: [research 0.0.11339484](https://hashscan.io/testnet/account/0.0.11339484), [compute 0.0.11339486](https://hashscan.io/testnet/account/0.0.11339486). End-to-end agent run: pending demo run. |
| HCS audit trail | Audit topic [0.0.11338927](https://hashscan.io/testnet/topic/0.0.11338927) with the messages for PO-1002: `ReceivableConfirmed` seq 34 [tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793980598.332603471), `NftMinted` seq 35 [tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793980602.620678492), `FacilityFunded` seq 36 [tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793982667.668877640). Final-run audit messages (payment, repayment): pending demo run. |
| Native Hedera services in use | Receivable NFT collection [0.0.11338934](https://hashscan.io/testnet/token/0.0.11338934); scheduled lifecycle, one [executed](https://hashscan.io/testnet/schedule/0.0.11338268) and one [deleted](https://hashscan.io/testnet/schedule/0.0.11338283) schedule (HIP-1215). |

**1inch Aqua track: redeployed Aqua and a modified SwapVM**

| Requirement | Evidence |
| --- | --- |
| Aqua redeployed on Hedera testnet | AquaRouter [0xc65A0788a9AE598aEAB5DbC529B7649a1383d54c](https://hashscan.io/testnet/contract/0xc65A0788a9AE598aEAB5DbC529B7649a1383d54c) (runtime bytecode verified by the table below). |
| Modified SwapVM with a custom opcode | `CashEthSwapVMRouter` [0x458b3b7CaDec64Cd0AE0B244d582006C4E99ce1b](https://hashscan.io/testnet/contract/0x458b3b7CaDec64Cd0AE0B244d582006C4E99ce1b), custom opcode `ReceivableCredit` on `Opcode._21`; source `contracts/test/ReceivableCredit.t.sol` tests it (Foundry: 181 passed). |
| Aqua and SwapVM run on Hedera with real HTS USDC | Spike S1: ship [0.0.7314364@1793963071.121512471](https://hashscan.io/testnet/transaction/0.0.7314364@1793963071.121512471), fill [0.0.7314364@1793963078.419965153](https://hashscan.io/testnet/transaction/0.0.7314364@1793963078.419965153). |
| Lender strategies shipped on-chain (7) | `Aqua.ship` transactions: A credit [1793980834](https://hashscan.io/testnet/transaction/0.0.7314364@1793980834.590739155), A base [1793980911](https://hashscan.io/testnet/transaction/0.0.7314364@1793980911.340291226), B credit [1793981034](https://hashscan.io/testnet/transaction/0.0.7314364@1793981034.732736160), B base [1793981428](https://hashscan.io/testnet/transaction/0.0.7314364@1793981428.956894431), C credit [1793981544](https://hashscan.io/testnet/transaction/0.0.7314364@1793981544.024005875), C base [1793981618](https://hashscan.io/testnet/transaction/0.0.7314364@1793981618.317305300), D credit [1793982142](https://hashscan.io/testnet/transaction/0.0.7314364@1793982142.770577875). |
| Receivable facility funded by Aqua fills | `openAndFund` through the modified router, lenders A (3.5 USDC) and B (1.0 USDC) filled PO-1002, C skipped on price, D skipped on-chain with `SELLER_NOT_FUNDED_BY_LENDER`: [0.0.7314364@1793982496.157443985](https://hashscan.io/testnet/transaction/0.0.7314364@1793982496.157443985). |
| Custom opcode rejects what it should, on-chain | `NOT_CONFIRMED()` [0.0.7314364@1793982511.134508238](https://hashscan.io/testnet/transaction/0.0.7314364@1793982511.134508238) and `NOT_COORDINATOR()` [0.0.7314364@1793982519.722396023](https://hashscan.io/testnet/transaction/0.0.7314364@1793982519.722396023) (both `CONTRACT_REVERT_EXECUTED`). |
| Repayment of the funded facility (lenders paid, receivable `Repaid`) | Pending demo run. |
| Measured base-yield (trader swaps, "scripted volume") | Pending demo run. |

### Pending demo run

The five markers still open in `README.md` (lines 71, 73, 400, 413, 425): the final x402 settlement transaction, the root `pnpm demo` script, the repayment transaction and the measured base-yield table. They are not counted as failures.

### Full table

Output of `pnpm verify:evidence` on 2026-11-06 (links abbreviated; `Where` is the first file and line the link appears at).

| Link | Type | Expected | Mirror result | Where | Status |
| --- | --- | --- | --- | --- | --- |
| [0.0.11337987](https://hashscan.io/testnet/account/0.0.11337987) | account |  | exists (0.0.11337987) | docs/EVIDENCE.md:11, README.md:132 | ok |
| [0.0.11337988](https://hashscan.io/testnet/account/0.0.11337988) | account |  | exists (0.0.11337988) | docs/EVIDENCE.md:12, README.md:133 | ok |
| [0.0.11337989](https://hashscan.io/testnet/account/0.0.11337989) | account |  | exists (0.0.11337989) | docs/EVIDENCE.md:13, docs/EVIDENCE.md:130, ... | ok |
| [0.0.11337990](https://hashscan.io/testnet/account/0.0.11337990) | account |  | exists (0.0.11337990) | docs/EVIDENCE.md:14, README.md:135 | ok |
| [0.0.11337991](https://hashscan.io/testnet/account/0.0.11337991) | account |  | exists (0.0.11337991) | docs/EVIDENCE.md:15, docs/EVIDENCE.md:43, ... | ok |
| [0.0.11337992](https://hashscan.io/testnet/account/0.0.11337992) | account |  | exists (0.0.11337992) | docs/EVIDENCE.md:16, README.md:137 | ok |
| [0.0.11337993](https://hashscan.io/testnet/account/0.0.11337993) | account |  | exists (0.0.11337993) | docs/EVIDENCE.md:17, README.md:138 | ok |
| [0.0.11337994](https://hashscan.io/testnet/account/0.0.11337994) | account |  | exists (0.0.11337994) | docs/EVIDENCE.md:18, README.md:140 | ok |
| [0.0.11337995](https://hashscan.io/testnet/account/0.0.11337995) | account |  | exists (0.0.11337995) | docs/EVIDENCE.md:19, README.md:141 | ok |
| [0.0.11337996](https://hashscan.io/testnet/account/0.0.11337996) | account |  | exists (0.0.11337996) | docs/EVIDENCE.md:20, README.md:142 | ok |
| [0.0.11340117](https://hashscan.io/testnet/account/0.0.11340117) | account |  | exists (0.0.11340117) | docs/EVIDENCE.md:21, README.md:139 | ok |
| [0.0.11338088](https://hashscan.io/testnet/contract/0.0.11338088) | contract |  | runtime 3730 B | docs/EVIDENCE.md:35 | ok |
| [0.0.7314364-17...89301503](https://hashscan.io/testnet/transaction/0.0.7314364@1793962858.989301503) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:35 | ok |
| [0.0.11338089](https://hashscan.io/testnet/contract/0.0.11338089) | contract |  | runtime 21981 B | docs/EVIDENCE.md:36 | ok |
| [0.0.7314364-17...58758871](https://hashscan.io/testnet/transaction/0.0.7314364@1793962861.258758871) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:36 | ok |
| [0.0.11338091](https://hashscan.io/testnet/contract/0.0.11338091) | contract |  | runtime 2035 B | docs/EVIDENCE.md:37 | ok |
| [0.0.7314364-17...86577686](https://hashscan.io/testnet/transaction/0.0.7314364@1793962867.786577686) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:37 | ok |
| [0.0.11338092](https://hashscan.io/testnet/contract/0.0.11338092) | contract |  | runtime 5254 B | docs/EVIDENCE.md:38 | ok |
| [0.0.7314364-17...41347429](https://hashscan.io/testnet/transaction/0.0.7314364@1793962870.241347429) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:38 | ok |
| [0.0.11338095](https://hashscan.io/testnet/contract/0.0.11338095) | contract |  | runtime 1794 B | docs/EVIDENCE.md:39 | ok |
| [0.0.7314364-17...67047578](https://hashscan.io/testnet/transaction/0.0.7314364@1793962871.567047578) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:39 | ok |
| [0.0.7314364-17...29017528](https://hashscan.io/testnet/transaction/0.0.7314364@1793963051.329017528) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:49 | ok |
| [0.0.7314364-17...40703515](https://hashscan.io/testnet/transaction/0.0.7314364@1793963054.440703515) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:50 | ok |
| [0.0.7314364-17...34109476](https://hashscan.io/testnet/transaction/0.0.7314364@1793963063.234109476) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:51 | ok |
| [0.0.7314364-17...63489567](https://hashscan.io/testnet/transaction/0.0.7314364@1793963066.063489567) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:52 | ok |
| [0.0.7314364-17...21512471](https://hashscan.io/testnet/transaction/0.0.7314364@1793963071.121512471) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:53, README.md:321, ... | ok |
| [0.0.7314364-17...19965153](https://hashscan.io/testnet/transaction/0.0.7314364@1793963078.419965153) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:59, README.md:64, ... | ok |
| [0.0.11338193](https://hashscan.io/testnet/contract/0.0.11338193) | contract |  | runtime 1108 B | docs/EVIDENCE.md:77 | ok |
| [0.0.7314364-17...06935109](https://hashscan.io/testnet/transaction/0.0.7314364@1793963631.806935109) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:81 | ok |
| [0.0.7314364-17...76091991](https://hashscan.io/testnet/transaction/0.0.7314364@1793963643.076091991) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:82 | ok |
| [0.0.7314364-17...30791456](https://hashscan.io/testnet/transaction/0.0.7314364@1793963646.030791456) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:83 | ok |
| [0.0.7314364-17...77482784](https://hashscan.io/testnet/transaction/0.0.7314364@1793963655.477482784) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:84 | ok |
| [0.0.11338265](https://hashscan.io/testnet/contract/0.0.11338265) | contract |  | runtime 1123 B | docs/EVIDENCE.md:99 | ok |
| [0.0.7314364-17...65626821](https://hashscan.io/testnet/transaction/0.0.7314364@1793963937.665626821) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:103 | ok |
| [0.0.7314364-17...25757865](https://hashscan.io/testnet/transaction/0.0.7314364@1793963939.125757865) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:104 | ok |
| [0.0.11338268](https://hashscan.io/testnet/schedule/0.0.11338268) | schedule |  | executed | docs/EVIDENCE.md:105, README.md:54, ... | ok |
| [0.0.7314364-17...17566541](https://hashscan.io/testnet/transaction/0.0.7314364@1793963948.917566541) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:105 | ok |
| [1793964046.045736810](https://hashscan.io/testnet/transaction/1793964046.045736810) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:106 | ok |
| [0.0.11338283](https://hashscan.io/testnet/schedule/0.0.11338283) | schedule |  | deleted | docs/EVIDENCE.md:107, README.md:54, ... | ok |
| [0.0.7314364-17...26185880](https://hashscan.io/testnet/transaction/0.0.7314364@1793964052.726185880) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:107 | ok |
| [0.0.7314364-17...92393677](https://hashscan.io/testnet/transaction/0.0.7314364@1793964061.192393677) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:108 | ok |
| [0.0.429274](https://hashscan.io/testnet/token/0.0.429274) | token |  | FUNGIBLE_COMMON USDC | docs/EVIDENCE.md:126, docs/EVIDENCE.md:288, ... | ok |
| [0.0.11333304](https://hashscan.io/testnet/account/0.0.11333304) | account |  | exists (0.0.11333304) | docs/EVIDENCE.md:126, README.md:47, ... | ok |
| [0.0.9185802-17...34830214](https://hashscan.io/testnet/transaction/0.0.9185802-1793964900-434830214) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:130, README.md:48, ... | ok |
| [0.0.11338499](https://hashscan.io/testnet/account/0.0.11338499) | account |  | exists (0.0.11338499) | docs/EVIDENCE.md:131, docs/EVIDENCE.md:167 | ok |
| [0.0.9185802-17...49682742](https://hashscan.io/testnet/transaction/0.0.9185802-1793964918-249682742) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:131, README.md:48, ... | ok |
| [0.0.11333252-1...18280874](https://hashscan.io/testnet/transaction/0.0.11333252-1793964911-818280874) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:167 | ok |
| [0.0.11333252-1...86550799](https://hashscan.io/testnet/transaction/0.0.11333252-1793964913-286550799) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:167 | ok |
| [0.0.11333252-1...47079064](https://hashscan.io/testnet/transaction/0.0.11333252-1793964912-847079064) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:167 | ok |
| [0.0.11338820](https://hashscan.io/testnet/contract/0.0.11338820) | contract (archived) |  | runtime 2921 B | docs/EVIDENCE.md:223 | ok |
| [0.0.7314364-17...71576721](https://hashscan.io/testnet/transaction/0.0.7314364@1793966394.171576721) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:223 | ok |
| [0.0.11338823](https://hashscan.io/testnet/contract/0.0.11338823) | contract (archived) |  | runtime 6379 B | docs/EVIDENCE.md:224 | ok |
| [0.0.7314364-17...45288564](https://hashscan.io/testnet/transaction/0.0.7314364@1793966402.245288564) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:224 | ok |
| [0.0.7314364-17...31996335](https://hashscan.io/testnet/transaction/0.0.7314364@1793966413.731996335) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:232 | ok |
| [0.0.7314364-17...23337776](https://hashscan.io/testnet/transaction/0.0.7314364@1793966426.623337776) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:233 | ok |
| [0.0.7314364-17...62555880](https://hashscan.io/testnet/transaction/0.0.7314364@1793966440.862555880) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:234 | ok |
| [0.0.7314364-17...03597519](https://hashscan.io/testnet/transaction/0.0.7314364@1793966452.503597519) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:235 | ok |
| [0.0.7314364-17...63342193](https://hashscan.io/testnet/transaction/0.0.7314364@1793966466.763342193) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:236 | ok |
| [0.0.7314364-17...34382158](https://hashscan.io/testnet/transaction/0.0.7314364@1793966481.534382158) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:237 | ok |
| [0.0.7314364-17...15648279](https://hashscan.io/testnet/transaction/0.0.7314364@1793966492.515648279) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:238 | ok |
| [0.0.7314364-17...70050429](https://hashscan.io/testnet/transaction/0.0.7314364@1793966502.770050429) | transaction (archived) | CONTRACT_REVERT_EXECUTED | CONTRACT_REVERT_EXECUTED | docs/EVIDENCE.md:258, README.md:184 | ok |
| [0.0.7314364-17...09597123](https://hashscan.io/testnet/transaction/0.0.7314364@1793966532.109597123) | transaction (archived) | CONTRACT_REVERT_EXECUTED | CONTRACT_REVERT_EXECUTED | docs/EVIDENCE.md:259, README.md:184 | ok |
| [0.0.11338927](https://hashscan.io/testnet/topic/0.0.11338927) | topic |  | has messages | docs/EVIDENCE.md:266, docs/EVIDENCE.md:472, ... | ok |
| [0.0.11338934](https://hashscan.io/testnet/token/0.0.11338934) | token |  | NON_FUNGIBLE_UNIQUE CRCV | docs/EVIDENCE.md:267, docs/EVIDENCE.md:473, ... | ok |
| [0.0.11333252-1...49217866](https://hashscan.io/testnet/transaction/0.0.11333252@1793966819.849217866) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:268 | ok |
| [0.0.11333252-1...82306123](https://hashscan.io/testnet/transaction/0.0.11333252@1793966833.582306123) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:268 | ok |
| [0.0.11333252-1...03107777](https://hashscan.io/testnet/transaction/0.0.11333252@1793966855.703107777) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:275 | ok |
| [0.0.11333252-1...93865324](https://hashscan.io/testnet/transaction/0.0.11333252@1793966862.493865324) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:276 | ok |
| [0.0.11333252-1...15936608](https://hashscan.io/testnet/transaction/0.0.11333252@1793966875.115936608) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:277 | ok |
| [0.0.11333252-1...52273481](https://hashscan.io/testnet/transaction/0.0.11333252@1793966895.352273481) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:278 | ok |
| [0.0.11333252-1...72098662](https://hashscan.io/testnet/transaction/0.0.11333252@1793966912.572098662) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:279 | ok |
| [0.0.11333252-1...30993138](https://hashscan.io/testnet/transaction/0.0.11333252@1793966911.730993138) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:280 | ok |
| [0.0.11333252-1...50289987](https://hashscan.io/testnet/transaction/0.0.11333252@1793966918.450289987) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:281 | ok |
| [0.0.11333252-1...77870704](https://hashscan.io/testnet/transaction/0.0.11333252@1793966918.777870704) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:282 | ok |
| [0.0.11333252-1...50939777](https://hashscan.io/testnet/transaction/0.0.11333252@1793966943.450939777) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:283 | ok |
| [0.0.11333252-1...48933279](https://hashscan.io/testnet/transaction/0.0.11333252@1793967072.948933279) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:284 | ok |
| [0.0.11339484](https://hashscan.io/testnet/account/0.0.11339484) | account |  | exists (0.0.11339484) | docs/EVIDENCE.md:292, README.md:125, ... | ok |
| [0.0.11333252-1...72231452](https://hashscan.io/testnet/transaction/0.0.11333252@1793969914.172231452) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:292, README.md:125 | ok |
| [0.0.11333252-1...09773850](https://hashscan.io/testnet/transaction/0.0.11333252@1793969919.209773850) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:292 | ok |
| [0.0.11339486](https://hashscan.io/testnet/account/0.0.11339486) | account |  | exists (0.0.11339486) | docs/EVIDENCE.md:293, README.md:126, ... | ok |
| [0.0.11333252-1...74066550](https://hashscan.io/testnet/transaction/0.0.11333252@1793969922.674066550) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:293, README.md:126 | ok |
| [0.0.11333252-1...70415616](https://hashscan.io/testnet/transaction/0.0.11333252@1793969930.470415616) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:293 | ok |
| [0.0.11339718](https://hashscan.io/testnet/contract/0.0.11339718) | contract (archived) |  | runtime 3104 B | docs/EVIDENCE.md:325 | ok |
| [0.0.7314364-17...22320980](https://hashscan.io/testnet/transaction/0.0.7314364@1793971488.122320980) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:325 | ok |
| [0.0.11339720](https://hashscan.io/testnet/contract/0.0.11339720) | contract (archived) |  | runtime 15877 B | docs/EVIDENCE.md:326 | ok |
| [0.0.7314364-17...52167794](https://hashscan.io/testnet/transaction/0.0.7314364@1793971495.452167794) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:326 | ok |
| [0.0.11339725](https://hashscan.io/testnet/contract/0.0.11339725) | contract (archived) |  | runtime 5073 B | docs/EVIDENCE.md:327 | ok |
| [0.0.7314364-17...80224870](https://hashscan.io/testnet/transaction/0.0.7314364@1793971507.280224870) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:327 | ok |
| [0.0.7314364-17...75088301](https://hashscan.io/testnet/transaction/0.0.7314364@1793971542.575088301) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:333 | ok |
| [0.0.7314364-17...93584156](https://hashscan.io/testnet/transaction/0.0.7314364@1793971547.693584156) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:334 | ok |
| [0.0.7314364-17...94228108](https://hashscan.io/testnet/transaction/0.0.7314364@1793971571.194228108) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:335 | ok |
| [0.0.11339989](https://hashscan.io/testnet/contract/0.0.11339989) | contract (archived) |  | runtime 3730 B | docs/EVIDENCE.md:392 | ok |
| [0.0.7314364-17...09180764](https://hashscan.io/testnet/transaction/0.0.7314364@1793973211.309180764) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:392 | ok |
| [0.0.11339992](https://hashscan.io/testnet/contract/0.0.11339992) | contract (archived) |  | runtime 23759 B | docs/EVIDENCE.md:393 | ok |
| [0.0.7314364-17...98619187](https://hashscan.io/testnet/transaction/0.0.7314364@1793973238.198619187) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:393 | ok |
| [0.0.11339998](https://hashscan.io/testnet/contract/0.0.11339998) | contract (archived) |  | runtime 8807 B | docs/EVIDENCE.md:394 | ok |
| [0.0.7314364-17...83160364](https://hashscan.io/testnet/transaction/0.0.7314364@1793973249.483160364) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:394 | ok |
| [0.0.11340006](https://hashscan.io/testnet/contract/0.0.11340006) | contract (archived) |  | runtime 2035 B | docs/EVIDENCE.md:395 | ok |
| [0.0.7314364-17...19591005](https://hashscan.io/testnet/transaction/0.0.7314364@1793973289.919591005) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:395 | ok |
| [0.0.11340016](https://hashscan.io/testnet/contract/0.0.11340016) | contract (archived) |  | runtime 2205 B | docs/EVIDENCE.md:396 | ok |
| [0.0.7314364-17...48921375](https://hashscan.io/testnet/transaction/0.0.7314364@1793973323.248921375) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:396 | ok |
| [0.0.7314364-17...85154979](https://hashscan.io/testnet/transaction/0.0.7314364@1793973375.185154979) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:418 | ok |
| [0.0.7314364-17...29786380](https://hashscan.io/testnet/transaction/0.0.7314364@1793973384.629786380) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:419 | ok |
| [0.0.7314364-17...29230189](https://hashscan.io/testnet/transaction/0.0.7314364@1793973410.629230189) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:433 | ok |
| [0.0.7314364-17...69979525](https://hashscan.io/testnet/transaction/0.0.7314364@1793973436.669979525) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:434 | ok |
| [0.0.7314364-17...16551032](https://hashscan.io/testnet/transaction/0.0.7314364@1793973647.416551032) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:435 | ok |
| [0.0.7314364-17...22297535](https://hashscan.io/testnet/transaction/0.0.7314364@1793973830.022297535) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:436 | ok |
| [0.0.7314364-17...46026486](https://hashscan.io/testnet/transaction/0.0.7314364@1793973710.046026486) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:437 | ok |
| [0.0.11333252-1...07616004](https://hashscan.io/testnet/transaction/0.0.11333252@1793973749.307616004) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:443 | ok |
| [0.0.11333252-1...85360940](https://hashscan.io/testnet/transaction/0.0.11333252@1793973758.885360940) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:444 | ok |
| [0.0.11333252-1...44836264](https://hashscan.io/testnet/transaction/0.0.11333252@1793973758.144836264) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:445 | ok |
| [0.0.7314364-17...90586610](https://hashscan.io/testnet/transaction/0.0.7314364@1793973776.590586610) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:446 | ok |
| [0.0.7314364-17...54969725](https://hashscan.io/testnet/transaction/0.0.7314364@1793973922.254969725) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:464 | ok |
| [0.0.11333252-1...40502909](https://hashscan.io/testnet/transaction/0.0.11333252@1793973943.240502909) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:472 | ok |
| [0.0.11333252-1...19241023](https://hashscan.io/testnet/transaction/0.0.11333252@1793973947.419241023) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:473 | ok |
| [0.0.11333252-1...77011440](https://hashscan.io/testnet/transaction/0.0.11333252@1793973947.577011440) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:474 | ok |
| [0.0.7314364-17...81244937](https://hashscan.io/testnet/transaction/0.0.7314364@1793973975.081244937) | transaction (archived) | CONTRACT_REVERT_EXECUTED | CONTRACT_REVERT_EXECUTED | docs/EVIDENCE.md:494 | ok |
| [0.0.7314364-17...55943119](https://hashscan.io/testnet/transaction/0.0.7314364@1793974693.355943119) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:513 | ok |
| [0.0.7314364-17...17877057](https://hashscan.io/testnet/transaction/0.0.7314364@1793974806.917877057) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:514 | ok |
| [0.0.7314364-17...56516923](https://hashscan.io/testnet/transaction/0.0.7314364@1793974867.456516923) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:515 | ok |
| [0.0.7314364-17...35157523](https://hashscan.io/testnet/transaction/0.0.7314364@1793975076.335157523) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:516 | ok |
| [0.0.7314364-17...50273990](https://hashscan.io/testnet/transaction/0.0.7314364@1793975148.650273990) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:517 | ok |
| [0.0.7314364-17...86686405](https://hashscan.io/testnet/transaction/0.0.7314364@1793975212.586686405) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:518 | ok |
| [0.0.7314364-17...53059238](https://hashscan.io/testnet/transaction/0.0.7314364@1793975262.753059238) | transaction (archived) | SUCCESS | SUCCESS | docs/EVIDENCE.md:519 | ok |
| [0.0.7314364-17...91663990](https://hashscan.io/testnet/transaction/0.0.7314364@1793976431.091663990) | transaction | NO_SCHEDULING_ALLOWED_AFTER_SCHEDULED_RECURSION | NO_SCHEDULING_ALLOWED_AFTER_SCHEDULED_RECURSION | docs/EVIDENCE.md:530, README.md:147, ... | ok |
| [0.0.7314364-17...51368007](https://hashscan.io/testnet/transaction/0.0.7314364@1793977712.251368007) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:534 | ok |
| [0.0.11341323](https://hashscan.io/testnet/contract/0.0.11341323) | contract |  | runtime 2962 B | docs/EVIDENCE.md:538 | ok |
| [0.0.7314364-17...88950176](https://hashscan.io/testnet/transaction/0.0.7314364@1793978954.588950176) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:538, README.md:100 | ok |
| [0.0.11341326](https://hashscan.io/testnet/contract/0.0.11341326) | contract |  | runtime 6379 B | docs/EVIDENCE.md:539 | ok |
| [0.0.7314364-17...38929669](https://hashscan.io/testnet/transaction/0.0.7314364@1793978957.638929669) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:539, README.md:101 | ok |
| [0.0.11341528](https://hashscan.io/testnet/contract/0.0.11341528) | contract |  | runtime 3104 B | docs/EVIDENCE.md:540 | ok |
| [0.0.7314364-17...61485389](https://hashscan.io/testnet/transaction/0.0.7314364@1793979983.761485389) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:540, README.md:102 | ok |
| [0.0.11341529](https://hashscan.io/testnet/contract/0.0.11341529) | contract |  | runtime 15631 B | docs/EVIDENCE.md:541 | ok |
| [0.0.7314364-17...46409772](https://hashscan.io/testnet/transaction/0.0.7314364@1793979989.446409772) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:541, README.md:103 | ok |
| [0.0.11341530](https://hashscan.io/testnet/contract/0.0.11341530) | contract |  | runtime 5073 B | docs/EVIDENCE.md:542 | ok |
| [0.0.7314364-17...00892540](https://hashscan.io/testnet/transaction/0.0.7314364@1793979992.300892540) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:542, README.md:104 | ok |
| [0.0.11341628](https://hashscan.io/testnet/contract/0.0.11341628) | contract |  | runtime 23759 B | docs/EVIDENCE.md:543 | ok |
| [0.0.7314364-17...80390902](https://hashscan.io/testnet/transaction/0.0.7314364@1793980328.280390902) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:543, README.md:108 | ok |
| [0.0.11341636](https://hashscan.io/testnet/contract/0.0.11341636) | contract |  | runtime 2205 B | docs/EVIDENCE.md:544 | ok |
| [0.0.7314364-17...64551738](https://hashscan.io/testnet/transaction/0.0.7314364@1793980360.664551738) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:544, README.md:109 | ok |
| [0.0.7314364-17...23889452](https://hashscan.io/testnet/transaction/0.0.7314364@1793979998.723889452) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:547, README.md:105 | ok |
| [0.0.7314364-17...68341300](https://hashscan.io/testnet/transaction/0.0.7314364@1793980017.168341300) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:547, README.md:106 | ok |
| [0.0.7314364-17...75648188](https://hashscan.io/testnet/transaction/0.0.7314364@1793980024.675648188) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:547, README.md:107 | ok |
| [0.0.7314364-17...58553275](https://hashscan.io/testnet/transaction/0.0.7314364@1793980425.858553275) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:547, README.md:110 | ok |
| [0.0.7314364-17...72359298](https://hashscan.io/testnet/transaction/0.0.7314364@1793980444.372359298) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:547, README.md:111 | ok |
| [0.0.7314364-17...41621558](https://hashscan.io/testnet/transaction/0.0.7314364@1793980554.341621558) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:547, README.md:113 | ok |
| [0.0.7314364-17...00689981](https://hashscan.io/testnet/transaction/0.0.7314364@1793980592.500689981) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:549, README.md:178 | ok |
| [0.0.11333252-1...32603471](https://hashscan.io/testnet/transaction/0.0.11333252@1793980598.332603471) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:549, README.md:179 | ok |
| [0.0.11333252-1...81683574](https://hashscan.io/testnet/transaction/0.0.11333252@1793980599.981683574) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:549, README.md:180 | ok |
| [0.0.11333252-1...20678492](https://hashscan.io/testnet/transaction/0.0.11333252@1793980602.620678492) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:549, README.md:181 | ok |
| [0.0.7314364-17...89329045](https://hashscan.io/testnet/transaction/0.0.7314364@1793980736.789329045) | transaction | failure | CONTRACT_REVERT_EXECUTED | docs/EVIDENCE.md:549, README.md:182, ... | ok |
| [0.0.7314364-17...90739155](https://hashscan.io/testnet/transaction/0.0.7314364@1793980834.590739155) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:557, README.md:237 | ok |
| [0.0.7314364-17...40291226](https://hashscan.io/testnet/transaction/0.0.7314364@1793980911.340291226) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:558, README.md:238 | ok |
| [0.0.7314364-17...32736160](https://hashscan.io/testnet/transaction/0.0.7314364@1793981034.732736160) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:559, README.md:239 | ok |
| [0.0.7314364-17...56894431](https://hashscan.io/testnet/transaction/0.0.7314364@1793981428.956894431) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:560 | ok |
| [0.0.7314364-17...24005875](https://hashscan.io/testnet/transaction/0.0.7314364@1793981544.024005875) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:561 | ok |
| [0.0.7314364-17...17305300](https://hashscan.io/testnet/transaction/0.0.7314364@1793981618.317305300) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:562 | ok |
| [0.0.7314364-17...70577875](https://hashscan.io/testnet/transaction/0.0.7314364@1793982142.770577875) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:563 | ok |
| [0.0.7314364-17...57443985](https://hashscan.io/testnet/transaction/0.0.7314364@1793982496.157443985) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:578, README.md:69, ... | ok |
| [0.0.7314364-17...34508238](https://hashscan.io/testnet/transaction/0.0.7314364@1793982511.134508238) | transaction | failure | CONTRACT_REVERT_EXECUTED | docs/EVIDENCE.md:591 | ok |
| [0.0.7314364-17...22396023](https://hashscan.io/testnet/transaction/0.0.7314364@1793982519.722396023) | transaction | failure | CONTRACT_REVERT_EXECUTED | docs/EVIDENCE.md:592 | ok |
| [0.0.11333252-1...68877640](https://hashscan.io/testnet/transaction/0.0.11333252@1793982667.668877640) | transaction | SUCCESS | SUCCESS | docs/EVIDENCE.md:594 | ok |
| [0xc65A0788a9AE...1383d54c](https://hashscan.io/testnet/contract/0xc65A0788a9AE598aEAB5DbC529B7649a1383d54c) | contract |  | runtime 3730 B | README.md:61, README.md:92 | ok |
| [0x458b3b7CaDec...4E99ce1b](https://hashscan.io/testnet/contract/0x458b3b7CaDec64Cd0AE0B244d582006C4E99ce1b) | contract |  | runtime 23759 B | README.md:62, README.md:90 | ok |
| [0x81d1935e4170...626673dD](https://hashscan.io/testnet/contract/0x81d1935e41705DCD4c4499285c74c955626673dD) | contract |  | runtime 2962 B | README.md:85 | ok |
| [0x0D118059D67c...6837791f](https://hashscan.io/testnet/contract/0x0D118059D67cbe738aD86C4B8c25cdf06837791f) | contract |  | runtime 6379 B | README.md:86 | ok |
| [0x733bE9213C79...D2F74f15](https://hashscan.io/testnet/contract/0x733bE9213C79Be5dC3E3dD68FB126182D2F74f15) | contract |  | runtime 3104 B | README.md:87 | ok |
| [0x38ACd9F1FEED...a751d9e0](https://hashscan.io/testnet/contract/0x38ACd9F1FEED870b2507b1421bE887d9a751d9e0) | contract |  | runtime 15631 B | README.md:88 | ok |
| [0x63B6f03a6002...604f6a8a](https://hashscan.io/testnet/contract/0x63B6f03a60026626B6052D800864dD74604f6a8a) | contract |  | runtime 5073 B | README.md:89 | ok |
| [0x8FC7B1BBa8EE...17804B5B](https://hashscan.io/testnet/contract/0x8FC7B1BBa8EEdf5a4C9Ac9FEA746ABAd17804B5B) | contract |  | runtime 2205 B | README.md:91 | ok |
| [0x4125108453A1...4F3413Fb](https://hashscan.io/testnet/contract/0x4125108453A1E9c333b100a917F630b84F3413Fb) | contract |  | runtime 8807 B | README.md:93 | ok |
| [0x65C25Cc145f0...a8a2648a](https://hashscan.io/testnet/contract/0x65C25Cc145f0836C8fFAb83Bf9676e98a8a2648a) | contract |  | runtime 2035 B | README.md:94 | ok |
| [0.0.7314364-17...06969469](https://hashscan.io/testnet/transaction/0.0.7314364@1793978969.206969469) | transaction | SUCCESS | SUCCESS | README.md:113 | ok |
| [0.0.7314364-17...92267965](https://hashscan.io/testnet/transaction/0.0.7314364@1793979051.992267965) | transaction | SUCCESS | SUCCESS | README.md:113 | ok |
| [0.0.7314364-17...59888846](https://hashscan.io/testnet/transaction/0.0.7314364@1793979068.059888846) | transaction | SUCCESS | SUCCESS | README.md:113 | ok |
| [0.0.7314364-17...64268848](https://hashscan.io/testnet/transaction/0.0.7314364@1793979111.064268848) | transaction | SUCCESS | SUCCESS | README.md:113 | ok |
| [0.0.7314364-17...03942077](https://hashscan.io/testnet/transaction/0.0.7314364@1793979122.903942077) | transaction | SUCCESS | SUCCESS | README.md:113 | ok |
| [0.0.7314364-17...42368379](https://hashscan.io/testnet/transaction/0.0.7314364@1793979276.242368379) | transaction | SUCCESS | SUCCESS | README.md:113 | ok |
| [0.0.7314364-17...79479344](https://hashscan.io/testnet/transaction/0.0.7314364@1793979300.479479344) | transaction | SUCCESS | SUCCESS | README.md:113 | ok |
| [0.0.11333252](https://hashscan.io/testnet/account/0.0.11333252) | account |  | exists (0.0.11333252) | README.md:123 | ok |
| [0xE51950be227c...3C593f39](https://hashscan.io/testnet/contract/0xE51950be227c5A31B603e1343cD53e813C593f39) | contract (archived) |  | runtime 2921 B | README.md:153 | ok |
| [0x112167Ad230f...3BC97A8b](https://hashscan.io/testnet/contract/0x112167Ad230f4b733B756201FDe8b4ec3BC97A8b) | contract (archived) |  | runtime 6379 B | README.md:154 | ok |
| [0x54a665d52E2e...50C9A0ce](https://hashscan.io/testnet/contract/0x54a665d52E2e79bA3Ec46b20f8c2cfE950C9A0ce) | contract (archived) |  | runtime 3104 B | README.md:155 | ok |
| [0xfe702433E753...7B8fe640](https://hashscan.io/testnet/contract/0xfe702433E753ca4CA8dEDC3059987eCA7B8fe640) | contract (archived) |  | runtime 15877 B | README.md:156 | ok |
| [0xcf6DeBDfc01a...5dB705f7](https://hashscan.io/testnet/contract/0xcf6DeBDfc01a9DcafDBf0Ad45f4ebc185dB705f7) | contract (archived) |  | runtime 5073 B | README.md:157 | ok |
| [0xFcE311Ea7f4B...cC34A562](https://hashscan.io/testnet/contract/0xFcE311Ea7f4B4F8D5d897d48BFA2a21DcC34A562) | contract (archived) |  | runtime 23759 B | README.md:158 | ok |
| [0x506646D702C0...E32a3838](https://hashscan.io/testnet/contract/0x506646D702C00A19854eE1f28eF3F396E32a3838) | contract (archived) |  | runtime 2205 B | README.md:159 | ok |
| README.md:71 | marker | | **Settled x402 transaction (final demo run, paid from a 2-of-2 spend w | README.md:71 | pending demo run |
| README.md:73 | marker | | <!-- TODO(8.2-final): settled x402 transaction id from the PAYMENT-RES | README.md:73 | pending demo run |
| README.md:400 | marker | | <!-- TODO(8.2-final): confirm that the root `pnpm demo` script has lan | README.md:400 | pending demo run |
| README.md:413 | marker | | / Settled x402 payment, final run / TODO (see section 2) / | README.md:413 | pending demo run |
| README.md:425 | marker | | <!-- TODO(8.2-final): once the demo run is recorded, replace the two T | README.md:425 | pending demo run |

Checked 187 distinct links: 187 ok, 0 failed, 0 archived failures ignored, 5 pending demo run markers.
