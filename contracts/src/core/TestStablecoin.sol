// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TestStablecoin
/// @notice tUSDT: the second leg of the lenders' base-yield strategies (USDC / tUSDT on the CashETH SwapVM
///         router). A plain 6-decimal ERC-20 that only its owner can mint; testnet only, no value. Being a
///         regular EVM token it needs no HTS association.
contract TestStablecoin is ERC20, Ownable {
    constructor(address owner_) ERC20("CashETH Test USDT", "tUSDT") Ownable(owner_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
