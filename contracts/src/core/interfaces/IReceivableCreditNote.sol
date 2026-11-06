// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Receivable Credit Note: the 6-decimal claim a lender receives for USDC advanced against a
///         receivable. Transfers are restricted to moves into or out of a protocol peer
///         (facility, swap router, Aqua); lender-to-lender transfers revert.
interface IReceivableCreditNote is IERC20 {
    error ALREADY_WIRED();
    error ZERO_ADDRESS();
    error NOT_FACILITY();
    error NOT_ROUTER();
    error RCN_TRANSFER_RESTRICTED();

    /// @notice One-time wiring of the protocol addresses; all four must be non-zero.
    function wire(address facility, address repaymentRouter, address swapRouter, address aqua) external;

    /// @notice Mints `amount` to `to`; only the facility.
    function mint(address to, uint256 amount) external;

    /// @notice Burns `amount` from `from` without an allowance; only the repayment router.
    function burn(address from, uint256 amount) external;

    function facility() external view returns (address);
    function repaymentRouter() external view returns (address);
    function swapRouter() external view returns (address);
    function aqua() external view returns (address);

    /// @return True if `account` is the facility, the swap router or Aqua.
    function isPeer(address account) external view returns (bool);
}
