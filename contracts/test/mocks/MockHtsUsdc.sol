// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Local stand-in for the HTS USDC facade: 6 decimals, HIP-719 `associate()`, and transfers to
///      unassociated accounts revert like HTS does. `associate()` returns `associateResponseCode`
///      (default SUCCESS = 22) and only associates the caller on SUCCESS.
contract MockHtsUsdc is ERC20 {
    mapping(address => bool) public associated;
    uint256 public associateResponseCode = 22;

    error TokenNotAssociatedToAccount(address account);

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setAssociateResponseCode(uint256 code) external {
        associateResponseCode = code;
    }

    function associate() external returns (uint256) {
        if (associateResponseCode == 22) associated[msg.sender] = true;
        return associateResponseCode;
    }

    function isAssociated() external view returns (bool) {
        return associated[msg.sender];
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to != address(0)) require(associated[to], TokenNotAssociatedToAccount(to));
        super._update(from, to, value);
    }
}
