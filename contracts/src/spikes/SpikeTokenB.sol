// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title SpikeTokenB
/// @notice Plain 6-decimal ERC-20 (MockUSDC-style) used as the second leg of the spike S1 strategy.
contract SpikeTokenB is ERC20, Ownable {
    constructor() ERC20("CashETH Spike Token B", "TOKENB") Ownable(msg.sender) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
