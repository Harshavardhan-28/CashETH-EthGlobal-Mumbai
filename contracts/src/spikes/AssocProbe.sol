// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IHRC719 } from "../hedera/IHRC719.sol";

/// @title AssocProbe
/// @notice Spike S2: a contract associates itself with HTS USDC through the HIP-719 facade, then moves
///         USDC with the facade's ERC-20 `transferFrom` (spending an HTS allowance) and `transfer`.
contract AssocProbe {
    using SafeERC20 for IERC20;

    /// @dev HTS response codes accepted from `associate()`.
    uint256 private constant _SUCCESS = 22;
    uint256 private constant _TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT = 194;

    address public immutable USDC;
    address public immutable OWNER;

    error AssociationFailed(uint256 responseCode);
    error NotOwner();

    constructor(address usdc) {
        USDC = usdc;
        OWNER = msg.sender;
        uint256 rc = IHRC719(usdc).associate();
        require(rc == _SUCCESS || rc == _TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT, AssociationFailed(rc));
    }

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    /// @notice Pulls `amount` USDC from `from`, spending the allowance `from` granted this contract.
    function pull(address from, uint256 amount) external onlyOwner {
        IERC20(USDC).safeTransferFrom(from, address(this), amount);
    }

    /// @notice Sends `amount` USDC held by this contract to `to`.
    function push(address to, uint256 amount) external onlyOwner {
        IERC20(USDC).safeTransfer(to, amount);
    }

    function isAssociated() external view returns (bool) {
        return IHRC719(USDC).isAssociated();
    }

    function balance() external view returns (uint256) {
        return IERC20(USDC).balanceOf(address(this));
    }

    function _checkOwner() internal view {
        require(msg.sender == OWNER, NotOwner());
    }
}
