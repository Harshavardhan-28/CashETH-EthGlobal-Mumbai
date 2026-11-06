// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { KYARegistry } from "../src/core/KYARegistry.sol";
import { IKYARegistry } from "../src/core/interfaces/IKYARegistry.sol";

contract KYARegistryTest is Test {
    KYARegistry internal kya;

    address internal issuer = makeAddr("issuer");
    address internal owner = makeAddr("owner");
    address internal router = makeAddr("router");
    address internal facility = makeAddr("facility");
    address internal stranger = makeAddr("stranger");
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");

    bytes32 internal constant SELLER_GROUP = keccak256("seller-co");
    bytes32 internal constant BUYER_GROUP = keccak256("buyer-co");

    function setUp() public {
        kya = new KYARegistry(issuer, owner);
    }

    function _agent(bytes32 uaid, bytes32 group, uint8 role, uint8 lvl, uint64 expiresAt)
        internal
        pure
        returns (IKYARegistry.Agent memory a)
    {
        a = IKYARegistry.Agent({
            uaidHash: uaid,
            ownerGroup: group,
            role: role,
            level: lvl,
            expiresAt: expiresAt,
            revoked: false,
            mandateHash: keccak256("mandate-v1")
        });
    }

    function _wire() internal {
        vm.prank(owner);
        kya.wire(router, facility);
    }

    function test_register_setsFieldsAndEmits() public {
        IKYARegistry.Agent memory a = _agent(keccak256("uaid:seller"), SELLER_GROUP, 1, 2, uint64(block.timestamp + 30 days));

        vm.expectEmit(true, false, false, true, address(kya));
        emit IKYARegistry.AgentRegistered(seller, a.uaidHash, 1, 2, SELLER_GROUP);
        vm.prank(issuer);
        kya.register(seller, a);

        IKYARegistry.Agent memory got = kya.agent(seller);
        assertEq(got.uaidHash, a.uaidHash);
        assertEq(got.ownerGroup, SELLER_GROUP);
        assertEq(got.role, 1);
        assertEq(got.level, 2);
        assertEq(got.expiresAt, a.expiresAt);
        assertFalse(got.revoked);
        assertEq(got.mandateHash, keccak256("mandate-v1"));
        assertEq(kya.level(seller), 2);
        assertEq(kya.role(seller), 1);
        assertEq(kya.ownerGroup(seller), SELLER_GROUP);
        assertEq(kya.mandateHash(seller), keccak256("mandate-v1"));

        // issuer updates level and mandate
        vm.expectEmit(true, false, false, true, address(kya));
        emit IKYARegistry.LevelSet(seller, 3);
        vm.prank(issuer);
        kya.setLevel(seller, 3);
        assertEq(kya.level(seller), 3);
        assertEq(kya.agent(seller).level, 3);

        vm.prank(issuer);
        kya.setMandate(seller, keccak256("mandate-v2"));
        assertEq(kya.mandateHash(seller), keccak256("mandate-v2"));

        // unknown agent reads as zero
        assertEq(kya.level(stranger), 0);
        assertEq(kya.role(stranger), 0);
        assertEq(kya.ownerGroup(stranger), bytes32(0));
    }

    function test_level_zeroWhenRevoked() public {
        vm.prank(issuer);
        kya.register(buyer, _agent(keccak256("uaid:buyer"), BUYER_GROUP, 2, 3, 0));
        assertEq(kya.level(buyer), 3);

        vm.expectEmit(true, false, false, true, address(kya));
        emit IKYARegistry.AgentRevoked(buyer);
        vm.prank(issuer);
        kya.revoke(buyer);

        assertEq(kya.level(buyer), 0);
        assertTrue(kya.agent(buyer).revoked);
        // raw reads are unaffected by revocation
        assertEq(kya.agent(buyer).level, 3);
        assertEq(kya.role(buyer), 2);
        assertEq(kya.ownerGroup(buyer), BUYER_GROUP);
    }

    function test_level_zeroWhenExpired() public {
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        vm.startPrank(issuer);
        kya.register(buyer, _agent(keccak256("uaid:buyer"), BUYER_GROUP, 2, 3, expiresAt));
        kya.register(seller, _agent(keccak256("uaid:seller"), SELLER_GROUP, 1, 2, 0)); // never expires
        vm.stopPrank();

        vm.warp(expiresAt);
        assertEq(kya.level(buyer), 3, "valid at expiresAt");

        vm.warp(uint256(expiresAt) + 1);
        assertEq(kya.level(buyer), 0, "expired after expiresAt");
        assertEq(kya.agent(buyer).level, 3, "raw level kept");
        assertEq(kya.role(buyer), 2);

        vm.warp(uint256(expiresAt) + 3650 days);
        assertEq(kya.level(seller), 2, "expiresAt == 0 never expires");
    }

    function test_register_revertsForNonIssuer() public {
        IKYARegistry.Agent memory a = _agent(keccak256("uaid:seller"), SELLER_GROUP, 1, 2, 0);

        vm.startPrank(stranger);
        vm.expectRevert(IKYARegistry.NOT_ISSUER.selector);
        kya.register(seller, a);
        vm.expectRevert(IKYARegistry.NOT_ISSUER.selector);
        kya.setLevel(seller, 4);
        vm.expectRevert(IKYARegistry.NOT_ISSUER.selector);
        kya.setMandate(seller, bytes32(uint256(1)));
        vm.expectRevert(IKYARegistry.NOT_ISSUER.selector);
        kya.revoke(seller);
        vm.stopPrank();

        // the owner is not the issuer either
        vm.prank(owner);
        vm.expectRevert(IKYARegistry.NOT_ISSUER.selector);
        kya.register(seller, a);

        assertEq(kya.role(seller), 0);
    }

    function test_recordRepayment_onlyRouter() public {
        // unwired: nobody is the router
        vm.prank(stranger);
        vm.expectRevert(IKYARegistry.NOT_ROUTER.selector);
        kya.recordRepayment(buyer, seller, true);

        _wire();

        vm.prank(stranger);
        vm.expectRevert(IKYARegistry.NOT_ROUTER.selector);
        kya.recordRepayment(buyer, seller, true);

        vm.prank(facility);
        vm.expectRevert(IKYARegistry.NOT_ROUTER.selector);
        kya.recordRepayment(buyer, seller, true);

        vm.prank(router);
        kya.recordRepayment(buyer, seller, true);
        (uint32 onTime,,) = kya.reputation(buyer);
        assertEq(onTime, 1);
    }

    function test_recordRepayment_updatesBothCounters() public {
        _wire();

        vm.expectEmit(true, true, false, true, address(kya));
        emit IKYARegistry.RepaymentRecorded(buyer, seller, true);
        vm.prank(router);
        kya.recordRepayment(buyer, seller, true);

        vm.expectEmit(true, true, false, true, address(kya));
        emit IKYARegistry.RepaymentRecorded(buyer, seller, false);
        vm.prank(router);
        kya.recordRepayment(buyer, seller, false);

        (uint32 bOnTime, uint32 bLate, uint32 bDefaults) = kya.reputation(buyer);
        assertEq(bOnTime, 1, "buyer onTime");
        assertEq(bLate, 1, "buyer late");
        assertEq(bDefaults, 0, "buyer defaults");

        (uint32 sOnTime, uint32 sLate, uint32 sDefaults) = kya.reputation(seller);
        assertEq(sOnTime, 2, "seller onTime counts every repayment");
        assertEq(sLate, 0, "seller late");
        assertEq(sDefaults, 0, "seller defaults");
    }

    function test_recordDefault_onlyFacility() public {
        vm.prank(stranger);
        vm.expectRevert(IKYARegistry.NOT_FACILITY.selector);
        kya.recordDefault(buyer, seller);

        _wire();

        vm.prank(stranger);
        vm.expectRevert(IKYARegistry.NOT_FACILITY.selector);
        kya.recordDefault(buyer, seller);

        vm.prank(router);
        vm.expectRevert(IKYARegistry.NOT_FACILITY.selector);
        kya.recordDefault(buyer, seller);

        vm.expectEmit(true, true, false, true, address(kya));
        emit IKYARegistry.DefaultRecorded(buyer, seller);
        vm.prank(facility);
        kya.recordDefault(buyer, seller);

        (uint32 bOnTime, uint32 bLate, uint32 bDefaults) = kya.reputation(buyer);
        assertEq(bOnTime, 0);
        assertEq(bLate, 0);
        assertEq(bDefaults, 1, "buyer defaults");
        (uint32 sOnTime, uint32 sLate, uint32 sDefaults) = kya.reputation(seller);
        assertEq(sOnTime + sLate + sDefaults, 0, "seller untouched");
    }

    function test_wire_once() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        kya.wire(router, facility);

        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, issuer));
        kya.wire(router, facility);

        _wire();
        assertEq(kya.repaymentRouter(), router);
        assertEq(kya.facility(), facility);

        vm.prank(owner);
        vm.expectRevert(IKYARegistry.ALREADY_WIRED.selector);
        kya.wire(stranger, stranger);

        assertEq(kya.repaymentRouter(), router);
        assertEq(kya.facility(), facility);
    }
}
