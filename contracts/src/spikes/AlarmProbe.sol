// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { HederaResponseCodes } from "../hedera/HederaResponseCodes.sol";
import { IHederaScheduleService } from "../hedera/IHederaScheduleService.sol";

/// @title AlarmProbe
/// @notice Spike S4: the contract schedules `ring(nonce)` on itself through the Hedera Schedule Service
///         (HIP-1215) and the network executes it at the requested consensus second. The probe pays for
///         its scheduled executions, so it holds HBAR.
contract AlarmProbe {
    IHederaScheduleService internal constant HSS = IHederaScheduleService(address(0x16b));
    uint256 internal constant RING_GAS_LIMIT = 200_000;

    address public immutable OWNER;
    uint256 public rings;
    uint256 public nonce;

    event Scheduled(address schedule, uint256 nonce, uint256 at);
    event Rang(uint256 nonce, uint256 at);

    error ScheduleFailed(int64 responseCode);
    error DeleteFailed(int64 responseCode);
    error NotSelf();
    error NotOwner();

    constructor() payable {
        OWNER = msg.sender;
    }

    receive() external payable {}

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    /// @notice Schedules `ring(nonce)` on this contract `delaySeconds` from now.
    function schedule(uint256 delaySeconds) external onlyOwner returns (address scheduleAddress) {
        uint256 expiry = block.timestamp + delaySeconds;
        uint256 n = nonce;
        int64 rc;
        (rc, scheduleAddress) =
            HSS.scheduleCall(address(this), expiry, RING_GAS_LIMIT, 0, abi.encodeCall(this.ring, (n)));
        require(rc == HederaResponseCodes.SUCCESS, ScheduleFailed(rc));
        nonce = n + 1;
        emit Scheduled(scheduleAddress, n, expiry);
    }

    /// @notice Executed by the network when a schedule fires; the callee sees the probe as `msg.sender`.
    function ring(uint256 n) external {
        require(msg.sender == address(this), NotSelf());
        rings += 1;
        emit Rang(n, block.timestamp);
    }

    /// @notice Deletes a pending schedule created by this contract.
    function cancel(address scheduleAddress) external onlyOwner {
        int64 rc = HSS.deleteSchedule(scheduleAddress);
        require(rc == HederaResponseCodes.SUCCESS, DeleteFailed(rc));
    }

    function _checkOwner() internal view {
        require(msg.sender == OWNER, NotOwner());
    }
}
