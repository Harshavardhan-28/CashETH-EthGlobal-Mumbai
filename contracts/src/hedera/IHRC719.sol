// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice HIP-719 HTS token facade: an account (or contract) manages its own association with a token
///         by calling the token's address. Call with a plain `call`, never `delegatecall`.
interface IHRC719 {
    function associate() external returns (uint256 responseCode);
    function dissociate() external returns (uint256 responseCode);
    function isAssociated() external view returns (bool);
}
