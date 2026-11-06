// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { MockHSS } from "./mocks/MockHSS.sol";

contract ValueSink {
    address public lastSender;
    uint256 public lastValue;

    function hit() external payable {
        lastSender = msg.sender;
        lastValue = msg.value;
    }
}

/// @notice MockHSS forwards a scheduled call's `value` from the scheduler, exactly once.
contract MockHSSTest is Test {
    address internal constant HSS = address(0x16b);
    uint64 internal constant VALUE = 1 ether;

    MockHSS internal hss;
    ValueSink internal sink;
    address internal scheduler = makeAddr("scheduler");

    function setUp() public {
        vm.etch(HSS, address(new MockHSS()).code);
        hss = MockHSS(HSS);
        sink = new ValueSink();
        vm.deal(scheduler, 3 ether);
    }

    function test_FireForwardsValueFromSchedulerOnce() public {
        vm.prank(scheduler);
        (int64 rc, address s) =
            hss.scheduleCall(address(sink), block.timestamp + 60, 100_000, VALUE, abi.encodeCall(ValueSink.hit, ()));
        assertEq(rc, 22);

        uint256 schedulerBefore = scheduler.balance;
        uint256 sinkBefore = address(sink).balance;
        uint256 hssBefore = HSS.balance;
        hss.fire(s);

        assertEq(schedulerBefore - scheduler.balance, VALUE);
        assertEq(address(sink).balance - sinkBefore, VALUE);
        assertEq(HSS.balance, hssBefore);
        assertEq(sink.lastSender(), scheduler);
        assertEq(sink.lastValue(), VALUE);
    }

    function test_FireAllExecutesEveryPendingScheduleOnce() public {
        vm.startPrank(scheduler);
        (, address first) =
            hss.scheduleCall(address(sink), block.timestamp + 60, 100_000, VALUE, abi.encodeCall(ValueSink.hit, ()));
        (, address deleted) =
            hss.scheduleCall(address(sink), block.timestamp + 90, 100_000, VALUE, abi.encodeCall(ValueSink.hit, ()));
        (, address last) =
            hss.scheduleCall(address(sink), block.timestamp + 120, 100_000, VALUE, abi.encodeCall(ValueSink.hit, ()));
        assertEq(hss.deleteSchedule(deleted), 22);
        vm.stopPrank();

        hss.fire(first);
        uint256 schedulerBefore = scheduler.balance;
        uint256 sinkBefore = address(sink).balance;

        // Fires regardless of `expirySecond`; skips executed and deleted schedules.
        hss.fireAll();

        assertEq(schedulerBefore - scheduler.balance, VALUE);
        assertEq(address(sink).balance - sinkBefore, VALUE);
        assertTrue(hss.getSchedule(last).executed);
        assertFalse(hss.getSchedule(deleted).executed);

        // Nothing is pending any more, so a second sweep moves no value.
        hss.fireAll();
        assertEq(address(sink).balance - sinkBefore, VALUE);
        vm.expectRevert(abi.encodeWithSelector(MockHSS.ScheduleNotPending.selector, last));
        hss.fire(last);
    }
}
