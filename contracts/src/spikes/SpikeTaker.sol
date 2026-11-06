// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";

/// @notice HIP-719 token facade: a contract associates itself with an HTS token by calling it.
interface IHRC719 {
    function associate() external returns (uint256 responseCode);
    function isAssociated() external view returns (bool);
}

/// @title SpikeTaker
/// @notice Spike S1 taker: holds `tokenIn`, receives HTS USDC, and fills Aqua strategies through an
///         unmodified AquaSwapVMRouter with `useTransferFromAndAquaPush` taker data.
contract SpikeTaker {
    using SafeERC20 for IERC20;

    /// @dev HTS response code SUCCESS.
    uint256 private constant _HTS_SUCCESS = 22;

    ISwapVM public immutable ROUTER;
    address public immutable USDC;
    IERC20 public immutable TOKEN_B;
    address public immutable OWNER;

    error NotOwner();
    error UsdcAssociationFailed(uint256 responseCode);

    event Filled(bytes32 indexed orderHash, uint256 amountIn, uint256 amountOut);

    constructor(ISwapVM router, address usdc, IERC20 tokenB) {
        ROUTER = router;
        USDC = usdc;
        TOKEN_B = tokenB;
        OWNER = msg.sender;
        uint256 rc = IHRC719(usdc).associate();
        require(rc == _HTS_SUCCESS, UsdcAssociationFailed(rc));
    }

    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    /// @notice Approves the router for exactly `amount` of TOKEN_B (exactIn) and swaps.
    function fill(ISwapVM.Order calldata order, uint256 amount, bytes calldata takerData)
        external
        onlyOwner
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
    {
        TOKEN_B.forceApprove(address(ROUTER), amount);
        (amountIn, amountOut, orderHash) = ROUTER.swap(order, amount, takerData);
        TOKEN_B.forceApprove(address(ROUTER), 0);
        emit Filled(orderHash, amountIn, amountOut);
    }

    function _checkOwner() internal view {
        require(msg.sender == OWNER, NotOwner());
    }

    /// @notice Returns this contract's whole balance of `token` to `to`.
    function sweep(IERC20 token, address to) external onlyOwner {
        token.safeTransfer(to, token.balanceOf(address(this)));
    }
}
