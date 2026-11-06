// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IReceivableCreditNote } from "./interfaces/IReceivableCreditNote.sol";

/// @title ReceivableCreditNote
/// @notice Transfer-restricted ERC-20 (6 decimals) minted by the facility to lenders and burned by the
///         repayment router on settlement. A transfer is allowed only if it is a mint or burn, or if its
///         `from` or `to` is a peer (facility, swap router, Aqua); lender-to-lender transfers revert.
contract ReceivableCreditNote is IReceivableCreditNote, ERC20, Ownable {
    address public facility;
    address public repaymentRouter;
    address public swapRouter;
    address public aqua;
    bool private _wired;

    constructor(address owner_) ERC20("CashETH Receivable Credit Note", "RCN") Ownable(owner_) {}

    /// @notice One-time wiring of the circular addresses.
    function wire(address facility_, address repaymentRouter_, address swapRouter_, address aqua_)
        external
        onlyOwner
    {
        if (_wired) revert ALREADY_WIRED();
        if (
            facility_ == address(0) || repaymentRouter_ == address(0) || swapRouter_ == address(0)
                || aqua_ == address(0)
        ) revert ZERO_ADDRESS();
        _wired = true;
        facility = facility_;
        repaymentRouter = repaymentRouter_;
        swapRouter = swapRouter_;
        aqua = aqua_;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != facility) revert NOT_FACILITY();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != repaymentRouter) revert NOT_ROUTER();
        _burn(from, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function isPeer(address account) public view returns (bool) {
        return account != address(0) && (account == facility || account == swapRouter || account == aqua);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && !isPeer(from) && !isPeer(to)) {
            revert RCN_TRANSFER_RESTRICTED();
        }
        super._update(from, to, value);
    }
}
