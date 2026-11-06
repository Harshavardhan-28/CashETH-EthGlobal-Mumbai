// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Hedera Schedule Service system contract at `address(0x16b)` (HIP-755 / HIP-1215 subset).
///         `scheduleCall` does not revert on failure: it returns a non-SUCCESS code and `address(0)`.
///         The scheduling contract pays for the scheduled execution and is `msg.sender` when it runs.
interface IHederaScheduleService {
    function scheduleCall(address to, uint256 expirySecond, uint256 gasLimit, uint64 value, bytes memory callData)
        external
        returns (int64 responseCode, address scheduleAddress);

    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool);

    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);
}
