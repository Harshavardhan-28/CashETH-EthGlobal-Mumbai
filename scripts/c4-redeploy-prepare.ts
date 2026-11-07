/**
 * Redeploy, step 0: clears the way for a new core stack (the facility is immutable in the SwapVM router, repayment
 * router and taker, and every `wire()` is one-shot). Redeploys so far: 2026-11-06, the CreditFacility schedule fix
 * (one scheduleCall per transaction); 2026-11-07, risk-priced credit (the credit opcode prices each seller from its
 * score, so the router, its argument encoding and the order builder change, and sellers get late marks in KYA).
 *
 *   pnpm -r build && pnpm tsx scripts/c4-redeploy-prepare.ts
 *
 *   1. balances - USDC and HBAR of the operator, coordinator, lenders, buyer and seller; the coordinator is
 *                 topped up to 25 HBAR (`openAndFund` can cost about 7 HBAR).
 *   2. dock     - every lender docks the strategies of the old stack and sets its Aqua allowances to zero (the
 *                 funds stay in the lenders' wallets; the new strategies then approve exactly what they ship).
 *   3. archive  - the old addresses and C2/C3/C4/strategy records go to `deployments/testnet/archive-<REDEPLOY>.json`;
 *                 addresses.json keeps only what is reused (Aqua, tUSDT, USDC), the old C2/C3/strategy records
 *                 are removed and c4.json restarts with `kept` (those contracts), the tUSDT mints and lender D's
 *                 account.
 *
 * Then, in order: `c2-register-demo.ts --skip-rejections`, `c3-deploy.ts`, `c4-deploy-and-wire.ts`,
 * `c4-register.ts`, `c5-allowance.ts`, `c4-ship-strategies.ts`, `c4-open-facility.ts`. Skipped when the archive
 * exists.
 */
import { existsSync, rmSync } from "node:fs";
import { loadAddresses } from "@casheth/shared";
import { accountBalances, archiveFile, clearAquaAllowances, dockOldStrategies, ensureCoordinatorHbar, printBalances, writeArchive, type OldStrategy } from "./lib/redeploy.js";
import { loadDeployment } from "./lib/c4.js";
import { readC4, writeC4, C4_FILE, type C4State } from "./c4-state.js";
import { operator as operatorClients, readJson, ROOT, writeJson } from "./spikes/lib.js";

const DEPLOYMENTS = `${ROOT}deployments/testnet`;
const MIN_COORDINATOR_HBAR = 25;
const REDEPLOY = "2026-11-07-risk-pricing";
const REASON = "Risk-priced credit: the credit opcode prices every fill from the seller's on-chain score (RiskPricing), lender strategies fund risk slabs instead of setting a rate, and KYA gives sellers late marks";
const ARCHIVE_FILE = archiveFile(REDEPLOY);

const balancesBefore = await accountBalances();
printBalances("balances before", balancesBefore);
await ensureCoordinatorHbar(balancesBefore, MIN_COORDINATOR_HBAR);

if (existsSync(ARCHIVE_FILE)) {
  console.log(`already prepared: ${ARCHIVE_FILE}`);
  process.exit(0);
}

const old = loadDeployment();
const strategies = readJson<{ strategies: OldStrategy[] }>(`${DEPLOYMENTS}/strategies.json`);

console.log("dock the old strategies");
const docks = await dockOldStrategies(old, strategies.strategies);
console.log("zero the Aqua allowances");
await clearAquaAllowances(old);

const oldC4 = readC4(operatorClients.wallet!.account!.address);
const records = Object.fromEntries(["c2", "c3"].map((n) => [n, readJson(`${DEPLOYMENTS}/${n}.json`)]));
writeArchive(ARCHIVE_FILE, {
  archivedAt: new Date().toISOString(),
  reason: REASON,
  addresses: old.addresses,
  ...records,
  c4: oldC4,
  strategies,
  docks,
});

const { chainId, usdc, deployer, aqua, tUsdt, deployedBlock } = loadAddresses();
writeJson(`${DEPLOYMENTS}/addresses.json`, { chainId, usdc, deployer, aqua, tUsdt, deployedBlock });
for (const gone of ["c2", "c3", "strategies"]) rmSync(`${DEPLOYMENTS}/${gone}.json`);
rmSync(C4_FILE);
const { aqua: keptAqua, tUsdt: keptTUsdt } = oldC4.deploy!;
const { kya: _registeredOnOldKya, ...lenderD } = oldC4.lenderD!;
const restart: C4State = {
  network: "testnet",
  chainId: 296,
  operator: oldC4.operator,
  kept: { aqua: keptAqua, tUsdt: keptTUsdt },
  tUsdtMints: oldC4.tUsdtMints!,
  lenderD,
};
writeC4(restart);
console.log(`archived to ${ARCHIVE_FILE}; addresses.json keeps aqua ${aqua}, tUSDT ${tUsdt}`);
