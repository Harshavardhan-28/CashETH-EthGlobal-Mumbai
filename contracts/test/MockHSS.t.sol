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
}
