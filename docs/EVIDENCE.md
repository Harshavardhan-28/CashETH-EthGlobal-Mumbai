# CashETH on-chain evidence

Every link below is a Hedera testnet (chain 296) HashScan link for activity produced by this repo's code and scripts.

## Accounts

Demo agent accounts created by `scripts/setup-accounts.ts`: ECDSA keys with EVM-address aliases, 20 HBAR each, USDC (`0.0.429274`) associated. Initial USDC: buyer 10, lenderA 4, lenderB 2, lenderC 1.

| Label | Account | EVM address |
| --- | --- | --- |
| seller | [0.0.11337987](https://hashscan.io/testnet/account/0.0.11337987) | `0x164334ee48b6ab0c07514af2a84646b23f3dcf0f` |
| buyer | [0.0.11337988](https://hashscan.io/testnet/account/0.0.11337988) | `0xf5ffbcd1e9ca403fec295127eace1a3674f949c9` |
| workerResearch | [0.0.11337989](https://hashscan.io/testnet/account/0.0.11337989) | `0xbead36c554746b00eb2a3b87ce38adc926ddf62f` |
| workerCompute | [0.0.11337990](https://hashscan.io/testnet/account/0.0.11337990) | `0x3f8960701e2bb81869a0e64259e191cdb6790858` |
| lenderA | [0.0.11337991](https://hashscan.io/testnet/account/0.0.11337991) | `0xc502fe381481abd2e56921dc58dfc3ca3776a096` |
| lenderB | [0.0.11337992](https://hashscan.io/testnet/account/0.0.11337992) | `0x502ea0745ddd16128b8f649394cd0c8c93fed238` |
| lenderC | [0.0.11337993](https://hashscan.io/testnet/account/0.0.11337993) | `0xeaabaef2df2bd6c1e13207573b233d1d33042377` |
| coordinator | [0.0.11337994](https://hashscan.io/testnet/account/0.0.11337994) | `0x45fdf15ed9c6327deb0e57db6b78f592b254ab68` |
| cosigner | [0.0.11337995](https://hashscan.io/testnet/account/0.0.11337995) | `0xdd479f3ca489d481374d04a409d7f0e7a972c9e4` |
| kyaIssuer | [0.0.11337996](https://hashscan.io/testnet/account/0.0.11337996) | `0x8918f395c2e80066901a01d2cbe134ca9d31f582` |
| lenderD (C4, `scripts/c4-register.ts`; 1 USDC) | [0.0.11340117](https://hashscan.io/testnet/account/0.0.11340117) | `0x9a81f51aaca1bf584d21f44c40be9ddb12ef5690` |

## Spike S1: Aqua + SwapVM on Hedera

Official 1inch `AquaRouter` and an unmodified `AquaSwapVMRouter` (runtime 21,981 B) deployed to Hedera testnet; lender A shipped a 1 USDC / 1 TOKENB XYC strategy and `SpikeTaker` filled 0.1 TOKENB → USDC against real HTS USDC (`0.0.429274`). Produced by `contracts/script/00_DeployAquaSpike.s.sol` and `scripts/spikes/s1-aqua-xyc.ts`; machine-readable record in `deployments/testnet/spike-aqua.json`.

**Deploy path that worked:** `forge script script/00_DeployAquaSpike.s.sol --rpc-url testnet --private-key $HEDERA_OPERATOR_KEY --broadcast --legacy --slow --skip-simulation --gas-estimate-multiplier 130` through the Hashio relay. The router's ~23.5 KB initcode was accepted by the relay as an ordinary EVM creation; the `ContractCreateFlow` fallback was not needed. `--skip-simulation` is required because forge's replay simulation cannot execute the HTS `associate()` call in `SpikeTaker`'s constructor (revm has no HTS system contract).

Transaction ids of EVM transactions show the Hashio relay (`0.0.7314364`) as the transaction payer; gas is charged to the signing EVM account (operator `0.0.11333252` for creations, mints and the fill; lender A for approvals and ship).

### Contracts

| Contract | Contract id | EVM address | Creation tx | Gas used |
| --- | --- | --- | --- | --- |
| AquaRouter (official Aqua registry, `lib/aqua` @ 86abe30f) | [0.0.11338088](https://hashscan.io/testnet/contract/0.0.11338088) | `0xE696943051d272e63b02429C4449174Df73AEFEF` | [0.0.7314364@1793962858.989301503](https://hashscan.io/testnet/transaction/0.0.7314364@1793962858.989301503) | 887,121 |
| AquaSwapVMRouter (unmodified, `lib/swap-vm` @ f9f4acfe) | [0.0.11338089](https://hashscan.io/testnet/contract/0.0.11338089) | `0xad3b3E9C8569d3A98F46638706e988593a60F177` | [0.0.7314364@1793962861.258758871](https://hashscan.io/testnet/transaction/0.0.7314364@1793962861.258758871) | 4,849,926 |
| SpikeTokenB (TOKENB, 6-dec ERC-20) | [0.0.11338091](https://hashscan.io/testnet/contract/0.0.11338091) | `0x5E8D4A662506a181F92f13B227BdAe2035aFb112` | [0.0.7314364@1793962867.786577686](https://hashscan.io/testnet/transaction/0.0.7314364@1793962867.786577686) | 576,050 |
| SpikeOrderBuilder | [0.0.11338092](https://hashscan.io/testnet/contract/0.0.11338092) | `0x044A0A14DcD0F43c38c2531d76579e2a089A8E83` | [0.0.7314364@1793962870.241347429](https://hashscan.io/testnet/transaction/0.0.7314364@1793962870.241347429) | 1,188,224 |
| SpikeTaker | [0.0.11338095](https://hashscan.io/testnet/contract/0.0.11338095) | `0xCaB7F04e7AAA2780B86E5688a69ad9DeFFC7BfbA` | [0.0.7314364@1793962871.567047578](https://hashscan.io/testnet/transaction/0.0.7314364@1793962871.567047578) | 1,156,573 |

`SpikeTaker` associated itself with USDC in its constructor (HIP-719 `associate()` on the facade); the mirror node lists `0.0.429274` on `0.0.11338095`.

### Ship (lender A [0.0.11337991](https://hashscan.io/testnet/account/0.0.11337991))

Strategy hash (`keccak256(abi.encode(order))` = `router.hash(order)`): `0xc9125dc82af7085ec0de8c18e9265f9f61f7ea3636903ef40e29f0b412f88af3`

| Step | Transaction |
| --- | --- |
| mint 1 TOKENB to lender A | [0.0.7314364@1793963051.329017528](https://hashscan.io/testnet/transaction/0.0.7314364@1793963051.329017528) |
| mint 0.1 TOKENB to SpikeTaker | [0.0.7314364@1793963054.440703515](https://hashscan.io/testnet/transaction/0.0.7314364@1793963054.440703515) |
| lender A approves Aqua for 1 USDC (HTS allowance via facade) | [0.0.7314364@1793963063.234109476](https://hashscan.io/testnet/transaction/0.0.7314364@1793963063.234109476) |
| lender A approves Aqua for TOKENB | [0.0.7314364@1793963066.063489567](https://hashscan.io/testnet/transaction/0.0.7314364@1793963066.063489567) |
| lender A ships XYC strategy | [0.0.7314364@1793963071.121512471](https://hashscan.io/testnet/transaction/0.0.7314364@1793963071.121512471) |

### Fill

`router.quote` from the SpikeTaker address: 100000 TOKENB in → 90909 USDC out (XYC: ⌊0.1·1/1.1⌋). Fill used the quote as min-out threshold.

- `SpikeTaker.fill(order, 100000, takerData)`: [0.0.7314364@1793963078.419965153](https://hashscan.io/testnet/transaction/0.0.7314364@1793963078.419965153) (EVM hash `0x21939d23b9dd6d3c3b1022ec934ce18527125e077558f6f14491a59da911e322`, gas used 141,141)
- HTS child transfer at `1793963082.954511105`: lender A −90,909 USDC (`is_approval: true`, Aqua spending lender A's HTS allowance), SpikeTaker `0.0.11338095` +90,909 USDC

| Balance (6-dec units) | Before | After | Delta |
| --- | --- | --- | --- |
| lender A USDC (mirror) | 4,000,000 | 3,909,091 | -90,909 |
| SpikeTaker USDC (mirror) | 0 | 90,909 | +90,909 |
| lender A TOKENB | 1,000,000 | 1,100,000 | +100,000 |
| SpikeTaker TOKENB | 100,000 | 0 | -100,000 |

HBAR spent: operator ~11.1 HBAR (five creations, two mints, the fill); lender A ~1.06 HBAR (two approvals, ship).

Findings for later tasks: HTS `approve(spender, type(uint256).max)` through the facade fails (`CONTRACT_EXECUTION_EXCEPTION` in simulation; HTS allowances are int64), so USDC approvals must be bounded. The relay's gas estimate for a facade `approve` was ~822k.

## Spike S2: HTS facade from a contract

`AssocProbe` associates itself with HTS USDC (`0.0.429274`) through the HIP-719 facade in its constructor, then moves USDC with the facade's ERC-20 `transferFrom` (spending the operator's HTS allowance) and `transfer`. Produced by `contracts/script/01_DeploySpikeS2.s.sol` and `scripts/spikes/s2-facade.ts`; machine-readable record in `deployments/testnet/spike-s2.json`.

AssocProbe: [0.0.11338193](https://hashscan.io/testnet/contract/0.0.11338193) (`0xE51e79F36406b35a5F164b39079806EC7B10070d`). `isAssociated()` returns `true` and the mirror node lists `0.0.429274` on `0.0.11338193`.

| Step | Transaction | Gas limit | Gas used |
| --- | --- | --- | --- |
| deploy `AssocProbe(usdc)` (constructor calls `associate()`) | [0.0.7314364@1793963631.806935109](https://hashscan.io/testnet/transaction/0.0.7314364@1793963631.806935109) | 1,448,718 | 1,006,671 |
| operator `approve(probe, 1_000_000)` on the facade | [0.0.7314364@1793963643.076091991](https://hashscan.io/testnet/transaction/0.0.7314364@1793963643.076091991) | 1,068,485 | 727,020 |
| `probe.pull(operator, 500_000)` (facade `transferFrom`) | [0.0.7314364@1793963646.030791456](https://hashscan.io/testnet/transaction/0.0.7314364@1793963646.030791456) | 63,174 | 42,630 |
| `probe.push(operator, 500_000)` (facade `transfer`) | [0.0.7314364@1793963655.477482784](https://hashscan.io/testnet/transaction/0.0.7314364@1793963655.477482784) | 63,131 | 42,599 |

| USDC (6-dec units, mirror) | Before | After pull | After push |
| --- | --- | --- | --- |
| AssocProbe `0.0.11338193` | 0 | 500,000 | 0 |
| operator `0.0.11333252` | 3,000,000 | 2,500,000 | 3,000,000 |

The pull's HTS child transfer (`1793963653.433925105`) debits the operator with `is_approval: true`, i.e. the probe spent the operator's HTS allowance; 500,000 of the 1,000,000 allowance remains.

Findings for later tasks: a constructor that calls `associate()` costs ~1.0M gas in total (gas limit for deploys with association: budget ~1.5M); a facade `approve` uses ~727k gas, so set ~1.1M; `transferFrom`/`transfer` from a contract are cheap (~43k).

## Spike S4: HSS self-scheduled contract call (HIP-1215)

`AlarmProbe` asks the Hedera Schedule Service (`0x16b`) to call its own `ring(nonce)` 90 seconds later; the network executed it at the requested consensus second with the probe as `msg.sender` (`ring` requires `msg.sender == address(this)`). A second schedule (600 s) was deleted with `deleteSchedule` before it fired. Produced by `contracts/script/02_DeploySpikeS4.s.sol` and `scripts/spikes/s4-hss.ts`; machine-readable record in `deployments/testnet/spike-s4.json`.

AlarmProbe: [0.0.11338265](https://hashscan.io/testnet/contract/0.0.11338265) (`0xF0D452537736187b0793D3caBC7bb7E7478C9F74`), funded with 5 HBAR.

| Step | Transaction | Gas limit | Gas used |
| --- | --- | --- | --- |
| deploy `AlarmProbe` | [0.0.7314364@1793963937.665626821](https://hashscan.io/testnet/transaction/0.0.7314364@1793963937.665626821) | 442,393 | 295,379 |
| fund 5 HBAR through `receive()` | [0.0.7314364@1793963939.125757865](https://hashscan.io/testnet/transaction/0.0.7314364@1793963939.125757865) | 62,300 | 21,067 |
| `schedule(90)` → schedule [0.0.11338268](https://hashscan.io/testnet/schedule/0.0.11338268) | [0.0.7314364@1793963948.917566541](https://hashscan.io/testnet/transaction/0.0.7314364@1793963948.917566541) | 2,134,962 | 1,458,281 |
| network executes `ring(0)` (scheduled `CONTRACTCALL`, `SUCCESS`) | [1793964046.045736810](https://hashscan.io/testnet/transaction/1793964046.045736810) | 200,000 | 44,893 |
| `schedule(600)` → schedule [0.0.11338283](https://hashscan.io/testnet/schedule/0.0.11338283) | [0.0.7314364@1793964052.726185880](https://hashscan.io/testnet/transaction/0.0.7314364@1793964052.726185880) | 2,111,821 | 1,441,193 |
| `cancel(0.0.11338283)` (`deleteSchedule`) | [0.0.7314364@1793964061.192393677](https://hashscan.io/testnet/transaction/0.0.7314364@1793964061.192393677) | 59,277 | 39,774 |

Executed schedule `0.0.11338268` (mirror `/schedules/0.0.11338268`): `expiration_time` 1793964046.000000000, `executed_timestamp` 1793964046.045736810, `wait_for_expiry: true`, `creator_account_id` 0.0.11333252 (operator), `payer_account_id` 0.0.11338265 (the probe). `hasScheduleCapacity(expiry, 200000)` returned `true` before each schedule.

`Rang` log on `0.0.11338265` at consensus 1793964046.045736810 (EVM hash `0xc836a6e6ab63c87647d4958c6084e89f32a462984b14eedc3046b6f82614e042`): `Rang(nonce = 0, at = 1793964045)`; `rings()` = 1 afterwards. Calldata `0xec73ae46…00` = `ring(0)`.

Deleted schedule `0.0.11338283` (mirror `/schedules/0.0.11338283`): `deleted: true`, `executed_timestamp: null`.

Costs: the scheduled execution was paid by the probe (0.05566732 HBAR, probe balance 5 → 4.94433268 HBAR); each `schedule()` cost the operator ~1.81 HBAR (≈1.45M gas).

Findings for later tasks:
- The Hashio relay cannot estimate gas for a contract creation that carries value (`eth_estimateGas` → "to field must not be empty"; the same creation with value 0 estimates fine), and Solidity forbids `gas` on `new`. Fund HBAR-holding contracts through `receive()` in a second transaction with an explicit gas limit (forge uses an explicit call `gas` as the tx limit), or send the creation with an explicit gas limit outside forge.
- `scheduleCall` is expensive: ~1.45M gas per call (relay estimate ×1.3 ≈ 2.1M limit). `deleteSchedule` is cheap (~40k).
- The scheduled call ran in the first consensus round after the expiry second (46 ms after it); `block.timestamp` inside the call was 1 second earlier than the expiry second, so code run by a schedule must not require `block.timestamp >= expiry`.
- The mirror contract result for the executed call reports `from` as the relay account (`0x…6f9bbc` = 0.0.7314364, the payer in the transaction id), but in the EVM `msg.sender` was the probe, as the passing `msg.sender == address(this)` check shows.

## Spike S3: x402 payment of 0.25 USDC, single key then 2-of-2 co-signed

A worker agent paid our own x402 merchant (`apps/merchant`, `GET /research?topic=hedera x402`, price "0.25") in USDC [0.0.429274](https://hashscan.io/testnet/token/0.0.429274) to merchant [0.0.11333304](https://hashscan.io/testnet/account/0.0.11333304) on `hedera:testnet`, settled by a public x402 facilitator that pays the fee. Produced by `scripts/spikes/s3-x402.ts` (`@x402/core`, `@x402/hedera`, `@x402/express`, `@x402/fetch` 2.30.0); machine-readable record in `deployments/testnet/spike-s3.json`.

| Payment | Payer | Facilitator (fee payer) | Settlement transaction | HTTP |
| --- | --- | --- | --- | --- |
| A: single ECDSA key | WORKER_RESEARCH [0.0.11337989](https://hashscan.io/testnet/account/0.0.11337989) | https://x402.org/facilitator (0.0.9185802) | [0.0.9185802@1793964900.434830214](https://hashscan.io/testnet/transaction/0.0.9185802-1793964900-434830214) | 200 |
| B: 2-of-2 KeyList (worker + policy co-signer) | spend wallet [0.0.11338499](https://hashscan.io/testnet/account/0.0.11338499) | https://x402.org/facilitator (0.0.9185802) | [0.0.9185802@1793964918.249682742](https://hashscan.io/testnet/transaction/0.0.9185802-1793964918-249682742) | 200 |

| USDC (6-dec units, mirror) | Before | After |
| --- | --- | --- |
| A payer WORKER_RESEARCH `0.0.11337989` | 300,000 | 50,000 |
| A merchant `0.0.11333304` | 0 | 250,000 |
| B payer spend wallet `0.0.11338499` | 300,000 | 50,000 |
| B merchant `0.0.11333304` | 250,000 | 500,000 |

402 PaymentRequirements returned by the merchant (decoded `PAYMENT-REQUIRED` header, part A):

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:4021/research?topic=hedera%20x402",
    "description": "Deterministic research note on a topic",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "hedera:testnet",
      "amount": "250000",
      "asset": "0.0.429274",
      "payTo": "0.0.11333304",
      "maxTimeoutSeconds": 300,
      "extra": {
        "feePayer": "0.0.9185802"
      }
    }
  ]
}
```

Spend wallet [0.0.11338499](https://hashscan.io/testnet/account/0.0.11338499): key `KeyList([worker-research 03992d6204ee…, cosigner 0.0.11337995 031ca1230064…], threshold 2)`, no EVM alias, created in [0.0.11333252@1793964911.818280874](https://hashscan.io/testnet/transaction/0.0.11333252-1793964911-818280874), USDC associated with both signatures in [0.0.11333252@1793964913.286550799](https://hashscan.io/testnet/transaction/0.0.11333252-1793964913-286550799), funded 300,000 units in [0.0.11333252@1793964912.847079064](https://hashscan.io/testnet/transaction/0.0.11333252-1793964912-847079064). The worker key signs the facilitator-paid TransferTransaction (built by `@x402/hedera`'s `createClientHederaSigner`), then the policy co-signer adds its signature only after checking `payTo`, `asset` and `amount <= 250000`. The facilitator's `/verify` accepted the two signatures against the wallet's on-chain KeyList and its `/settle` reached consensus with `SUCCESS`.

Negative check: the same wallet paying with the worker signature only (no co-signer) was refused by https://x402.org/facilitator: HTTP 402 `{"error":"invalid_exact_hedera_payload_signature_invalid"}`; the wallet's USDC stayed at 50,000 → 50,000.

Each settlement was checked on the mirror node (`/api/v1/transactions/<id>`, id form `0.0.x-seconds-nanos`): result `SUCCESS`, type `CRYPTOTRANSFER`, USDC −250,000 from the payer and +250,000 to the merchant; the transaction id's account is the facilitator's fee payer.

Paid response body (part B), with `paidWith.transactionId` taken from the settlement:

```json
{
  "topic": "hedera x402",
  "summary": "Research note on \"hedera x402\": x402 turns HTTP 402 into a payment handshake. The server quotes PaymentRequirements, the client returns a signed Hedera TransferTransaction, and a facilitator pays the fee and settles it, so \"hedera x402\" was delivered against a settled USDC transfer.",
  "sources": [
    "https://docs.hedera.com/solutions/ai/x402",
    "https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md"
  ],
  "paidWith": {
    "transactionId": "0.0.9185802@1793964918.249682742"
  }
}
```

## Funding

USDC (HTS `0.0.429274`, 6 decimals) balances read live from the mirror node on 2026-11-06, after spikes S1 to S4:

| Label | Account | USDC units |
| --- | --- | --- |
| operator | 0.0.11333252 | 2,400,000 |
| merchant | 0.0.11333304 | 500,000 |
| buyer | 0.0.11337988 | 10,000,000 |
| lenderA | 0.0.11337991 | 3,909,091 |
| lenderB | 0.0.11337992 | 2,000,000 |
| lenderC | 0.0.11337993 | 1,000,000 |
| workerResearch | 0.0.11337989 | 50,000 |
| spike spend wallet (2-of-2) | 0.0.11338499 | 50,000 |
| SpikeTaker contract | 0.0.11338095 | 90,909 |
| seller, workerCompute, coordinator, cosigner, kyaIssuer | | 0 |
| **Total** | | **20,000,000** |

**Demo need:** lenders A 4,000,000 + B 2,000,000 + C 1,000,000 (C is never filled), buyer 10,000,000 for repayment, worker spend wallets 0 (the facility funds them just in time), plus about 500,000 slack = **17,500,000**.

**Verdict: funds suffice, no faucet request needed.** 20,000,000 on hand against 17,500,000 needed. The only gap is that lender A is 90,909 below its 4,000,000 target (that amount sits in `SpikeTaker` after the S1 fill); lenders B, C and the buyer are already at target. To top lender A up, either run `SpikeTaker.sweep(usdc, operator)` as the contract owner (the operator) to recover the 90,909, or let the next `pnpm setup:accounts` run fund lender A's 90,909 shortfall from the operator (it falls back to the operator when the merchant is short). After either, the operator holds about 2.3 to 2.4 USDC of slack, plus the merchant's 0.5 and about 0.1 stranded in the two spike wallets (recoverable with `scripts/sweep-usdc.ts`).

If a later run does need more, the fallback is: open `https://faucet.circle.com`, select Hedera Testnet, paste the operator account id `0.0.11333252` (associated with USDC), and request 10 USDC per request. Assumption: the faucet gives 10 USDC per request and is rate-limited to a few requests per day. One request would let `pnpm setup:accounts` fund everything from the operator (lenders 7, buyer 10 when the merchant is empty) with margin; `setup-accounts.ts` throws a clear shortfall error naming both sources if neither can cover a top-up.

## C2: registries

> This section describes the first deployment (archived in `deployments/testnet/archive-2026-11-06-redeploy.json`); the live stack was redeployed, see [C4 redeploy](#c4-redeploy-hedera-one-schedule-per-transaction).

Deployed by `contracts/script/01_DeployCore.s.sol` through the Hashio relay from the operator (owner of both), driven by `scripts/c2-register-demo.ts`; addresses in `deployments/testnet/addresses.json`, full run record in `deployments/testnet/c2.json`. Nothing is wired yet (both `wire` calls are one-time; Tasks 3.6/4.3 wire them).

### Contracts

| Contract | Address | Contract id | Deploy tx |
| --- | --- | --- | --- |
| KYARegistry (issuer = KYA issuer 0.0.11337996) | `0xE51950be227c5A31B603e1343cD53e813C593f39` | [0.0.11338820](https://hashscan.io/testnet/contract/0.0.11338820) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966394.171576721) |
| ReceivableRegistry (USDC facade `0x…068cDa`) | `0x112167Ad230f4b733B756201FDe8b4ec3BC97A8b` | [0.0.11338823](https://hashscan.io/testnet/contract/0.0.11338823) | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966402.245288564) |

### Agent registrations (`KYARegistry.register`, sent by the KYA issuer)

`uaidHash = keccak256(evmAddress)` placeholder until Task 2.4 publishes UAIDs; `expiresAt = 0`; `mandateHash = keccak256("mandate-v1-<label>")`; `ownerGroup = keccak256(<group>)`.

| Agent | EVM address | Role | Level | Owner group | Tx |
| --- | --- | --- | --- | --- | --- |
| seller | `0x164334EE48b6AB0c07514af2a84646b23f3dCF0f` | 1 Seller | 2 | `seller-co` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966413.731996335) |
| buyer | `0xf5FFbCd1e9ca403Fec295127EAcE1A3674f949c9` | 2 Buyer | 3 | `buyer-co` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966426.623337776) |
| workerResearch | `0xbeAD36C554746b00eb2a3B87cE38aDc926Ddf62F` | 3 Worker | 2 | `seller-co` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966440.862555880) |
| workerCompute | `0x3f8960701E2Bb81869A0e64259E191cdB6790858` | 3 Worker | 2 | `seller-co` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966452.503597519) |
| lenderA | `0xc502fe381481aBD2E56921Dc58DFC3ca3776a096` | 4 Lender | 2 | `lender-a` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966466.763342193) |
| lenderB | `0x502ea0745ddd16128B8f649394cd0C8c93FEd238` | 4 Lender | 2 | `lender-b` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966481.534382158) |
| lenderC | `0xeaABAEF2DF2BD6c1e13207573B233d1D33042377` | 4 Lender | 2 | `lender-c` | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966492.515648279) |

### Buyer-signed confirmation rejected on-chain

The buyer signed the demo `ReceivableConfirmation` with `@casheth/shared` `signReceivableConfirmation`: amount 10000000 (10 USDC), dueDate 1796558499 (now + 30 days), `buyerRef = keccak256("PO-1001")`, `detailsCommitment = keccak256("demo-invoice-1001")`, `payTo = 0x0000000000000000000000000000000000000001` (stand-in: no repayment router is wired, so no payee can match), nonce 0, deadline 1794052899 (now + 1 day). The TypeScript digest `0x32180664405580d25ddfc7cafd2083500605d6056f42ebb8b2622713bb394337` equals the deployed contract's `hashConfirmation`; receivable id `0xdc9091478f8a1d866c1c576f18099bb2c18b780ff161ee7ed283ec10950ff7e3` equals `computeId`.

**Dry run (`eth_call` via viem `simulateContract`)** of the valid signed confirmation reverts `WRONG_PAYEE()`. `register` checks duplicate, signature, then payee, so the signature verified; every later check was read from chain state and passes, so the payee is the only failing check:

- duplicate: state(id) = 0 (None)
- term: dueDate - now = 30 days (1..120), deadline in 24 h
- nonce: nonces(buyer) = 0, confirmation nonce = 0
- currency: USDC() = 0x0000000000000000000000000000000000068cDa
- kya: level(buyer) = 3 (>= 3), level(seller) = 2 (>= 2)
- ownerSeparation: ownerGroup(buyer) != ownerGroup(seller): true
- payee: repaymentRouter() = 0x0000000000000000000000000000000000000000 (unwired), payTo = 0x0000000000000000000000000000000000000001

**Real reverting transactions** (submitted by the coordinator 0.0.11337994 with gas 300,000; revert data read from mirror `GET /contracts/results/{hash}` → `error_message`, matched against the error selector and decoded with the synced ABI):

| Submission | Tx | Mirror result | error_message | Decoded |
| --- | --- | --- | --- | --- |
| signed confirmation, unwired payee | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966502.770050429) | CONTRACT_REVERT_EXECUTED | `0x9c0c203d` | `WRONG_PAYEE()` |
| same confirmation, one byte of `r` flipped | [tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793966532.109597123) | CONTRACT_REVERT_EXECUTED | `0x48fb71e5` | `BAD_BUYER_SIG()` |

`DUPLICATE_RECEIVABLE` on testnet is proven after wiring (Task 4.3).
## C2: HCS topic, HCS-14 profiles and receivable NFT collection

Produced by `scripts/c2-topic-and-nft.ts` on 2026-11-06. Ids are in `deployments/testnet/hedera.json`.

- HCS audit topic: [0.0.11338927](https://hashscan.io/testnet/topic/0.0.11338927) (memo `CashETH audit v1`, submit key = operator, so only the orchestrator can write)
- Receivable NFT collection: [0.0.11338934](https://hashscan.io/testnet/token/0.0.11338934) (`CashETH Receivable` / `CRCV`, non-fungible, infinite supply, treasury and supply key = operator). No serial is minted yet; the first mint follows the on-chain receivable registration in Task 4.3.
- Creation transactions: topic [0.0.11333252@1793966819.849217866](https://hashscan.io/testnet/transaction/0.0.11333252@1793966819.849217866) (fee 0.29 HBAR), collection [0.0.11333252@1793966833.582306123](https://hashscan.io/testnet/transaction/0.0.11333252@1793966833.582306123) (fee 14.59 HBAR). Mirror node confirms: topic submit key ECDSA, no admin key; token `NON_FUNGIBLE_UNIQUE`, `INFINITE`, total supply 0, treasury `0.0.11333252`, ECDSA supply key, no admin key.
- Sequence numbers 11 and later include liveness probes from `packages/hedera/src/hcs.test.ts`; they carry `"test": true` and no `agentUaid`, so consumers can skip them.

Each agent's UAID comes from the standards SDK's HCS-14 AID generator (`createUaid` in `@hashgraphonline/standards-sdk@0.1.192`): SHA-384 over the canonical agent data (registry `casheth`, name, version `1`, protocol `mcp`, nativeId = CAIP-10 Hedera account, no skills), base58-encoded, with `uid`, `registry`, `proto` and `nativeId` routing params. Each profile is published as an `AgentRegistered` audit message; the sequence number links to its transaction.

| Agent | Account | UAID | HCS seq |
| --- | --- | --- | --- |
| CashETH Seller | 0.0.11337987 | `uaid:aid:3qySZMLB3Vi66NPMjb6xxahguEQmxLktaQSSZhLY2ec6xoaR5mTezhZcg368sn2kby;uid=0.0.11337987;registry=casheth;proto=mcp;nativeId=hedera:testnet:0.0.11337987` | [1](https://hashscan.io/testnet/transaction/0.0.11333252@1793966855.703107777) |
| CashETH Buyer | 0.0.11337988 | `uaid:aid:6n8CxWdsJmRjGgDobg5kTRrgVo84isyzALyeFCZw2oRDASckSXrpa9pa2bkuPQ2o3f;uid=0.0.11337988;registry=casheth;proto=mcp;nativeId=hedera:testnet:0.0.11337988` | [2](https://hashscan.io/testnet/transaction/0.0.11333252@1793966862.493865324) |
| CashETH Research Worker | 0.0.11337989 | `uaid:aid:6vYimBkEr5Tg45D478dN7dBRXBEapLwWQW9TXFcioPgLszQP7KB4tt7Yh6aEfjbmSJ;uid=0.0.11337989;registry=casheth;proto=mcp;nativeId=hedera:testnet:0.0.11337989` | [3](https://hashscan.io/testnet/transaction/0.0.11333252@1793966875.115936608) |
| CashETH Compute Worker | 0.0.11337990 | `uaid:aid:9Jgrz4SisnEynTLNHkRzAFBzrrmtADeFo1CgW6UiY3qQEAib8cQuJe4aggNTmdTRdk;uid=0.0.11337990;registry=casheth;proto=mcp;nativeId=hedera:testnet:0.0.11337990` | [4](https://hashscan.io/testnet/transaction/0.0.11333252@1793966895.352273481) |
| CashETH Lender A | 0.0.11337991 | `uaid:aid:3sRtyrb6rzW2pVT9qAotipLUQr4yT6LLsKRa1KUfEHwEzhqkZHLRfjwCcYMN2sNv36;uid=0.0.11337991;registry=casheth;proto=mcp;nativeId=hedera:testnet:0.0.11337991` | [5](https://hashscan.io/testnet/transaction/0.0.11333252@1793966912.572098662) |
| CashETH Lender B | 0.0.11337992 | `uaid:aid:7Fd7vFnynn8ZZpY9WhFpfWBcybPd4ZqhJyagQ5xPCjXfMoG9r6enAYxCFFRU2JD5hx;uid=0.0.11337992;registry=casheth;proto=mcp;nativeId=hedera:testnet:0.0.11337992` | [6](https://hashscan.io/testnet/transaction/0.0.11333252@1793966911.730993138) |
| CashETH Lender C | 0.0.11337993 | `uaid:aid:5Tts6yLfkJmBqJRWNY2YZuTpRE8B8RFPigaQisxTPs4NR82AXTTLrF9CwqxUwUbW6y;uid=0.0.11337993;registry=casheth;proto=mcp;nativeId=hedera:testnet:0.0.11337993` | [7](https://hashscan.io/testnet/transaction/0.0.11333252@1793966918.450289987) |
| CashETH Coordinator | 0.0.11337994 | `uaid:aid:X7NddMfvkJFiNmyAjjS4rxgLr4SJjdjES1tfqAZZzWRmsHX8SANvuF6kUZKNGuwkx;uid=0.0.11337994;registry=casheth;proto=mcp;nativeId=hedera:testnet:0.0.11337994` | [8](https://hashscan.io/testnet/transaction/0.0.11333252@1793966918.777870704) |
| CashETH Co-signer | 0.0.11337995 | `uaid:aid:8fqd1dSjvy8hm5eV4nQAWbaqRE378grATtuY8vjG4435g7FZGviKunwujd4AjGzuiQ;uid=0.0.11337995;registry=casheth;proto=mcp;nativeId=hedera:testnet:0.0.11337995` | [9](https://hashscan.io/testnet/transaction/0.0.11333252@1793966943.450939777) |
| CashETH KYA Issuer | 0.0.11337996 | `uaid:aid:8KLE1aYD6FURG1HxzCEmyJoVG7PKNQAanxWkKHaRxg5WKLfn6X9qXjsRbR3nUKwoux;uid=0.0.11337996;registry=casheth;proto=mcp;nativeId=hedera:testnet:0.0.11337996` | [10](https://hashscan.io/testnet/transaction/0.0.11333252@1793967072.948933279) |

## C5: spend wallets

Produced by `scripts/c5-spend-wallets.ts` on 2026-11-06; record in `deployments/testnet/spend-wallets.json`. Each worker agent spends from its own wallet whose key is `KeyList([worker, cosigner], 2)` set with `setKeyWithoutAlias` (so its EVM address is the long-zero form of the account id), funded with 5 HBAR by the operator, `maxAutomaticTokenAssociations` 10. USDC [0.0.429274](https://hashscan.io/testnet/token/0.0.429274) was associated by a `TokenAssociateTransaction` signed by both the worker and the policy co-signer.

| Wallet | Account | EVM (long-zero) | Keys (2 of 2) | Create tx | USDC association tx |
| --- | --- | --- | --- | --- | --- |
| SPEND_WALLET_RESEARCH | [0.0.11339484](https://hashscan.io/testnet/account/0.0.11339484) | `0x0000000000000000000000000000000000ad06dc` | WORKER_RESEARCH 0.0.11337989 + COSIGNER 0.0.11337995 | [0.0.11333252@1793969914.172231452](https://hashscan.io/testnet/transaction/0.0.11333252@1793969914.172231452) | [0.0.11333252@1793969919.209773850](https://hashscan.io/testnet/transaction/0.0.11333252@1793969919.209773850) |
| SPEND_WALLET_COMPUTE | [0.0.11339486](https://hashscan.io/testnet/account/0.0.11339486) | `0x0000000000000000000000000000000000ad06de` | WORKER_COMPUTE 0.0.11337990 + COSIGNER 0.0.11337995 | [0.0.11333252@1793969922.674066550](https://hashscan.io/testnet/transaction/0.0.11333252@1793969922.674066550) | [0.0.11333252@1793969930.470415616](https://hashscan.io/testnet/transaction/0.0.11333252@1793969930.470415616) |

The mirror node reports a threshold key as `ProtobufEncoded` (hex of the protobuf `Key`): `2a` = field 5 `thresholdKey`, `08 02` = threshold 2, `12` = its `KeyList`, each entry `0a 23 3a 21 <33-byte compressed secp256k1 key>` (field 7 `ECDSA_secp256k1`). `packages/hedera/src/spendWallet.test.ts` (live) asserts this decodes to threshold 2 over the worker's and co-signer's keys.

SPEND_WALLET_RESEARCH `GET /api/v1/accounts/0.0.11339484` → `key`:

```json
{"_type":"ProtobufEncoded","key":"2a4e0802124a0a233a2103992d6204ee754421f9643bf73bf1826fea6def1b2549656d9df96d3a205e29470a233a21031ca1230064d86ff1e48a4825d999f30dea7f006f29c20e4f62d4af7b3397e0a1"}
```

Decoded (protobuf `Key.thresholdKey`): threshold 2, keys worker ECDSA_SECP256K1 `03992d6204ee754421f9643bf73bf1826fea6def1b2549656d9df96d3a205e2947`, cosigner ECDSA_SECP256K1 `031ca1230064d86ff1e48a4825d999f30dea7f006f29c20e4f62d4af7b3397e0a1`.

SPEND_WALLET_COMPUTE `GET /api/v1/accounts/0.0.11339486` → `key`:

```json
{"_type":"ProtobufEncoded","key":"2a4e0802124a0a233a21027a33ace3cb59908b07d55fea1c023b22612c291faa049911f7fc604471cf71a20a233a21031ca1230064d86ff1e48a4825d999f30dea7f006f29c20e4f62d4af7b3397e0a1"}
```

Decoded (protobuf `Key.thresholdKey`): threshold 2, keys worker ECDSA_SECP256K1 `027a33ace3cb59908b07d55fea1c023b22612c291faa049911f7fc604471cf71a2`, cosigner ECDSA_SECP256K1 `031ca1230064d86ff1e48a4825d999f30dea7f006f29c20e4f62d4af7b3397e0a1`.

Facility allowance: not granted yet. The `CreditFacility` is not deployed at this checkpoint, so the standing USDC allowance from each wallet to the facility contract (`AccountAllowanceApproveTransaction.approveTokenAllowance(USDC, wallet, facilityContractId, units)`, signed by worker and co-signer, `units` < 2^63) is granted in C5 spend (Task 5.3) by `approveFacilityAllowance`.

## C3: facility and repayment router

> This section describes the first deployment (archived in `deployments/testnet/archive-2026-11-06-redeploy.json`); the live stack was redeployed, see [C4 redeploy](#c4-redeploy-hedera-one-schedule-per-transaction).

Deployed on 2026-11-06 by `contracts/script/02_DeployFacility.s.sol` through the Hashio relay from the operator, driven by `scripts/c3-deploy.ts`, against the C2 registries (not redeployed). Addresses are in `deployments/testnet/addresses.json` (`rcn`, `creditFacility`, `repaymentRouter`) and the full run record is in `deployments/testnet/c3.json`. `rcn.wire(...)` and `facility.wire(swapRouter, repaymentRouter)` need the SwapVM router, so Task 4.3 does them. Both still read zero on-chain.

### Contracts

| Contract | Address | Contract id | Deploy tx | Gas used |
| --- | --- | --- | --- | --- |
| ReceivableCreditNote (owner = operator) | `0x54a665d52E2e79bA3Ec46b20f8c2cfE950C9A0ce` | [0.0.11339718](https://hashscan.io/testnet/contract/0.0.11339718) | [0.0.7314364@1793971488.122320980](https://hashscan.io/testnet/transaction/0.0.7314364@1793971488.122320980) | 808,696 |
| CreditFacility (coordinator `0x45fDF15ed9c6327DEb0E57db6B78f592b254aB68`, owner = operator) | `0xfe702433E753ca4CA8dEDC3059987eCA7B8fe640` | [0.0.11339720](https://hashscan.io/testnet/contract/0.0.11339720) | [0.0.7314364@1793971495.452167794](https://hashscan.io/testnet/transaction/0.0.7314364@1793971495.452167794) | 4,226,858 |
| RepaymentRouter | `0xcf6DeBDfc01a9DcafDBf0Ad45f4ebc185dB705f7` | [0.0.11339725](https://hashscan.io/testnet/contract/0.0.11339725) | [0.0.7314364@1793971507.280224870](https://hashscan.io/testnet/transaction/0.0.7314364@1793971507.280224870) | 1,864,935 |

### Funding and wiring

| Step | Tx | Gas limit | Gas used |
| --- | --- | --- | --- |
| 20 HBAR into `CreditFacility.receive()`. The facility was created without value and the transfer carries an explicit gas limit, as in S4. | [0.0.7314364@1793971542.575088301](https://hashscan.io/testnet/transaction/0.0.7314364@1793971542.575088301) | 62,300 | 21,062 |
| `ReceivableRegistry.wire(facility, repaymentRouter)` | [0.0.7314364@1793971547.693584156](https://hashscan.io/testnet/transaction/0.0.7314364@1793971547.693584156) | 150,000 | 68,845 |
| `KYARegistry.wire(repaymentRouter, facility)` (the argument order is the reverse of the registry's) | [0.0.7314364@1793971571.194228108](https://hashscan.io/testnet/transaction/0.0.7314364@1793971571.194228108) | 150,000 | 68,743 |

The script read these values back from the chain after deploying:

- `registry.facility()` and `kya.facility()` both equal the facility address.
- `registry.repaymentRouter()` and `kya.repaymentRouter()` both equal the router address.
- `facility.REGISTRY/KYA/RCN/USDC/COORDINATOR/owner()` and `router.REGISTRY/KYA/FACILITY/RCN/USDC()` match the deployed addresses.
- `rcn.owner()` is the operator.
- The facility holds 20 HBAR.
- The mirror node shows the facility (0.0.11339720) and the router (0.0.11339725) both associated with USDC 0.0.429274. The constructors made these associations through the HIP-719 facade.

### Contract sizes (`forge build --sizes`, solc 0.8.30, via-IR, 600 runs; exits 0, every contract under 24,576 B)

| Contract | Runtime (B) | Initcode (B) | Runtime margin (B) |
| --- | --- | --- | --- |
| ReceivableCreditNote | 3,104 | 4,066 | 21,472 |
| CreditFacility | 15,877 | 16,689 | 8,699 |
| RepaymentRouter | 5,073 | 5,576 | 19,503 |
| KYARegistry | 2,962 | 3,228 | 21,614 |
| ReceivableRegistry | 6,379 | 7,700 | 18,197 |
| CashEthSwapVMRouter (Task 4.3) | 23,759 | 25,445 | 817 |
| CashEthOrderBuilder (Task 4.3) | 8,807 | 8,833 | 15,769 |

### Fuzz and invariant suite

`contracts/test/invariants/FacilityInvariants.t.sol` and `FacilityHandler.sol` drive the real registries, RCN, facility and repayment router. `MockSwapRouter` stands in for the SwapVM router, `MockHSS` sits at 0x16b and `MockUSDC` is the currency. The suite runs with `[invariant] runs = 128, depth = 32, fail_on_revert = false` and `[fuzz] runs = 512`. Full `forge test`: 167 passed, 0 failed.

```
[PASS] invariant_budgetsNeverExceedFunded() (runs: 128, calls: 4096, reverts: 0)
[PASS] invariant_committedPlusReservedPlusAvailableEqualsFunded() (runs: 128, calls: 4096, reverts: 0)
[PASS] invariant_debtNeverExceedsBorrowingBase() (runs: 128, calls: 4096, reverts: 0)
[PASS] invariant_sellerGetsNothingWhileLendersOwed() (runs: 128, calls: 4096, reverts: 0)
[PASS] invariant_stateOnlyMovesForward() (runs: 128, calls: 4096, reverts: 0)
[PASS] testFuzz_feeOf_monotonicInTime(uint64) (runs: 512)
[PASS] testFuzz_feeOf_noOverflow(uint256,uint16,uint64) (runs: 512)
[PASS] testFuzz_repay_neverPaysSellerWhileLendersOwed(uint256) (runs: 512)
```

To show the invariants catch real faults, each of the following deliberate source changes was made and then reverted. Every one made at least one invariant fail:

- The router pays the seller 1 unit on a partial repayment.
- `setBudgets` drops the `funded` cap.
- `markOverdue` drops its due check.
- `release` forgets to decrement `info.reserved`.
- `openAndFund` drops the borrowing-base check.
- `closeFacility` keeps the undrawn USDC.

## C4: modified SwapVM router, wiring, first registration

> This section describes the first deployment (archived in `deployments/testnet/archive-2026-11-06-redeploy.json`); the live stack was redeployed, see [C4 redeploy](#c4-redeploy-hedera-one-schedule-per-transaction). The Aqua registry, order builder and tUSDT below are still in use.

Deployed on 2026-11-06 by `contracts/script/03_DeployAqua.s.sol` through the Hashio relay from the operator (`0x8Ac63d78d72Faa40B4fB04945Ea37124ee93E97e`), driven by `scripts/c4-deploy-and-wire.ts`. The wiring, the tUSDT mints and the registration were sent from TypeScript (`scripts/c4-deploy-and-wire.ts`, `scripts/c4-register.ts`), and each transaction is recorded below. Addresses are in `deployments/testnet/addresses.json` (`aqua`, `swapRouter`, `orderBuilder`, `tUsdt`, `taker`, plus `deployedBlock` = 42741303, the Aqua creation block, where Aqua log discovery should start). The full run record is in `deployments/testnet/c4.json`. Spike S1's Aqua registry (`deployments/testnet/spike-aqua.json`) is untouched. This is CashETH's own registry.

### Contracts

| Contract | Address | Contract id | Block | Deploy tx | Gas used |
| --- | --- | --- | --- | --- | --- |
| AquaRouter (owner = operator) | `0xc65A0788a9AE598aEAB5DbC529B7649a1383d54c` | [0.0.11339989](https://hashscan.io/testnet/contract/0.0.11339989) | 42741303 | [0.0.7314364@1793973211.309180764](https://hashscan.io/testnet/transaction/0.0.7314364@1793973211.309180764) | 887,121 |
| CashEthSwapVMRouter (aqua, WHBAR `0xb1F6…37Ed`, owner = operator, "CashETH SwapVM", "1.0.0", registry, kya, facility) | `0xFcE311Ea7f4B4F8D5d897d48BFA2a21DcC34A562` | [0.0.11339992](https://hashscan.io/testnet/contract/0.0.11339992) | 42741315 | [0.0.7314364@1793973238.198619187](https://hashscan.io/testnet/transaction/0.0.7314364@1793973238.198619187) | 5,236,940 |
| CashEthOrderBuilder | `0x4125108453A1E9c333b100a917F630b84F3413Fb` | [0.0.11339998](https://hashscan.io/testnet/contract/0.0.11339998) | 42741322 | [0.0.7314364@1793973249.483160364](https://hashscan.io/testnet/transaction/0.0.7314364@1793973249.483160364) | 1,955,808 |
| TestStablecoin (tUSDT, 6 decimals, owner = operator) | `0x65C25Cc145f0836C8fFAb83Bf9676e98a8a2648a` | [0.0.11340006](https://hashscan.io/testnet/contract/0.0.11340006) | 42741343 | [0.0.7314364@1793973289.919591005](https://hashscan.io/testnet/transaction/0.0.7314364@1793973289.919591005) | 577,577 |
| CashEthTaker (router, USDC, owner = operator; associates USDC in its constructor) | `0x506646D702C00A19854eE1f28eF3F396E32a3838` | [0.0.11340016](https://hashscan.io/testnet/contract/0.0.11340016) | 42741358 | [0.0.7314364@1793973323.248921375](https://hashscan.io/testnet/transaction/0.0.7314364@1793973323.248921375) | 1,271,960 |

The ~25.4 KB router initcode was accepted by the relay as an ordinary EVM creation, so the `ContractCreateFlow` fallback (D-P10) was not needed. The script creates every contract from its standalone `out/` artifact (`vm.getCode` plus `create`) rather than with `new`. Under via-IR, the router compiled as a sub-object of the script came out 285 B longer than the standalone artifact, and forge 1.5.1 then failed to decode its constructor arguments (`type check failed for "offset (usize)"`). The deployed runtime code of all five contracts was read from the mirror node and compared with `out/` with immutables masked. All five match byte for byte, and the router's is 23,759 B.

`forge build --sizes` for the router (solc 0.8.30, via-IR, 600 runs):

```
| CashEthSwapVMRouter | 23,759 | 25,445 | 817 | 23,707 |
```

| Contract | Runtime (B) | Initcode (B) | Runtime margin (B) |
| --- | --- | --- | --- |
| CashEthSwapVMRouter | 23,759 | 25,445 | 817 |
| AquaRouter | 3,730 | 3,938 | 20,846 |
| CashEthOrderBuilder | 8,807 | 8,833 | 15,769 |
| TestStablecoin | 2,035 | 2,987 | 22,541 |
| CashEthTaker | 2,205 | 2,682 | 22,371 |

### Wiring (one-time, from the operator)

| Step | Tx | Gas limit | Gas used |
| --- | --- | --- | --- |
| `ReceivableCreditNote.wire(facility, repaymentRouter, swapRouter, aqua)` | [0.0.7314364@1793973375.185154979](https://hashscan.io/testnet/transaction/0.0.7314364@1793973375.185154979) | 157,534 | 113,912 |
| `CreditFacility.wire(swapRouter, repaymentRouter)` | [0.0.7314364@1793973384.629786380](https://hashscan.io/testnet/transaction/0.0.7314364@1793973384.629786380) | 94,790 | 69,271 |

`registry.wire` and `kya.wire` were done in C3. The script then read these values back from the chain:

- `rcn.facility()` = `0xfe702433E753ca4CA8dEDC3059987eCA7B8fe640`, `rcn.repaymentRouter()` = `0xcf6DeBDfc01a9DcafDBf0Ad45f4ebc185dB705f7`, `rcn.swapRouter()` = `0xFcE311Ea7f4B4F8D5d897d48BFA2a21DcC34A562`, `rcn.aqua()` = `0xc65A0788a9AE598aEAB5DbC529B7649a1383d54c`.
- `facility.swapRouter()` = the router and `facility.repaymentRouter()` = the repayment router.
- `swapRouter.AQUA/REGISTRY/KYA/FACILITY()` match the deployed aqua, registry, KYA and facility. `swapRouter.owner()` and `aqua.owner()` are the operator. `swapRouter.eip712Domain()` = ("CashETH SwapVM", "1.0.0", 296).
- `tUsdt.symbol()` = tUSDT, `decimals()` = 6 and `owner()` = the operator.
- `taker.owner()` is the operator, `taker.ROUTER()` is the router and `taker.USDC()` is the USDC facade. The mirror node lists 0.0.11340016 as associated with USDC 0.0.429274.

### tUSDT mints (Addendum A)

| Recipient | Units (6 dec.) | Tx |
| --- | --- | --- |
| lenderA `0xc502…a096` | 50,000,000 | [0.0.7314364@1793973410.629230189](https://hashscan.io/testnet/transaction/0.0.7314364@1793973410.629230189) |
| lenderB `0x502e…d238` | 50,000,000 | [0.0.7314364@1793973436.669979525](https://hashscan.io/testnet/transaction/0.0.7314364@1793973436.669979525) |
| lenderC `0xeaAB…2377` | 50,000,000 | [0.0.7314364@1793973647.416551032](https://hashscan.io/testnet/transaction/0.0.7314364@1793973647.416551032) |
| lenderD `0x9a81…5690` | 50,000,000 | [0.0.7314364@1793973830.022297535](https://hashscan.io/testnet/transaction/0.0.7314364@1793973830.022297535) |
| operator / trader `0x8Ac6…E97e` | 20,000,000 | [0.0.7314364@1793973710.046026486](https://hashscan.io/testnet/transaction/0.0.7314364@1793973710.046026486) |

### Lender D

| Step | Tx |
| --- | --- |
| create 0.0.11340117 (ECDSA, EVM alias `0x9a81f51AACA1BF584D21f44c40Be9DdB12ef5690`, 20 HBAR) | [0.0.11333252@1793973749.307616004](https://hashscan.io/testnet/transaction/0.0.11333252@1793973749.307616004) |
| associate USDC 0.0.429274 | [0.0.11333252@1793973758.885360940](https://hashscan.io/testnet/transaction/0.0.11333252@1793973758.885360940) |
| 1 USDC from the operator | [0.0.11333252@1793973758.144836264](https://hashscan.io/testnet/transaction/0.0.11333252@1793973758.144836264) |
| `KYARegistry.register(lenderD)` by the KYA issuer: role 4 (Lender), level 2, ownerGroup `keccak256("lender-d")`, uaidHash `keccak256(address)` placeholder, mandateHash `keccak256("mandate-v1-lenderD")` | [0.0.7314364@1793973776.590586610](https://hashscan.io/testnet/transaction/0.0.7314364@1793973776.590586610) |

The mirror node shows 20 HBAR and 1,000,000 USDC units on 0.0.11340117. `LENDER_D_ID/_KEY/_EVM` are in `.env.accounts`, and `LENDER_D` was added to `DEMO_ACCOUNTS`.

### First registration: PO-1002, payee = RepaymentRouter

The buyer signed the `ReceivableConfirmation` below. The coordinator (0.0.11337994) submitted it.

- Amounts and dates: amount 10000000 (10 USDC), dueDate 1796565842 (now + 30 days), deadline 1794060242 (now + 1 day).
- `buyerRef = keccak256("PO-1002")` = `0x9928d28ec7aa4286690d97ba1a7149d2ac12ab0fd6b185d8a2460f44e8aaf4f6`; `detailsCommitment = keccak256("demo-invoice-1002")`.
- `payTo = 0xcf6DeBDfc01a9DcafDBf0Ad45f4ebc185dB705f7` (the RepaymentRouter); nonce 0 (= `nonces(buyer)`).

The TypeScript digest `0x902bb9cb638c78456026e30a9578c1b24e1aa28069a3b1783d077faba82d4c02` equals the registry's `hashConfirmation`.

**Receivable id `0xb1a0a92a58af18bbeb4bad3485f23aeb7f6987d15c271513a5d5b6072bee844c`** (= `computeId(buyer, buyerRef)`).

| Step | Tx | Mirror result | Gas used |
| --- | --- | --- | --- |
| `ReceivableRegistry.register(PO-1002)` | [0.0.7314364@1793973922.254969725](https://hashscan.io/testnet/transaction/0.0.7314364@1793973922.254969725) | SUCCESS | 233,024 |

The script read the receivable back with `state(id)` and `get(id)`. It reads 1 (Confirmed) with seller, buyer, currency, amount, dueDate and detailsCommitment equal to the confirmation, `registeredAt` 1793973926, and `nonces(buyer)` is now 1.

### HCS audit events and receivable NFT

| Item | Value | Tx |
| --- | --- | --- |
| `ReceivableConfirmed` on topic [0.0.11338927](https://hashscan.io/testnet/topic/0.0.11338927) | seq **30** (prevSeq 28) | [0.0.11333252@1793973943.240502909](https://hashscan.io/testnet/transaction/0.0.11333252@1793973943.240502909) |
| NFT [0.0.11338934](https://hashscan.io/testnet/token/0.0.11338934) mint | serial **1**, metadata `{"id":"0xb1a0a92a58af18bbeb4bad3485f23aeb7f6987d15c271513a5d5b6072bee844c","seq":30}` | [0.0.11333252@1793973947.419241023](https://hashscan.io/testnet/transaction/0.0.11333252@1793973947.419241023) |
| `NftMinted` | seq **31** (prevSeq 30) | [0.0.11333252@1793973947.577011440](https://hashscan.io/testnet/transaction/0.0.11333252@1793973947.577011440) |

The mirror node read-back confirms all three:

- `/topics/0.0.11338927/messages/30` and `/31` decode to these events with this id.
- `/tokens/0.0.11338934/nfts/1` carries exactly this metadata and is held by the treasury (the operator 0.0.11333252).
- The NFT's `seq` is the `ReceivableConfirmed` sequence number.

Seq 29 is a `test: true` `AgentRegistered` message published concurrently by the `@casheth/hedera` live tests. It landed between our mirror read of the latest sequence (28) and our submit, which is why `ReceivableConfirmed` carries prevSeq 28.

### DUPLICATE_RECEIVABLE proven on-chain

The same obligation (same buyer and `buyerRef`, so the same id) was signed again with the next nonce (1) and a fresh deadline (1794060354). All other fields were unchanged.

- **Dry run** (`simulateContract`): the duplicate reverts `DUPLICATE_RECEIVABLE()`.
- **Control dry run:** the identical confirmation with `buyerRef = keccak256("PO-1002-control")` passes every check (returns id `0x8ae1754f…4995f`). Only the duplication blocks it. This control was a dry run only and nothing was registered.
- **Real transaction:** the coordinator submitted the duplicate with an explicit gas limit of 300,000:

| Submission | Tx | Mirror result | error_message | Decoded |
| --- | --- | --- | --- | --- |
| PO-1002 again, nonce 1 | [0.0.7314364@1793973975.081244937](https://hashscan.io/testnet/transaction/0.0.7314364@1793973975.081244937) | CONTRACT_REVERT_EXECUTED | `0x55e1137b` | `DUPLICATE_RECEIVABLE()` |

`0x55e1137b` = `bytes4(keccak256("DUPLICATE_RECEIVABLE()"))`. It is read from mirror `GET /contracts/results/{hash}` → `error_message` and decoded with the synced `ReceivableRegistry` ABI.

### Tests

`forge test`: 182 passed, 0 failed. That is the earlier 167 plus 11 for `CashEthTaker`: both directions, exact-in and exact-out (approves the router's own quote), threshold, owner-only, sweep, constructor association including `TOKEN_ALREADY_ASSOCIATED`. Another 4 cover `TestStablecoin`.


## C4 strategies

> These strategies were shipped on the first deployment and later docked (archived in `deployments/testnet/archive-2026-11-06-redeploy.json`); the final strategies are in [C4 strategies (final)](#c4-strategies-final).

Shipped on 2026-11-06 by `scripts/c4-ship-strategies.ts` to Aqua `0xc65A0788a9AE598aEAB5DbC529B7649a1383d54c` with the modified SwapVM router as the app. Each lender ships from one wallet, sending the exact-amount USDC (and tUSDT) approvals to Aqua first. The record, with every `Shipped` transaction and strategy hash, is `deployments/testnet/strategies.json`.

Credit strategies use the tier presets (`low` 700 bps, `medium` 850 bps, `high` 1300 bps) with `maxPerBuyer` 5 USDC and `minReserve` 0. A and B accept the seller only, C accepts any seller, and D accepts only workerResearch. Base-yield strategies are USDC/tUSDT constant product with a 30 bps input fee. Lender D has no base-yield strategy, so there are seven strategies, not eight.

| Lender | Kind | Shipped | Salt | Strategy hash | `Aqua.ship` tx |
| --- | --- | --- | --- | --- | --- |
| A (0xc502…a096) | credit | 4 USDC | salt 1 | `0xbb373565cb358982293c8b00cd2318df8271d4d31d8baccee731878ae7159a99` | [0.0.7314364@1793974693.355943119](https://hashscan.io/testnet/transaction/0.0.7314364@1793974693.355943119) |
| A (0xc502…a096) | base | 2 USDC + 2 tUSDT | salt 2 | `0xb066774b1f5a237212a16f37982ea219648ec1e0ff11accd73846bbc286da405` | [0.0.7314364@1793974806.917877057](https://hashscan.io/testnet/transaction/0.0.7314364@1793974806.917877057) |
| B (0x502e…d238) | credit | 2 USDC | salt 1 | `0xf08a82b952e3fc04a5ee80e44e5bbcd090ebff7ef89de5f86f850576a701daf6` | [0.0.7314364@1793974867.456516923](https://hashscan.io/testnet/transaction/0.0.7314364@1793974867.456516923) |
| B (0x502e…d238) | base | 1 USDC + 1 tUSDT | salt 2 | `0xb34f81f5e96886d8d19946ccb47d88a9dd91f13a3c0fd4aa3b76603eaae68f71` | [0.0.7314364@1793975076.335157523](https://hashscan.io/testnet/transaction/0.0.7314364@1793975076.335157523) |
| C (0xeaAB…2377) | credit | 3 USDC | salt 1 | `0x9356d49a1d6eed1a55f0c9556f1f3cbd7825d0659882b5ab29ed52c14fa82ccc` | [0.0.7314364@1793975148.650273990](https://hashscan.io/testnet/transaction/0.0.7314364@1793975148.650273990) |
| C (0xeaAB…2377) | base | 1 USDC + 1 tUSDT | salt 2 | `0x3682b06ac84ac0e8dd9126a00ac396960e204f2f329553d1b778f70da9e691a0` | [0.0.7314364@1793975212.586686405](https://hashscan.io/testnet/transaction/0.0.7314364@1793975212.586686405) |
| D (0x9a81…5690) | credit | 1 USDC | salt 1 | `0x1781496aa4464ee7b8700c322a1d97c5407e36f74862376580dcbc032e616a6d` | [0.0.7314364@1793975262.753059238](https://hashscan.io/testnet/transaction/0.0.7314364@1793975262.753059238) |

Checked by discovery from the Aqua deployment block (`listOpenStrategies`, also `LIVE=1 pnpm -F @casheth/aqua exec vitest run --project unit discover.live`):

- The order is credit A (700 bps), D (700 bps), B (850 bps), C (1300 bps), then base A, B, C. A and D tie and keep shipping order.
- Virtual balances equal the shipped amounts.
- The USDC allowance to Aqua is exactly credit + base for each lender (A 6, B 3, C 4, D 1 USDC) and the tUSDT allowance is exactly the base amount. Nothing was approved at max.
- A re-run of the script only reads: every hash is already open.

## C4 redeploy (Hedera one-schedule-per-transaction)

Why. The first funding attempt, [0.0.7314364@1793976431.091663990](https://hashscan.io/testnet/transaction/0.0.7314364@1793976431.091663990), failed with the network status `NO_SCHEDULING_ALLOWED_AFTER_SCHEDULED_RECURSION` (mirror `error_message` is the ASCII of that status, so it is a HAPI status and not a Solidity revert; `try/catch` cannot absorb it). `CreditFacility.openAndFund` called the Schedule Service's `scheduleCall` twice (`markOverdue` and `markDefaulted`) and Hedera's recursion protection (HIP-1215) allows one scheduling call per transaction. A throwaway probe contract confirmed it: one `scheduleCall` per transaction worked for delays up to 60 days, two failed. The anvil tests had missed it because `MockHSS` does not model the limit.

Contract change (commit `b2a4ab1`). `openAndFund` now schedules only `markOverdue`, always with the nested-schedule gas limit (1,800,000), and `defaultSchedule` stays 0 at funding. `markOverdue`, which runs as its own scheduled transaction, schedules `markDefaulted` (best effort, `ScheduleSkipped` on refusal, as before). The `Scheduled` event is emitted with `defaultSchedule = 0` at funding and again by `markOverdue`. A new test asserts exactly one `scheduleCall` at funding. `forge test`: 181 passed. The solver's special case for the relay's scheduling refusal was removed, because the dry run of `openAndFund` now succeeds on Hedera.

Redeploy. The facility address is immutable in `CashEthSwapVMRouter`, `RepaymentRouter` and `CashEthTaker`, and every `wire()` is one-shot, so the core stack was redeployed by `scripts/c4-redeploy-prepare.ts` followed by the existing C2, C3, C4 scripts (flags and reuse variables, no copies). Kept: AquaRouter, CashEthOrderBuilder (no address immutables), tUSDT, the HCS topics, the NFT collection, the spend wallets and all accounts. Before redeploying, every lender docked its 7 strategies and set its Aqua allowances to zero (7 docks and 7 `approve(Aqua, 0)` transactions, linked in the archive file), so the new approvals are exact. The coordinator was topped up by 13 HBAR ([tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793977712.251368007)).

| Contract | Address | Contract id | Deploy tx | Archived first deployment |
| --- | --- | --- | --- | --- |
| KYARegistry | `0x81d1935e41705DCD4c4499285c74c955626673dD` | [0.0.11341323](https://hashscan.io/testnet/contract/0.0.11341323) | [0.0.7314364@1793978954.588950176](https://hashscan.io/testnet/transaction/0.0.7314364@1793978954.588950176) | `0xE51950be227c5A31B603e1343cD53e813C593f39` |
| ReceivableRegistry | `0x0D118059D67cbe738aD86C4B8c25cdf06837791f` | [0.0.11341326](https://hashscan.io/testnet/contract/0.0.11341326) | [0.0.7314364@1793978957.638929669](https://hashscan.io/testnet/transaction/0.0.7314364@1793978957.638929669) | `0x112167Ad230f4b733B756201FDe8b4ec3BC97A8b` |
| ReceivableCreditNote | `0x733bE9213C79Be5dC3E3dD68FB126182D2F74f15` | [0.0.11341528](https://hashscan.io/testnet/contract/0.0.11341528) | [0.0.7314364@1793979983.761485389](https://hashscan.io/testnet/transaction/0.0.7314364@1793979983.761485389) | `0x54a665d52E2e79bA3Ec46b20f8c2cfE950C9A0ce` |
| CreditFacility | `0x38ACd9F1FEED870b2507b1421bE887d9a751d9e0` | [0.0.11341529](https://hashscan.io/testnet/contract/0.0.11341529) | [0.0.7314364@1793979989.446409772](https://hashscan.io/testnet/transaction/0.0.7314364@1793979989.446409772) | `0xfe702433E753ca4CA8dEDC3059987eCA7B8fe640` |
| RepaymentRouter | `0x63B6f03a60026626B6052D800864dD74604f6a8a` | [0.0.11341530](https://hashscan.io/testnet/contract/0.0.11341530) | [0.0.7314364@1793979992.300892540](https://hashscan.io/testnet/transaction/0.0.7314364@1793979992.300892540) | `0xcf6DeBDfc01a9DcafDBf0Ad45f4ebc185dB705f7` |
| CashEthSwapVMRouter | `0x458b3b7CaDec64Cd0AE0B244d582006C4E99ce1b` | [0.0.11341628](https://hashscan.io/testnet/contract/0.0.11341628) | [0.0.7314364@1793980328.280390902](https://hashscan.io/testnet/transaction/0.0.7314364@1793980328.280390902) | `0xFcE311Ea7f4B4F8D5d897d48BFA2a21DcC34A562` |
| CashEthTaker | `0x8FC7B1BBa8EEdf5a4C9Ac9FEA746ABAd17804B5B` | [0.0.11341636](https://hashscan.io/testnet/contract/0.0.11341636) | [0.0.7314364@1793980360.664551738](https://hashscan.io/testnet/transaction/0.0.7314364@1793980360.664551738) | `0x506646D702C00A19854eE1f28eF3F396E32a3838` |
| AquaRouter, CashEthOrderBuilder, tUSDT | unchanged: `0xc65A0788a9AE598aEAB5DbC529B7649a1383d54c`, `0x4125108453A1E9c333b100a917F630b84F3413Fb`, `0x65C25Cc145f0836C8fFAb83Bf9676e98a8a2648a` | | | kept |

Wiring and setup on the new stack: facility funded with 20 HBAR via `receive()` ([tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793979998.723889452)), `ReceivableRegistry.wire` ([tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793980017.168341300)), `KYARegistry.wire` ([tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793980024.675648188)), `ReceivableCreditNote.wire` ([tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793980425.858553275)), `CreditFacility.wire` ([tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793980444.372359298)). The 7 KYA registrations on the new registry (seller, buyer, both workers, lenders A to C) and lender D's ([tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793980554.341621558)) are in `deployments/testnet/c2.json` and `c4.json`. The C2 confirmation rejections were not repeated (the checks did not change).

PO-1002 was registered again on the new registry with amount 6 USDC (the lenders' real balances cap the demo), due in 30 days, payee = the new RepaymentRouter, `buyerRef = keccak256("PO-1002")`: [register tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793980592.500689981), receivable id `0xb1a0a92a58af18bbeb4bad3485f23aeb7f6987d15c271513a5d5b6072bee844c`. HCS `ReceivableConfirmed` seq 34 ([tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793980598.332603471)), NFT 0.0.11338934 serial 2 ([tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793980599.981683574)), `NftMinted` seq 35 ([tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793980602.620678492)). `DUPLICATE_RECEIVABLE` was proved again on the new registry ([tx](https://hashscan.io/testnet/transaction/0.0.7314364@1793980736.789329045)).

## C4 strategies (final)

Shipped on 2026-11-06 by `scripts/c4-ship-strategies.ts` to the kept Aqua registry with the new router `0x458b3b7CaDec64Cd0AE0B244d582006C4E99ce1b` as the app, each lender from one wallet with exact-amount approvals. Sizes follow the lenders' real USDC balances (credit plus base never exceeds a wallet), so base-yield swaps can draw on them. `deployments/testnet/strategies.json` holds the full `order` of every strategy. Tiers and presets are as in the first deployment (`low` 700, `medium` 850, `high` 1300 bps, `maxPerBuyer` 5 USDC, base fee 30 bps). Seven strategies; lender D has no base strategy.

| Lender | Kind | Shipped | Salt | Strategy hash | `Aqua.ship` tx |
| --- | --- | --- | --- | --- | --- |
| A | credit | 3.5 USDC | salt 1 | `0x452b654505cfe6c9cc5ed2da3b0deec5737f015db26763e910f7f1c76abd4548` | [0.0.7314364@1793980834.590739155](https://hashscan.io/testnet/transaction/0.0.7314364@1793980834.590739155) |
| A | base | 0.5 USDC + 0.5 tUSDT | salt 2 | `0xb066774b1f5a237212a16f37982ea219648ec1e0ff11accd73846bbc286da405` | [0.0.7314364@1793980911.340291226](https://hashscan.io/testnet/transaction/0.0.7314364@1793980911.340291226) |
| B | credit | 1.5 USDC | salt 1 | `0xfeb38cfc6739caab0996288006d944eaf6ee801c3247ef3bf36944e1acc62490` | [0.0.7314364@1793981034.732736160](https://hashscan.io/testnet/transaction/0.0.7314364@1793981034.732736160) |
| B | base | 0.5 USDC + 0.5 tUSDT | salt 2 | `0xb34f81f5e96886d8d19946ccb47d88a9dd91f13a3c0fd4aa3b76603eaae68f71` | [0.0.7314364@1793981428.956894431](https://hashscan.io/testnet/transaction/0.0.7314364@1793981428.956894431) |
| C | credit | 0.5 USDC | salt 1 | `0x17711016ce827c6df6c0f84934c2bd69682932104b22b5781545b32e2a9166c5` | [0.0.7314364@1793981544.024005875](https://hashscan.io/testnet/transaction/0.0.7314364@1793981544.024005875) |
| C | base | 0.5 USDC + 0.5 tUSDT | salt 2 | `0x3682b06ac84ac0e8dd9126a00ac396960e204f2f329553d1b778f70da9e691a0` | [0.0.7314364@1793981618.317305300](https://hashscan.io/testnet/transaction/0.0.7314364@1793981618.317305300) |
| D | credit | 1 USDC | salt 1 | `0xcf1e8f290a4e6470572718fe82decffe81753d95a5f6d4e64ad7013477b0735a` | [0.0.7314364@1793982142.770577875](https://hashscan.io/testnet/transaction/0.0.7314364@1793982142.770577875) |

Checked by discovery from the Aqua deployment block: order credit A (700 bps), D (700), B (850), C (1300), then base A, B, C; virtual balances equal the shipped amounts; USDC allowance to Aqua is exactly credit plus base per lender (A 4, B 2, C 1, D 1 USDC) and tUSDT exactly the base amount. Nothing was approved at max. Three shipping runs were needed because Hashio answered `Failed to save transaction to pool` twice; the script is idempotent (open hashes are skipped) and was run without auto-retry so an approve could not be applied twice.

## C4 funding

PO-1002 (6 USDC, advance 75% = borrowing base 4.5 USDC) was funded cheapest-first by lenders A and B through the modified SwapVM router, by `scripts/c4-open-facility.ts`. Engine score 600, advance 7500 bps, limit 4,500,000 units. The solver's dry runs are ordinary `eth_call`s of `openAndFund` from the coordinator:

```
fill  lender A: 3500000 units at 700 bps
fill  lender B: 1000000 units at 850 bps
skip  lender D credit: SELLER_NOT_FUNDED_BY_LENDER
skip  lender C credit: NOT_NEEDED
```

`CreditFacility.openAndFund` ([0.0.7314364@1793982496.157443985](https://hashscan.io/testnet/transaction/0.0.7314364@1793982496.157443985), gas used 2,088,677, relay-estimated, from the coordinator) is the 1inch headline transaction: the router fills A's and B's Aqua strategies, the facility receives 4.5 USDC and the lenders receive RCN.

Verified on-chain and on the mirror node:

- Facility USDC balance 4,500,000 units (`eth_call` and mirror node agree).
- Registry state `Financed` (2). `FacilityFunded` (funded 4,500,000, advanceBps 7500, makers A and B) and two `PositionOpened` events.
- Lender A holds 3,500,000 RCN units and lender B 1,000,000.
- Exactly one schedule entity was created by the funding transaction (one `SCHEDULECREATE` child record): `markOverdue`, schedule 0.0.11342318, pending, no `ScheduleSkipped`, `defaultSchedule` 0 (`markOverdue` schedules the default check when it runs).

Two real transactions that revert, decoded from the mirror node's `error_message`:

| Call | Revert | Tx |
| --- | --- | --- |
| `openAndFund` for an unregistered id, from the coordinator | `NOT_CONFIRMED()` `0x6dc2c622` | [0.0.7314364@1793982511.134508238](https://hashscan.io/testnet/transaction/0.0.7314364@1793982511.134508238) |
| `openAndFund` for PO-1002, from the seller | `NOT_COORDINATOR()` `0xe5ad01f4` | [0.0.7314364@1793982519.722396023](https://hashscan.io/testnet/transaction/0.0.7314364@1793982519.722396023) |

HCS `FacilityFunded` on the audit topic [0.0.11338927](https://hashscan.io/testnet/topic/0.0.11338927): seq 36, [tx](https://hashscan.io/testnet/transaction/0.0.11333252@1793982667.668877640). The record is `deployments/testnet/facility.json`.

## C4 base yield (scripted volume)

Measured 2026-11-06 from `GET /lenders`. Base APR is variable swap-fee income from the volume the scripted trader agent (`agents/src/trader.ts`) pushed through the lenders' base-yield strategies on Hedera testnet; it is not guaranteed. Boost APR is the fixed `aprBps` of the lender's credit strategy.

| Lender | Tier | Capital (USDC) | Lent | Idle | Base fees | Credit fees | Base APR | Boost APR | Blended APR |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lenderA | low | 4.01081 | 3.5 | 0.51081 | 0.002054 | 0 | 2820.05% | 7% | 365.27% |
| lenderB | medium | 2 | 1 | 1 | 0 | 0 | 0% | 8.5% | 4.25% |
| lenderC | high | 1 | 0 | 1 | 0 | 0 | 0% | 13% | 0% |
| lenderD | low | 1 | 0 | 1 | 0 | 0 | 0% | 7% | 0% |

Scripted swaps (4, `deployments/testnet/trades.json`):

| Lender | Direction | In | Out | Transaction |
| --- | --- | ---: | ---: | --- |
| A | USDC -> tUSDT | 0.2 | 0.14255 | [0xc4c8d83194af6e353bde45c2ed3a4190305f432e38d88ac0fcc88eea48de8054](https://hashscan.io/testnet/transaction/0xc4c8d83194af6e353bde45c2ed3a4190305f432e38d88ac0fcc88eea48de8054) |
| A | tUSDT -> USDC | 0.14255 | 0.199141 | [0x43bdd259db898355c076f5803f81e9d28d7e545008ae91328d0874d654a2a3b6](https://hashscan.io/testnet/transaction/0x43bdd259db898355c076f5803f81e9d28d7e545008ae91328d0874d654a2a3b6) |
| A | USDC -> tUSDT | 0.2 | 0.142375 | [0xc00a3dfb38387e2584a59b399021df49631848b382acd5fbc68e25cee6f76a23](https://hashscan.io/testnet/transaction/0xc00a3dfb38387e2584a59b399021df49631848b382acd5fbc68e25cee6f76a23) |
| A | tUSDT -> USDC | 0.142375 | 0.19914 | [0x8f9dd4f67686192eab125dc8182008704165fc7908e4465affb32b3e4d37d413](https://hashscan.io/testnet/transaction/0x8f9dd4f67686192eab125dc8182008704165fc7908e4465affb32b3e4d37d413) |

Notes on this run:

- **Only lender A was traded** (two round trips of 0.2 USDC; the third was not started). Lenders B and C were not traded because of time: the Hashio relay took 1 to 5 minutes per transaction, and the run was stopped at the controller's request. Their base APR is therefore 0, not a result.
- **Base fees match the chain.** The four swaps pushed 0.684925 USDC-equivalent of input into A's base strategy; at 30 bps that is 0.002054, which is what `GET /lenders` reports (ship deposits are excluded since the `fix(mcp)` commit).
- **The base APR is an annualised measurement of a short window**, about 38 minutes from the first swap to the report, over A's 1.0 (0.5 USDC + 0.5 tUSDT) virtual balance. It shows the mechanism works on real swaps; it is not a forecast and not guaranteed. Price impact is large because the pool is small: 0.2 USDC in returns 0.14255 tUSDT, and a round trip comes back as 0.199141 USDC.
- **Swap 4 was confirmed on chain** (`Filled` amounts read from the mirror node) after the trader's receipt wait timed out; `trades.json` records it. The taker was then swept back to the operator.
- **Router USDC auto-association (4.3 watch item): works.** The router (`0.0.11341628`) has no explicit association and `max_automatic_token_associations = -1`. The first USDC-in fill associated it automatically (mirror: `0.0.429274`, `automatic_association: true`). The fill is expensive though: about 2.26M gas for every USDC-in fill (vs 145k for tUSDT-in). The first attempt with a 1.5M gas limit reverted with `ForceApproveFailed` (out of gas inside the router's HTS `approve`), so the trader uses a 4M limit.
