# Task 5.4 report
Status: DONE. Commit 12fb874 "feat(x402): merchant service catalog and worker-side discovery".
Built: GET /catalog (unpaid, before payment middleware; publicUrl option, fallback http://localhost:<socket local port>); discover.ts (Service, DiscoveryResult {services, warnings}, discoverServices, cheapest, priceUnits via BigInt string math); exports appended to hedera index.
Deps added: zod to @casheth/hedera; supertest + @types/supertest to merchant.
TDD: both test files failed (module/route missing) before implementation; then passed. discover tests 5, catalog 1.
Concerns: hcs.test.ts and mirror.test.ts (live testnet/env) fail in hedera package, unrelated to this task. @casheth/shared had to be built in the fresh worktree.

## Fix round 1
Changed priceUnits to a single anchored regex /^(\d+)(?:\.(\d+))?$/ and reject frac.length > decimals (so "0.2500000" and "1." throw). Added tests: "0.2", "0.250000", decimals 0; rejects "0.1234567","0.2500000","abc",".5","1.","","-1","1.5e3","1,5"; "1.0" at 0 decimals.
Command: pnpm -F @casheth/hedera exec vitest run src/x402/discover.test.ts -> 1 file, 15 tests passed. Merchant catalog test passes; hedera and merchant builds pass.
Note: `pnpm test -- <file>` runs the whole suite (pre-existing hcs/mirror live failures remain, unrelated).
