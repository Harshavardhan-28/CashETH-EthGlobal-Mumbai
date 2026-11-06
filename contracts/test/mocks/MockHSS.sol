// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Vm } from "forge-std/Vm.sol";

import { IHederaScheduleService } from "../../src/hedera/IHederaScheduleService.sol";

/// @dev Local stand-in for the Hedera Schedule Service at `address(0x16b)`; install it with
///      `vm.etch(address(0x16b), address(new MockHSS()).code)` (storage starts zeroed, so every
///      setting defaults to "succeed"). Schedule addresses are `address(1)`, `address(2)`, ...
///      `fire(schedule)` performs the stored call with the scheduling contract as `msg.sender`, as the
///      network does when the schedule executes.
contract MockHSS is IHederaScheduleService {
    struct Scheduled {
        address scheduler;
        address to;
        uint256 expirySecond;
        uint256 gasLimit;
        uint64 value;
        bytes callData;
        bool deleted;
        bool executed;
    }

    Vm private constant _VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    int64 private constant _SUCCESS = 22;

    uint256 public n;
    /// @dev 0 means SUCCESS (22); any other value is returned instead and nothing is recorded.
    int64 public scheduleResponseCode;
    int64 public deleteResponseCode;
    bool public noCapacity;
    mapping(address => Scheduled) internal _schedules;

    error UnknownSchedule(address scheduleAddress);
    error ScheduleNotPending(address scheduleAddress);
    error ScheduledCallFailed(bytes returnData);

    function setScheduleResponseCode(int64 code) external {
        scheduleResponseCode = code;
    }

    function setDeleteResponseCode(int64 code) external {
        deleteResponseCode = code;
    }

    function setNoCapacity(bool value) external {
        noCapacity = value;
    }

    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData)
        external
        returns (int64 responseCode, address scheduleAddress)
    {
        if (scheduleResponseCode != 0) return (scheduleResponseCode, address(0));
        // casting to 'uint160' is safe because `n` is a small counter
        // forge-lint: disable-next-line(unsafe-typecast)
        scheduleAddress = address(uint160(++n));
        _schedules[scheduleAddress] = Scheduled({
            scheduler: msg.sender,
            to: to,
            expirySecond: expirySecond,
            gasLimit: gasLimit,
            value: value,
            callData: callData,
            deleted: false,
            executed: false
        });
        return (_SUCCESS, scheduleAddress);
    }

    function hasScheduleCapacity(uint256, uint256) external view returns (bool) {
        return !noCapacity;
    }

    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode) {
        if (deleteResponseCode != 0) return deleteResponseCode;
        Scheduled storage s = _schedules[scheduleAddress];
        require(s.scheduler != address(0), UnknownSchedule(scheduleAddress));
        require(!s.deleted && !s.executed, ScheduleNotPending(scheduleAddress));
        s.deleted = true;
        return _SUCCESS;
    }

    function getSchedule(address scheduleAddress) external view returns (Scheduled memory) {
        return _schedules[scheduleAddress];
    }

    /// @notice Executes a pending schedule: calls `to` with `callData` as the scheduling contract.
    function fire(address scheduleAddress) external {
        Scheduled storage s = _schedules[scheduleAddress];
        require(s.scheduler != address(0), UnknownSchedule(scheduleAddress));
        require(!s.deleted && !s.executed, ScheduleNotPending(scheduleAddress));
        s.executed = true;
        // A pranked call sends `value` from the pranked sender, so the scheduler pays it exactly once.
        _VM.prank(s.scheduler);
        (bool ok, bytes memory ret) = s.to.call{ value: s.value }(s.callData);
        require(ok, ScheduledCallFailed(ret));
    }
}
