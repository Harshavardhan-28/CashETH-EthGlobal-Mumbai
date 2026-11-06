// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { AlarmProbe } from "../src/spikes/AlarmProbe.sol";
import { MockHSS } from "./mocks/MockHSS.sol";

/// @notice Spike S4 locally: the probe schedules `ring(nonce)` on itself through the Hedera Schedule
///         Service (mocked at 0x16b); firing the schedule calls the probe as itself.
contract AlarmProbeTest is Test {
    address internal constant HSS = address(0x16b);
    uint256 internal constant DELAY = 90;
    uint256 internal constant GAS_LIMIT = 200_000;

    MockHSS internal hss;
    AlarmProbe internal probe;
    address internal owner = makeAddr("owner");

    event Scheduled(address schedule, uint256 nonce, uint256 at);
    event Rang(uint256 nonce, uint256 at);

    function setUp() public {
        vm.etch(HSS, address(new MockHSS()).code);
        hss = MockHSS(HSS);
        vm.deal(owner, 10 ether);
        vm.prank(owner);
        probe = new AlarmProbe{ value: 5 ether }();
        vm.warp(1_800_000_000);
    }

    function _schedule(uint256 delay) internal returns (address s) {
        vm.prank(owner);
        s = probe.schedule(delay);
    }

    function test_ConstructorKeepsHbarAndReceiveAcceptsMore() public {
        assertEq(address(probe).balance, 5 ether);
        assertEq(probe.OWNER(), owner);
        vm.prank(owner);
        (bool ok,) = address(probe).call{ value: 1 ether }("");
        assertTrue(ok);
        assertEq(address(probe).balance, 6 ether);
    }

    function test_ScheduleRecordsSelfCallEmitsAndIncrementsNonce() public {
        uint256 expiry = block.timestamp + DELAY;
        vm.expectEmit(address(probe));
        emit Scheduled(address(1), 0, expiry);
        address s = _schedule(DELAY);

        assertEq(s, address(1));
        assertEq(probe.nonce(), 1);
        assertEq(probe.rings(), 0);
        MockHSS.Scheduled memory rec = hss.getSchedule(s);
        assertEq(rec.scheduler, address(probe));
        assertEq(rec.to, address(probe));
        assertEq(rec.expirySecond, expiry);
        assertEq(rec.gasLimit, GAS_LIMIT);
        assertEq(rec.value, 0);
        assertEq(rec.callData, abi.encodeCall(AlarmProbe.ring, (0)));

        // The next schedule carries the next nonce.
        address s2 = _schedule(DELAY);
        assertEq(s2, address(2));
        assertEq(probe.nonce(), 2);
        assertEq(hss.getSchedule(s2).callData, abi.encodeCall(AlarmProbe.ring, (1)));
    }

    function test_FiringScheduleRingsAsTheProbe() public {
        address s = _schedule(DELAY);
        vm.warp(block.timestamp + DELAY);

        vm.expectEmit(address(probe));
        emit Rang(0, block.timestamp);
        hss.fire(s);

        assertEq(probe.rings(), 1);
        assertTrue(hss.getSchedule(s).executed);
    }

    function test_RingFromStrangerReverts() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(AlarmProbe.NotSelf.selector);
        probe.ring(0);
        vm.prank(owner);
        vm.expectRevert(AlarmProbe.NotSelf.selector);
        probe.ring(0);
        assertEq(probe.rings(), 0);
    }

    function test_ScheduleRevertsWithHssResponseCode() public {
        hss.setScheduleResponseCode(10); // INSUFFICIENT_PAYER_BALANCE, any non-SUCCESS code
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AlarmProbe.ScheduleFailed.selector, int64(10)));
        probe.schedule(DELAY);
        assertEq(probe.nonce(), 0);
    }

    function test_CancelDeletesSchedule() public {
        address s = _schedule(600);
        vm.prank(owner);
        probe.cancel(s);
        assertTrue(hss.getSchedule(s).deleted);
        vm.expectRevert(abi.encodeWithSelector(MockHSS.ScheduleNotPending.selector, s));
        hss.fire(s);
        assertEq(probe.rings(), 0);
    }

    function test_CancelRevertsWithHssResponseCode() public {
        address s = _schedule(600);
        hss.setDeleteResponseCode(201); // INVALID_SCHEDULE_ID, any non-SUCCESS code
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AlarmProbe.DeleteFailed.selector, int64(201)));
        probe.cancel(s);
    }

    function test_OnlyOwnerCanScheduleOrCancel() public {
        address s = _schedule(600);
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(AlarmProbe.NotOwner.selector);
        probe.schedule(DELAY);
        vm.expectRevert(AlarmProbe.NotOwner.selector);
        probe.cancel(s);
        vm.stopPrank();
    }
}
