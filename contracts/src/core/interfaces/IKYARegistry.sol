// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Know-Your-Agent registry: identity, KYA level, owner group, mandate and repayment reputation.
/// @dev Roles: 1 Seller, 2 Buyer, 3 Worker, 4 Lender.
interface IKYARegistry {
    struct Agent {
        bytes32 uaidHash;
        bytes32 ownerGroup;
        uint8 role;
        uint8 level;
        uint64 expiresAt; // 0 = never expires
        bool revoked;
        bytes32 mandateHash;
    }

    event AgentRegistered(address indexed agent, bytes32 uaidHash, uint8 role, uint8 level, bytes32 ownerGroup);
    event LevelSet(address indexed agent, uint8 level);
    event AgentRevoked(address indexed agent);
    event RepaymentRecorded(address indexed buyer, address indexed seller, bool onTime);
    event DefaultRecorded(address indexed buyer, address indexed seller);

    error NOT_ISSUER();
    error NOT_ROUTER();
    error NOT_FACILITY();
    error ALREADY_WIRED();

    function wire(address repaymentRouter, address facility) external;

    function register(address account, Agent calldata a) external;
    function setLevel(address account, uint8 newLevel) external;
    function setMandate(address account, bytes32 newMandateHash) external;
    function revoke(address account) external;

    /// @return 0 if the agent is revoked or past `expiresAt` (when `expiresAt != 0`), else the stored level.
    function level(address account) external view returns (uint8);
    function ownerGroup(address account) external view returns (bytes32);
    function role(address account) external view returns (uint8);
    function mandateHash(address account) external view returns (bytes32);
    function agent(address account) external view returns (Agent memory);

    function recordRepayment(address buyer, address seller, bool onTime) external;
    function recordDefault(address buyer, address seller) external;
    function reputation(address account) external view returns (uint32 onTime, uint32 late, uint32 defaults);
}
