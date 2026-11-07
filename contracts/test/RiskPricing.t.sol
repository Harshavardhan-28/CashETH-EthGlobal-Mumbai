// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { RiskPricing } from "../src/core/libs/RiskPricing.sol";

/// @dev The same table is asserted by `packages/engine/src/pricing.test.ts`, so both sides price identically.
contract RiskPricingTest is Test {
    uint256 internal constant SHORT = 30 days;
    uint256 internal constant LONG = 61 days;

    function test_score_followsTheSellerRecordAndTenor() public pure {
        assertEq(RiskPricing.score(0, 0, 0, SHORT), 600);
        assertEq(RiskPricing.score(10, 0, 0, SHORT), 750);
        assertEq(RiskPricing.score(14, 0, 0, SHORT), 750, "on-time repayments count up to 10");
        assertEq(RiskPricing.score(3, 1, 0, SHORT), 605);
        assertEq(RiskPricing.score(0, 0, 1, SHORT), 400);
        assertEq(RiskPricing.score(0, 0, 0, LONG), 550, "a tenor over 60 days costs 50");
        assertEq(RiskPricing.score(0, 0, 0, 60 days), 600, "exactly 60 days is not long");
        assertEq(RiskPricing.score(0, 0, 4, SHORT), -200, "the score can go below zero");
    }

    function test_slabOf_boundaries() public pure {
        assertEq(uint8(RiskPricing.slabOf(750)), uint8(RiskPricing.Slab.Low));
        assertEq(uint8(RiskPricing.slabOf(700)), uint8(RiskPricing.Slab.Low));
        assertEq(uint8(RiskPricing.slabOf(699)), uint8(RiskPricing.Slab.Medium));
        assertEq(uint8(RiskPricing.slabOf(600)), uint8(RiskPricing.Slab.Medium));
        assertEq(uint8(RiskPricing.slabOf(599)), uint8(RiskPricing.Slab.High));
        assertEq(uint8(RiskPricing.slabOf(500)), uint8(RiskPricing.Slab.High));
        assertEq(uint8(RiskPricing.slabOf(499)), uint8(RiskPricing.Slab.None));
        assertEq(uint8(RiskPricing.slabOf(-200)), uint8(RiskPricing.Slab.None));
    }

    function test_aprBps_isLinearInsideEachSlabAndContinuousAcrossThem() public pure {
        assertEq(RiskPricing.aprBps(800), 600, "above the best score clamps to 6%");
        assertEq(RiskPricing.aprBps(750), 600);
        assertEq(RiskPricing.aprBps(725), 700);
        assertEq(RiskPricing.aprBps(701), 796);
        assertEq(RiskPricing.aprBps(700), 800);
        assertEq(RiskPricing.aprBps(650), 950);
        assertEq(RiskPricing.aprBps(601), 1097);
        assertEq(RiskPricing.aprBps(600), 1100);
        assertEq(RiskPricing.aprBps(520), 1340);
        assertEq(RiskPricing.aprBps(500), 1400);
    }

    function test_aprBps_revertsBelowTheFinanceableScore() public {
        vm.expectRevert(abi.encodeWithSelector(RiskPricing.NotFinanceable.selector, int256(499)));
        this.aprOf(499);
    }

    function testFuzz_aprBps_neverRisesAsTheScoreImproves(int256 a, int256 b) public pure {
        a = bound(a, 500, 900);
        b = bound(b, a, 900);
        assertLe(RiskPricing.aprBps(b), RiskPricing.aprBps(a));
    }

    function aprOf(int256 score) external pure returns (uint16) {
        return RiskPricing.aprBps(score);
    }
}
