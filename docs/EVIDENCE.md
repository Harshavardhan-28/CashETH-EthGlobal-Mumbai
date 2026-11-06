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
