// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Permissive USDC for protocol tests: 6 decimals, open `mint`, and an HTS facade whose
///      `associate()` always returns SUCCESS (22) and `isAssociated()` always returns true.
///      Use `MockHtsUsdc` instead when a test needs HTS association to be enforced.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function associate() external pure returns (uint256) {
        return 22;
    }

    function isAssociated() external pure returns (bool) {
        return true;
    }
}
