// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { KYARegistry } from "../src/core/KYARegistry.sol";
import { IKYARegistry } from "../src/core/interfaces/IKYARegistry.sol";
import { ReceivableRegistry } from "../src/core/ReceivableRegistry.sol";
import { IReceivableRegistry } from "../src/core/interfaces/IReceivableRegistry.sol";

contract ReceivableRegistryTest is Test {
    // ---- EIP-712 spec strings (independent of the contract) ----
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant CONFIRMATION_TYPEHASH = keccak256(
        "ReceivableConfirmation(address seller,address buyer,address currency,uint256 amount,uint64 dueDate,bytes32 buyerRef,bytes32 detailsCommitment,address payTo,uint256 nonce,uint64 deadline)"
    );
    bytes32 internal constant CANCEL_TYPEHASH = keccak256("CancelReceivable(bytes32 id)");

    // ---- Fixed vector shared with TypeScript (Task 2.3) ----
    uint256 internal constant VECTOR_CHAIN_ID = 296;
    address internal constant VECTOR_REGISTRY = 0x4444444444444444444444444444444444444444;
    address internal constant VECTOR_SELLER = 0x1111111111111111111111111111111111111111;
    address internal constant VECTOR_BUYER = 0x2222222222222222222222222222222222222222;
    address internal constant VECTOR_CURRENCY = 0x0000000000000000000000000000000000068cDa;
    uint256 internal constant VECTOR_AMOUNT = 10_000_000;
    uint64 internal constant VECTOR_DUE_DATE = 1_800_000_000;
    bytes32 internal constant VECTOR_BUYER_REF = keccak256("PO-1001");
    bytes32 internal constant VECTOR_DETAILS = keccak256("doc");
    address internal constant VECTOR_PAY_TO = 0x3333333333333333333333333333333333333333;
    uint256 internal constant VECTOR_NONCE = 0;
    uint64 internal constant VECTOR_DEADLINE = 1_799_999_000;
    bytes32 internal constant VECTOR_DIGEST = 0xa92d06494ee4362f2ede26cdd00a3a6c491fec7cdf5f3741d7240cb3f3d777e0;

    address internal constant USDC = 0x0000000000000000000000000000000000068cDa;
    bytes32 internal constant SELLER_GROUP = keccak256("seller-co");
    bytes32 internal constant BUYER_GROUP = keccak256("buyer-co");

    KYARegistry internal kya;
    ReceivableRegistry internal registry;

    uint256 internal buyerPk = 0xB0B;
    uint256 internal sellerPk = 0x5E11E4;
    address internal buyer;
    address internal seller;

    address internal issuer = makeAddr("issuer");
    address internal owner = makeAddr("owner");
    address internal facility = makeAddr("facility");
    address internal router = makeAddr("router");
    address internal orchestrator = makeAddr("orchestrator");
    address internal stranger = makeAddr("stranger");

    uint256 internal refCounter;

    function setUp() public {
        vm.warp(1_750_000_000);
        buyer = vm.addr(buyerPk);
        seller = vm.addr(sellerPk);

        kya = new KYARegistry(issuer, owner);
        _kyaRegister(seller, SELLER_GROUP, 1, 2);
        _kyaRegister(buyer, BUYER_GROUP, 2, 3);

        registry = new ReceivableRegistry(IKYARegistry(address(kya)), USDC, owner);
        vm.prank(owner);
        registry.wire(facility, router);
    }

    // ------------------------------------------------------------------ helpers

    function _kyaRegister(address who, bytes32 group, uint8 role, uint8 lvl) internal {
        vm.prank(issuer);
        kya.register(
            who,
            IKYARegistry.Agent({
                uaidHash: keccak256(abi.encode(who)),
                ownerGroup: group,
                role: role,
                level: lvl,
                expiresAt: 0,
                revoked: false,
                mandateHash: bytes32(0)
            })
        );
    }

    function _conf(bytes32 buyerRef, uint256 nonce)
        internal
        view
        returns (IReceivableRegistry.ReceivableConfirmation memory c)
    {
        c = IReceivableRegistry.ReceivableConfirmation({
            seller: seller,
            buyer: buyer,
            currency: USDC,
            amount: 10_000_000,
            dueDate: uint64(block.timestamp + 30 days),
            buyerRef: buyerRef,
            detailsCommitment: keccak256("doc"),
            payTo: router,
            nonce: nonce,
            deadline: uint64(block.timestamp + 1 hours)
        });
    }

    function _conf() internal view returns (IReceivableRegistry.ReceivableConfirmation memory) {
        return _conf(keccak256("PO-1001"), registry.nonces(buyer));
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signConf(uint256 pk, IReceivableRegistry.ReceivableConfirmation memory c)
        internal
        view
        returns (bytes memory)
    {
        return _sig(pk, registry.hashConfirmation(c));
    }

    function _structHash(IReceivableRegistry.ReceivableConfirmation memory c) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CONFIRMATION_TYPEHASH,
                c.seller,
                c.buyer,
                c.currency,
                c.amount,
                c.dueDate,
                c.buyerRef,
                c.detailsCommitment,
                c.payTo,
                c.nonce,
                c.deadline
            )
        );
    }

    function _domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("AgentReceivables"), keccak256("1"), chainId, verifyingContract
            )
        );
    }

    function _register(IReceivableRegistry.ReceivableConfirmation memory c) internal returns (bytes32) {
        bytes memory sig = _signConf(buyerPk, c);
        vm.prank(orchestrator);
        return registry.register(c, sig);
    }

    function _expectRegisterRevert(IReceivableRegistry.ReceivableConfirmation memory c, bytes4 selector) internal {
        bytes memory sig = _signConf(buyerPk, c);
        vm.prank(orchestrator);
        vm.expectRevert(selector);
        registry.register(c, sig);
    }

    function _registerFresh() internal returns (bytes32) {
        refCounter++;
        return _register(_conf(keccak256(abi.encode("PO", refCounter)), registry.nonces(buyer)));
    }

    function _cancelSigs(bytes32 id) internal view returns (bytes memory sellerSig, bytes memory buyerSig) {
        bytes32 digest = registry.hashCancel(id);
        sellerSig = _sig(sellerPk, digest);
        buyerSig = _sig(buyerPk, digest);
    }

    // ------------------------------------------------------------------ vector

    function test_vector_hashConfirmation() public {
        vm.chainId(VECTOR_CHAIN_ID);
        deployCodeTo(
            "ReceivableRegistry.sol:ReceivableRegistry",
            abi.encode(address(kya), USDC, owner),
            VECTOR_REGISTRY
        );
        IReceivableRegistry.ReceivableConfirmation memory c = IReceivableRegistry.ReceivableConfirmation({
            seller: VECTOR_SELLER,
            buyer: VECTOR_BUYER,
            currency: VECTOR_CURRENCY,
            amount: VECTOR_AMOUNT,
            dueDate: VECTOR_DUE_DATE,
            buyerRef: VECTOR_BUYER_REF,
            detailsCommitment: VECTOR_DETAILS,
            payTo: VECTOR_PAY_TO,
            nonce: VECTOR_NONCE,
            deadline: VECTOR_DEADLINE
        });
        bytes32 digest = IReceivableRegistry(VECTOR_REGISTRY).hashConfirmation(c);

        emit log_named_uint("vector chainId", block.chainid);
        emit log_named_address("vector verifyingContract", VECTOR_REGISTRY);
        emit log_named_bytes32("vector domainSeparator", _domainSeparator(VECTOR_CHAIN_ID, VECTOR_REGISTRY));
        emit log_named_bytes32("vector structHash", _structHash(c));
        emit log_named_bytes32("vector hashConfirmation", digest);

        bytes32 expected = keccak256(
            abi.encodePacked("\x19\x01", _domainSeparator(VECTOR_CHAIN_ID, VECTOR_REGISTRY), _structHash(c))
        );
        assertEq(digest, expected, "digest matches independent EIP-712 computation");
        assertEq(digest, VECTOR_DIGEST, "digest matches pinned vector");
        assertEq(
            ReceivableRegistry(VECTOR_REGISTRY).CONFIRMATION_TYPEHASH(), CONFIRMATION_TYPEHASH, "confirmation typehash"
        );
        assertEq(ReceivableRegistry(VECTOR_REGISTRY).CANCEL_TYPEHASH(), CANCEL_TYPEHASH, "cancel typehash");
        assertEq(
            IReceivableRegistry(VECTOR_REGISTRY).hashCancel(VECTOR_BUYER_REF),
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    _domainSeparator(VECTOR_CHAIN_ID, VECTOR_REGISTRY),
                    keccak256(abi.encode(CANCEL_TYPEHASH, VECTOR_BUYER_REF))
                )
            ),
            "cancel digest"
        );
    }

    // ------------------------------------------------------------------ register

    function test_register_happyPath() public {
        IReceivableRegistry.ReceivableConfirmation memory c = _conf();
        bytes32 expectedId = keccak256(abi.encode(buyer, c.buyerRef));
        assertEq(registry.computeId(buyer, c.buyerRef), expectedId);
        assertEq(registry.nonces(buyer), 0);

        bytes memory sig = _signConf(buyerPk, c);
        vm.expectEmit(true, true, true, true, address(registry));
        emit IReceivableRegistry.Registered(expectedId, seller, buyer, c.amount, c.dueDate, c.detailsCommitment);
        vm.expectEmit(true, false, false, true, address(registry));
        emit IReceivableRegistry.StateChanged(
            expectedId, IReceivableRegistry.State.None, IReceivableRegistry.State.Confirmed
        );
        vm.prank(orchestrator); // anyone may submit the buyer's signature
        bytes32 id = registry.register(c, sig);

        assertEq(id, expectedId);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));
        IReceivableRegistry.Receivable memory r = registry.get(id);
        assertEq(r.seller, seller);
        assertEq(r.buyer, buyer);
        assertEq(r.currency, USDC);
        assertEq(r.amount, c.amount);
        assertEq(r.dueDate, c.dueDate);
        assertEq(r.detailsCommitment, c.detailsCommitment);
        assertEq(uint8(r.state), uint8(IReceivableRegistry.State.Confirmed));
        assertEq(r.registeredAt, uint64(block.timestamp));
        assertEq(registry.nonces(buyer), 1);
        assertEq(
            registry.hashConfirmation(c),
            keccak256(abi.encodePacked("\x19\x01", _domainSeparator(block.chainid, address(registry)), _structHash(c)))
        );
    }

    function test_register_duplicateReverts() public {
        _register(_conf());
        assertEq(registry.nonces(buyer), 1);

        // same obligation (buyer, buyerRef) with a fresh nonce and a different amount
        IReceivableRegistry.ReceivableConfirmation memory c = _conf(keccak256("PO-1001"), 1);
        c.amount = 20_000_000;
        _expectRegisterRevert(c, IReceivableRegistry.DUPLICATE_RECEIVABLE.selector);

        // duplicate is checked before the signature
        vm.expectRevert(IReceivableRegistry.DUPLICATE_RECEIVABLE.selector);
        registry.register(c, hex"");

        assertEq(registry.nonces(buyer), 1);
        assertEq(registry.get(registry.computeId(buyer, keccak256("PO-1001"))).amount, 10_000_000);
    }

    function test_register_badSig() public {
        IReceivableRegistry.ReceivableConfirmation memory c = _conf();
        bytes32 id = registry.computeId(buyer, c.buyerRef);

        // signed by the seller instead of the buyer
        bytes memory sellerSig = _signConf(sellerPk, c);
        vm.expectRevert(IReceivableRegistry.BAD_BUYER_SIG.selector);
        registry.register(c, sellerSig);

        // buyer signed different terms
        bytes memory sig = _signConf(buyerPk, c);
        c.amount += 1;
        vm.expectRevert(IReceivableRegistry.BAD_BUYER_SIG.selector);
        registry.register(c, sig);
        c.amount -= 1;

        // malformed signatures map to the same error
        vm.expectRevert(IReceivableRegistry.BAD_BUYER_SIG.selector);
        registry.register(c, hex"");
        bytes memory truncated = new bytes(64);
        vm.expectRevert(IReceivableRegistry.BAD_BUYER_SIG.selector);
        registry.register(c, truncated);

        // signature is checked before the payee
        c.payTo = stranger;
        bytes memory wrongKeyWrongPayee = _signConf(sellerPk, c);
        vm.expectRevert(IReceivableRegistry.BAD_BUYER_SIG.selector);
        registry.register(c, wrongKeyWrongPayee);

        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.None));
    }

    function test_register_wrongPayee() public {
        IReceivableRegistry.ReceivableConfirmation memory c = _conf();
        c.payTo = stranger;
        _expectRegisterRevert(c, IReceivableRegistry.WRONG_PAYEE.selector);

        // payee is checked before the term
        c.deadline = uint64(block.timestamp - 1);
        _expectRegisterRevert(c, IReceivableRegistry.WRONG_PAYEE.selector);

        // an unwired registry has no repayment router, so no payTo can match (not even address(0))
        ReceivableRegistry unwired = new ReceivableRegistry(IKYARegistry(address(kya)), USDC, owner);
        IReceivableRegistry.ReceivableConfirmation memory u = _conf();
        bytes memory sigRouter = _sig(buyerPk, unwired.hashConfirmation(u));
        vm.expectRevert(IReceivableRegistry.WRONG_PAYEE.selector);
        unwired.register(u, sigRouter);
        u.payTo = address(0);
        bytes memory sigZero = _sig(buyerPk, unwired.hashConfirmation(u));
        vm.expectRevert(IReceivableRegistry.WRONG_PAYEE.selector);
        unwired.register(u, sigZero);

        // wire is owner-only and one-time; once wired, the router payee is accepted
        u.payTo = router;
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        unwired.wire(facility, router);
        vm.prank(owner);
        unwired.wire(facility, router);
        vm.prank(owner);
        vm.expectRevert(IReceivableRegistry.ALREADY_WIRED.selector);
        unwired.wire(stranger, stranger);
        bytes32 id = unwired.register(u, sigRouter);
        assertEq(uint8(unwired.state(id)), uint8(IReceivableRegistry.State.Confirmed));
    }

    function test_register_deadlinePassed() public {
        IReceivableRegistry.ReceivableConfirmation memory c = _conf();
        c.deadline = uint64(block.timestamp - 1);
        _expectRegisterRevert(c, IReceivableRegistry.TERM_INELIGIBLE.selector);

        // term is checked before the nonce
        c.nonce = 7;
        _expectRegisterRevert(c, IReceivableRegistry.TERM_INELIGIBLE.selector);

        // deadline == now is still valid
        c.nonce = 0;
        c.deadline = uint64(block.timestamp);
        bytes32 id = _register(c);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));
    }

    function test_register_dueDateTooShort() public {
        IReceivableRegistry.ReceivableConfirmation memory c = _conf();
        c.dueDate = uint64(block.timestamp + 1 days - 1);
        _expectRegisterRevert(c, IReceivableRegistry.TERM_INELIGIBLE.selector);

        // already due / in the past is ineligible, not an arithmetic panic
        c.dueDate = uint64(block.timestamp);
        _expectRegisterRevert(c, IReceivableRegistry.TERM_INELIGIBLE.selector);
        c.dueDate = uint64(block.timestamp - 1);
        _expectRegisterRevert(c, IReceivableRegistry.TERM_INELIGIBLE.selector);

        // exactly 1 day is the minimum
        c.dueDate = uint64(block.timestamp + 1 days);
        bytes32 id = _register(c);
        assertEq(registry.get(id).dueDate, uint64(block.timestamp + 1 days));
    }

    function test_register_dueDateTooLong() public {
        IReceivableRegistry.ReceivableConfirmation memory c = _conf();
        c.dueDate = uint64(block.timestamp + 120 days + 1);
        _expectRegisterRevert(c, IReceivableRegistry.TERM_INELIGIBLE.selector);

        // exactly 120 days is the maximum
        c.dueDate = uint64(block.timestamp + 120 days);
        bytes32 id = _register(c);
        assertEq(registry.get(id).dueDate, uint64(block.timestamp + 120 days));
    }

    function test_register_badNonce() public {
        IReceivableRegistry.ReceivableConfirmation memory c = _conf(keccak256("PO-1"), 1);
        _expectRegisterRevert(c, IReceivableRegistry.BAD_NONCE.selector);

        // nonce is checked before the currency
        c.currency = stranger;
        _expectRegisterRevert(c, IReceivableRegistry.BAD_NONCE.selector);

        // a consumed nonce cannot be reused for a different obligation
        _register(_conf(keccak256("PO-1"), 0));
        IReceivableRegistry.ReceivableConfirmation memory replay = _conf(keccak256("PO-2"), 0);
        _expectRegisterRevert(replay, IReceivableRegistry.BAD_NONCE.selector);
        assertEq(registry.nonces(buyer), 1);
    }

    function test_register_badCurrency() public {
        IReceivableRegistry.ReceivableConfirmation memory c = _conf();
        c.currency = makeAddr("otherToken");
        _expectRegisterRevert(c, IReceivableRegistry.BAD_CURRENCY.selector);

        // currency is checked before KYA levels
        vm.prank(issuer);
        kya.setLevel(buyer, 1);
        _expectRegisterRevert(c, IReceivableRegistry.BAD_CURRENCY.selector);
        assertEq(registry.nonces(buyer), 0);
    }

    function test_register_buyerLevelTooLow() public {
        IReceivableRegistry.ReceivableConfirmation memory c = _conf();
        vm.prank(issuer);
        kya.setLevel(buyer, 2);
        _expectRegisterRevert(c, IReceivableRegistry.KYA_FAIL.selector);

        // KYA is checked before owner separation (seller == buyer would be self-dealing)
        IReceivableRegistry.ReceivableConfirmation memory self = _conf();
        self.seller = buyer;
        _expectRegisterRevert(self, IReceivableRegistry.KYA_FAIL.selector);

        // a revoked buyer reads as level 0
        vm.startPrank(issuer);
        kya.setLevel(buyer, 3);
        kya.revoke(buyer);
        vm.stopPrank();
        _expectRegisterRevert(c, IReceivableRegistry.KYA_FAIL.selector);
    }

    function test_register_sellerLevelTooLow() public {
        IReceivableRegistry.ReceivableConfirmation memory c = _conf();
        vm.prank(issuer);
        kya.setLevel(seller, 1);
        _expectRegisterRevert(c, IReceivableRegistry.KYA_FAIL.selector);

        // an unknown seller has level 0
        c.seller = stranger;
        _expectRegisterRevert(c, IReceivableRegistry.KYA_FAIL.selector);

        // level 2 is enough
        vm.prank(issuer);
        kya.setLevel(seller, 2);
        bytes32 id = _register(_conf());
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));
    }

    function test_register_selfDealing() public {
        // a seller agent that belongs to the buyer's owner group
        address captive = makeAddr("captiveSeller");
        _kyaRegister(captive, BUYER_GROUP, 1, 2);
        IReceivableRegistry.ReceivableConfirmation memory c = _conf();
        c.seller = captive;
        _expectRegisterRevert(c, IReceivableRegistry.SELF_DEALING.selector);

        // buyer selling to itself
        c.seller = buyer;
        _expectRegisterRevert(c, IReceivableRegistry.SELF_DEALING.selector);
        assertEq(registry.nonces(buyer), 0);
    }

    // ------------------------------------------------------------------ state machine

    uint8 internal constant OP_FINANCED = 0;
    uint8 internal constant OP_REPAID = 1;
    uint8 internal constant OP_OVERDUE = 2;
    uint8 internal constant OP_DEFAULTED = 3;
    uint8 internal constant OP_CANCEL = 4;

    function _reach(IReceivableRegistry.State s) internal returns (bytes32 id) {
        if (s == IReceivableRegistry.State.None) return keccak256(abi.encode("never-registered", refCounter++));
        id = _registerFresh();
        if (s == IReceivableRegistry.State.Confirmed) return id;
        if (s == IReceivableRegistry.State.Cancelled) {
            (bytes memory sSig, bytes memory bSig) = _cancelSigs(id);
            registry.cancel(id, sSig, bSig);
            return id;
        }
        vm.prank(facility);
        registry.markFinanced(id);
        if (s == IReceivableRegistry.State.Overdue) {
            vm.prank(facility);
            registry.markOverdue(id);
        } else if (s == IReceivableRegistry.State.Defaulted) {
            vm.prank(facility);
            registry.markDefaulted(id);
        } else if (s == IReceivableRegistry.State.Repaid) {
            vm.prank(router);
            registry.markRepaid(id);
        }
        assertEq(uint8(registry.state(id)), uint8(s), "reached state");
    }

    function _edge(IReceivableRegistry.State from, uint8 op) internal pure returns (bool, IReceivableRegistry.State) {
        if (op == OP_FINANCED && from == IReceivableRegistry.State.Confirmed) {
            return (true, IReceivableRegistry.State.Financed);
        }
        if (
            op == OP_REPAID
                && (from == IReceivableRegistry.State.Financed || from == IReceivableRegistry.State.Overdue
                    || from == IReceivableRegistry.State.Defaulted)
        ) return (true, IReceivableRegistry.State.Repaid);
        if (op == OP_OVERDUE && from == IReceivableRegistry.State.Financed) {
            return (true, IReceivableRegistry.State.Overdue);
        }
        if (
            op == OP_DEFAULTED
                && (from == IReceivableRegistry.State.Financed || from == IReceivableRegistry.State.Overdue)
        ) return (true, IReceivableRegistry.State.Defaulted);
        if (op == OP_CANCEL && from == IReceivableRegistry.State.Confirmed) {
            return (true, IReceivableRegistry.State.Cancelled);
        }
        return (false, from);
    }

    /// @dev Only cheatcodes plus the single registry call, so a preceding expectRevert/expectEmit targets it.
    function _apply(uint8 op, bytes32 id, bytes memory sSig, bytes memory bSig) internal {
        if (op == OP_FINANCED) {
            vm.prank(facility);
            registry.markFinanced(id);
        } else if (op == OP_REPAID) {
            vm.prank(router);
            registry.markRepaid(id);
        } else if (op == OP_OVERDUE) {
            vm.prank(facility);
            registry.markOverdue(id);
        } else if (op == OP_DEFAULTED) {
            vm.prank(facility);
            registry.markDefaulted(id);
        } else {
            vm.prank(stranger); // cancel is authorised by signatures, not by caller
            registry.cancel(id, sSig, bSig);
        }
    }

    function test_stateMachine_edges() public {
        // caller authorisation comes before the state check
        bytes32 confirmed = _registerFresh();
        vm.startPrank(stranger);
        vm.expectRevert(IReceivableRegistry.NOT_FACILITY.selector);
        registry.markFinanced(confirmed);
        vm.expectRevert(IReceivableRegistry.NOT_FACILITY.selector);
        registry.markOverdue(confirmed);
        vm.expectRevert(IReceivableRegistry.NOT_FACILITY.selector);
        registry.markDefaulted(confirmed);
        vm.expectRevert(IReceivableRegistry.NOT_ROUTER.selector);
        registry.markRepaid(confirmed);
        vm.stopPrank();
        vm.prank(router);
        vm.expectRevert(IReceivableRegistry.NOT_FACILITY.selector);
        registry.markFinanced(confirmed);
        vm.prank(facility);
        vm.expectRevert(IReceivableRegistry.NOT_ROUTER.selector);
        registry.markRepaid(confirmed);

        uint256 allowed;
        for (uint8 s = 0; s <= uint8(IReceivableRegistry.State.Cancelled); s++) {
            for (uint8 op = 0; op <= OP_CANCEL; op++) {
                IReceivableRegistry.State from = IReceivableRegistry.State(s);
                bytes32 id = _reach(from);
                (bytes memory sSig, bytes memory bSig) = _cancelSigs(id);
                (bool ok, IReceivableRegistry.State to) = _edge(from, op);
                if (ok) {
                    allowed++;
                    vm.expectEmit(true, false, false, true, address(registry));
                    emit IReceivableRegistry.StateChanged(id, from, to);
                    _apply(op, id, sSig, bSig);
                    assertEq(uint8(registry.state(id)), uint8(to), "allowed edge moved state");
                    assertEq(uint8(registry.get(id).state), uint8(to), "get() agrees");
                } else {
                    vm.expectRevert(IReceivableRegistry.BAD_STATE.selector);
                    _apply(op, id, sSig, bSig);
                    assertEq(uint8(registry.state(id)), uint8(from), "rejected edge kept state");
                }
            }
        }
        assertEq(allowed, 8, "exactly the 8 allowed edges");
    }

    function test_cancel_bothSigs_onlyBeforeFinanced() public {
        bytes32 id = _register(_conf());
        (bytes memory sellerSig, bytes memory buyerSig) = _cancelSigs(id);

        // both parties must sign: buyer twice, seller twice, swapped, malformed
        vm.expectRevert(IReceivableRegistry.BAD_BUYER_SIG.selector);
        registry.cancel(id, buyerSig, buyerSig);
        vm.expectRevert(IReceivableRegistry.BAD_BUYER_SIG.selector);
        registry.cancel(id, sellerSig, sellerSig);
        vm.expectRevert(IReceivableRegistry.BAD_BUYER_SIG.selector);
        registry.cancel(id, buyerSig, sellerSig);
        vm.expectRevert(IReceivableRegistry.BAD_BUYER_SIG.selector);
        registry.cancel(id, sellerSig, hex"");
        // signatures over another id do not cancel this one
        (bytes memory otherS, bytes memory otherB) = _cancelSigs(keccak256("other"));
        vm.expectRevert(IReceivableRegistry.BAD_BUYER_SIG.selector);
        registry.cancel(id, otherS, otherB);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Confirmed));

        vm.expectEmit(true, false, false, true, address(registry));
        emit IReceivableRegistry.StateChanged(id, IReceivableRegistry.State.Confirmed, IReceivableRegistry.State.Cancelled);
        vm.prank(orchestrator);
        registry.cancel(id, sellerSig, buyerSig);
        assertEq(uint8(registry.state(id)), uint8(IReceivableRegistry.State.Cancelled));

        // no replay, and a cancelled obligation can never be registered again
        vm.expectRevert(IReceivableRegistry.BAD_STATE.selector);
        registry.cancel(id, sellerSig, buyerSig);
        _expectRegisterRevert(_conf(), IReceivableRegistry.DUPLICATE_RECEIVABLE.selector);

        // once financed, cancellation is impossible even with both signatures
        bytes32 financed = _registerFresh();
        vm.prank(facility);
        registry.markFinanced(financed);
        (bytes memory fs, bytes memory fb) = _cancelSigs(financed);
        vm.expectRevert(IReceivableRegistry.BAD_STATE.selector);
        registry.cancel(financed, fs, fb);
        assertEq(uint8(registry.state(financed)), uint8(IReceivableRegistry.State.Financed));
    }
}
