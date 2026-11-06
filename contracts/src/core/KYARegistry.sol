// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IKYARegistry } from "./interfaces/IKYARegistry.sol";

/// @title KYARegistry
/// @notice Know-Your-Agent registry. The issuer registers agents (identity hash, owner group, role, level,
///         expiry, mandate); the repayment router and credit facility record repayment reputation.
contract KYARegistry is IKYARegistry, Ownable {
    struct Reputation {
        uint32 onTime;
        uint32 late;
        uint32 defaults;
    }

    address public immutable ISSUER;
    address public repaymentRouter;
    address public facility;
    bool private _wired;

    mapping(address => Agent) private _agents;
    mapping(address => Reputation) private _reputation;

    modifier onlyIssuer() {
        _checkIssuer();
        _;
    }

    modifier onlyRouter() {
        _checkRouter();
        _;
    }

    modifier onlyFacility() {
        _checkFacility();
        _;
    }

    constructor(address issuer_, address owner_) Ownable(owner_) {
        ISSUER = issuer_;
    }

    /// @notice One-time wiring of the circular addresses.
    function wire(address repaymentRouter_, address facility_) external onlyOwner {
        if (_wired) revert ALREADY_WIRED();
        _wired = true;
        repaymentRouter = repaymentRouter_;
        facility = facility_;
    }

    function _checkIssuer() internal view {
        if (msg.sender != ISSUER) revert NOT_ISSUER();
    }

    function _checkRouter() internal view {
        if (msg.sender != repaymentRouter) revert NOT_ROUTER();
    }

    function _checkFacility() internal view {
        if (msg.sender != facility) revert NOT_FACILITY();
    }

    function register(address account, Agent calldata a) external onlyIssuer {
        _agents[account] = a;
        emit AgentRegistered(account, a.uaidHash, a.role, a.level, a.ownerGroup);
    }

    function setLevel(address account, uint8 newLevel) external onlyIssuer {
        _agents[account].level = newLevel;
        emit LevelSet(account, newLevel);
    }

    function setMandate(address account, bytes32 newMandateHash) external onlyIssuer {
        _agents[account].mandateHash = newMandateHash;
    }

    function revoke(address account) external onlyIssuer {
        _agents[account].revoked = true;
        emit AgentRevoked(account);
    }

    function level(address account) external view returns (uint8) {
        Agent storage a = _agents[account];
        if (a.revoked) return 0;
        if (a.expiresAt != 0 && block.timestamp > a.expiresAt) return 0;
        return a.level;
    }

    function ownerGroup(address account) external view returns (bytes32) {
        return _agents[account].ownerGroup;
    }

    function role(address account) external view returns (uint8) {
        return _agents[account].role;
    }

    function mandateHash(address account) external view returns (bytes32) {
        return _agents[account].mandateHash;
    }

    function agent(address account) external view returns (Agent memory) {
        return _agents[account];
    }

    /// @notice Buyer gets an on-time or late mark; the seller gets an on-time mark for every repaid receivable.
    function recordRepayment(address buyer, address seller, bool onTime) external onlyRouter {
        if (onTime) {
            _reputation[buyer].onTime += 1;
        } else {
            _reputation[buyer].late += 1;
        }
        _reputation[seller].onTime += 1;
        emit RepaymentRecorded(buyer, seller, onTime);
    }

    /// @notice A default counts against the buyer only.
    function recordDefault(address buyer, address seller) external onlyFacility {
        _reputation[buyer].defaults += 1;
        emit DefaultRecorded(buyer, seller);
    }

    function reputation(address account) external view returns (uint32 onTime, uint32 late, uint32 defaults) {
        Reputation storage r = _reputation[account];
        return (r.onTime, r.late, r.defaults);
    }
}
