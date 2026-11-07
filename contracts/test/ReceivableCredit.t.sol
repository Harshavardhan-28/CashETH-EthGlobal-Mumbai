// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { AquaRouter } from "@1inch/aqua/contracts/AquaRouter.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";
import { Salt } from "@1inch/swap-vm/contracts/instructions/Controls.sol";

import { KYARegistry } from "../src/core/KYARegistry.sol";
import { IKYARegistry } from "../src/core/interfaces/IKYARegistry.sol";
import { ReceivableRegistry } from "../src/core/ReceivableRegistry.sol";
import { IReceivableRegistry } from "../src/core/interfaces/IReceivableRegistry.sol";
import { ReceivableCreditNote } from "../src/core/ReceivableCreditNote.sol";
import { CashEthTraits } from "../src/core/libs/CashEthTraits.sol";
import { ReceivableCredit } from "../src/aqua/ReceivableCredit.sol";
import { RiskPricing } from "../src/core/libs/RiskPricing.sol";
import { CashEthSwapVMRouter } from "../src/aqua/CashEthSwapVMRouter.sol";
import { MockUSDC } from "./mocks/MockUSDC.sol";

/// @notice Stands in for the CreditFacility: the only allowed taker, holds RCN, records `onCreditFill`.
contract MockFacilityTaker {
    struct CreditFill {
        address caller;
        bytes32 id;
        address maker;
        uint256 usdcIn;
        uint16 aprBps;
    }

    ReceivableCreditNote public immutable RCN;
    ISwapVM public router;
    CreditFill[] internal _fills;

    constructor(ReceivableCreditNote rcn) {
        RCN = rcn;
    }

    function setRouter(ISwapVM router_) external {
        router = router_;
    }

    function onCreditFill(bytes32 id, address maker, uint256 usdcIn, uint16 aprBps) external {
        _fills.push(CreditFill({ caller: msg.sender, id: id, maker: maker, usdcIn: usdcIn, aprBps: aprBps }));
    }

    function fill(ISwapVM.Order calldata order, uint256 amount, bytes calldata takerData)
        external
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
    {
        RCN.approve(address(router), amount);
        return router.swap(order, amount, takerData);
    }

    /// @dev `ISwapVM.quote` is declared view, so this goes through a STATICCALL: any write would revert.
    function quote(ISwapVM.Order calldata order, uint256 amount, bytes calldata takerData)
        external
        view
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
    {
        return router.quote(order, amount, takerData);
    }

    function fillCount() external view returns (uint256) {
        return _fills.length;
    }

    function fills(uint256 i) external view returns (CreditFill memory) {
        return _fills[i];
    }
}

contract ReceivableCreditTest is Test {
    address internal constant WETH = 0xb1F616b8134F602c3Bb465fB5b5e6565cCAd37Ed;
    bytes32 internal constant SELLER_GROUP = keccak256("seller-co");
    bytes32 internal constant BUYER_GROUP = keccak256("buyer-co");

    uint256 internal constant FACE = 10_000_000; // 10 USDC receivable
    uint16 internal constant ADVANCE_BPS = 9000;
    uint256 internal constant FILL = 9_000_000; // 90% advance
    uint256 internal constant MAKER_WALLET = 1_000_000_000; // 1,000 USDC in the lender's wallet
    uint256 internal constant SHIP = 100_000_000; // 100 USDC shipped to the strategy
    uint16 internal constant NEW_SELLER_APR = 1100; // score 600: no history, 30-day tenor
    uint8 internal constant LOW = 1;
    uint8 internal constant MEDIUM = 2;
    uint8 internal constant HIGH = 4;

    AquaRouter internal aqua;
    KYARegistry internal kya;
    ReceivableRegistry internal registry;
    ReceivableCreditNote internal rcn;
    MockUSDC internal usdc;
    MockFacilityTaker internal facility;
    CashEthSwapVMRouter internal router;

    uint256 internal buyerPk = 0xB0B;
    uint256 internal sellerPk = 0x5E11E4;
    address internal buyer;
    address internal seller;
    address internal issuer = makeAddr("issuer");
    address internal owner = makeAddr("owner");
    address internal maker = makeAddr("lender");
    address internal stranger = makeAddr("stranger");

    bytes32 internal id;
    uint64 internal saltCounter;

    function setUp() public {
        vm.warp(1_750_000_000);
        buyer = vm.addr(buyerPk);
        seller = vm.addr(sellerPk);

        aqua = new AquaRouter(owner);
        usdc = new MockUSDC();

        kya = new KYARegistry(issuer, owner);
        _kyaRegister(seller, SELLER_GROUP, 1, 2);
        _kyaRegister(buyer, BUYER_GROUP, 2, 3);

        registry = new ReceivableRegistry(IKYARegistry(address(kya)), address(usdc), owner);
        rcn = new ReceivableCreditNote(owner);
        facility = new MockFacilityTaker(rcn);
        router = new CashEthSwapVMRouter(
            address(aqua), WETH, owner, "CashETH SwapVM", "1.0.0", address(registry), address(kya), address(facility)
        );
        facility.setRouter(ISwapVM(address(router)));

        vm.startPrank(owner);
        // This test contract plays the repayment router (registry payTo, KYA reputation writer, RCN burner).
        registry.wire(address(facility), address(this));
        kya.wire(address(this), address(facility));
        rcn.wire(address(facility), address(this), address(router), address(aqua));
        vm.stopPrank();

        id = _registerReceivable(keccak256("PO-1001"));

        usdc.mint(maker, MAKER_WALLET);
        vm.prank(maker);
        usdc.approve(address(aqua), type(uint256).max);

        vm.prank(address(facility));
        rcn.mint(address(facility), 100 * FACE);
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

    function _registerReceivable(bytes32 buyerRef) internal returns (bytes32) {
        IReceivableRegistry.ReceivableConfirmation memory c = IReceivableRegistry.ReceivableConfirmation({
            seller: seller,
            buyer: buyer,
            currency: address(usdc),
            amount: FACE,
            dueDate: uint64(block.timestamp + 30 days),
            buyerRef: buyerRef,
            detailsCommitment: keccak256("doc"),
            payTo: address(this),
            nonce: registry.nonces(buyer),
            deadline: uint64(block.timestamp + 1 hours)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, registry.hashConfirmation(c));
        return registry.register(c, abi.encodePacked(r, s, v));
    }

    function _args() internal pure returns (ReceivableCredit.Args memory a) {
        a = ReceivableCredit.Args({
            maxTenorDays: 60,
            maxAdvanceBps: 9000,
            maxPerBuyer: 50_000_000,
            slabMask: LOW | MEDIUM | HIGH,
            minReserve: 0,
            sellerSet: new address[](0)
        });
    }

    function _ship(ReceivableCredit.Args memory a) internal returns (ISwapVM.Order memory) {
        return _ship(a, SHIP);
    }

    function _ship(ReceivableCredit.Args memory a, uint256 usdcAmount) internal returns (ISwapVM.Order memory order) {
        (address tokenA, address tokenB) =
            address(usdc) < address(rcn) ? (address(usdc), address(rcn)) : (address(rcn), address(usdc));
        order = MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                tokenA: tokenA,
                tokenB: tokenB,
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                usePermit2: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: bytes.concat(Salt.build(++saltCounter), ReceivableCredit.build(a))
            })
        );
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = (address(usdc), address(rcn));
        uint256[] memory amounts = new uint256[](2);
        (amounts[0], amounts[1]) = (usdcAmount, 0);
        vm.prank(maker);
        aqua.ship(address(router), abi.encode(order), tokens, amounts);
    }

    /// @dev Exactly the taker data the facility sends (exact-in RCN -> USDC, strict threshold).
    function _takerData(uint256 amount) internal view returns (bytes memory) {
        return CashEthTraits.takerData(address(facility), address(rcn), address(usdc), amount, id, ADVANCE_BPS);
    }

    function _takerDataExactOut(uint256 amount) internal view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(facility),
                isExactIn: false,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: true,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: address(rcn) < address(usdc),
                allowPartialFill: false,
                usePermit2: false,
                threshold: abi.encode(amount),
                to: address(facility),
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: CashEthTraits.takerArgs(id, ADVANCE_BPS),
                signature: ""
            })
        );
    }

    function _takerDataWithArgs(uint256 amount, bytes memory instructionsArgs) internal view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(facility),
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: true,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: address(rcn) < address(usdc),
                allowPartialFill: false,
                usePermit2: false,
                threshold: abi.encode(amount),
                to: address(facility),
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: instructionsArgs,
                signature: ""
            })
        );
    }

    function _sellerSet(address a) internal pure returns (address[] memory set) {
        set = new address[](1);
        set[0] = a;
    }

    // External wrappers so calldata-only parse and revert expectations work.
    function buildExt(ReceivableCredit.Args memory a) external pure returns (bytes memory) {
        return ReceivableCredit.build(a);
    }

    function parseExt(bytes calldata args) external pure returns (ReceivableCredit.Args memory) {
        return ReceivableCredit.parse(args);
    }

    function _assertArgsEq(ReceivableCredit.Args memory x, ReceivableCredit.Args memory y) internal pure {
        assertEq(x.maxTenorDays, y.maxTenorDays, "maxTenorDays");
        assertEq(x.maxAdvanceBps, y.maxAdvanceBps, "maxAdvanceBps");
        assertEq(x.maxPerBuyer, y.maxPerBuyer, "maxPerBuyer");
        assertEq(x.slabMask, y.slabMask, "slabMask");
        assertEq(x.minReserve, y.minReserve, "minReserve");
        assertEq(x.sellerSet.length, y.sellerSet.length, "sellerSet.length");
        for (uint256 i; i < x.sellerSet.length; i++) {
            assertEq(x.sellerSet[i], y.sellerSet[i], "sellerSet[i]");
        }
    }

    // ------------------------------------------------------------------ encoding

    function test_build_parse_roundTrip() public view {
        ReceivableCredit.Args memory a = ReceivableCredit.Args({
            maxTenorDays: 0xA1B2,
            maxAdvanceBps: 0xC3D4,
            maxPerBuyer: type(uint128).max - 7,
            slabMask: MEDIUM | HIGH,
            minReserve: 0x0102030405060708090A0B0C0D0E0F10,
            sellerSet: new address[](3)
        });
        a.sellerSet[0] = address(0x1111111111111111111111111111111111111111);
        a.sellerSet[1] = seller;
        a.sellerSet[2] = address(type(uint160).max);

        bytes memory built = this.buildExt(a);
        assertEq(built.length, ReceivableCredit.sizeOf(3), "size");
        assertEq(built.length, 2 + 37 + 60, "2 header + 37 fixed + 3 x 20");
        assertEq(uint8(built[0]), 0x21, "opcode byte");
        assertEq(uint8(built[1]), 37 + 60, "args length byte");

        bytes memory args = this.slice(built, 2, built.length);
        assertEq(
            args,
            abi.encodePacked(
                a.maxTenorDays,
                a.maxAdvanceBps,
                a.maxPerBuyer,
                a.slabMask,
                a.minReserve,
                a.sellerSet[0],
                a.sellerSet[1],
                a.sellerSet[2]
            ),
            "packed layout"
        );
        _assertArgsEq(this.parseExt(args), a);

        // Empty seller set: 37-byte fixed part only.
        ReceivableCredit.Args memory b = _args();
        bytes memory builtB = this.buildExt(b);
        assertEq(builtB.length, ReceivableCredit.sizeOf(0));
        assertEq(uint8(builtB[1]), 37);
        _assertArgsEq(this.parseExt(this.slice(builtB, 2, builtB.length)), b);
    }

    function test_build_revertsMoreThanThreeSellers() public {
        ReceivableCredit.Args memory a = _args();
        a.sellerSet = new address[](4);
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.TooManySellers.selector, 4));
        this.buildExt(a);
    }

    function test_parse_revertsMalformedLength() public {
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.InvalidArgsLength.selector, 36));
        this.parseExt(new bytes(36));
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.InvalidArgsLength.selector, 38));
        this.parseExt(new bytes(38));
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.InvalidArgsLength.selector, 37 + 80));
        this.parseExt(new bytes(37 + 80));
    }

    function test_build_and_parse_revertInvalidSlabMask() public {
        ReceivableCredit.Args memory a = _args();
        a.slabMask = 0;
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.InvalidSlabMask.selector, 0));
        this.buildExt(a);
        a.slabMask = 8;
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.InvalidSlabMask.selector, 8));
        this.buildExt(a);
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.InvalidSlabMask.selector, 0));
        this.parseExt(new bytes(37)); // all zero: mask 0
    }

    function test_storageSlot() public pure {
        bytes32 slot;
        ReceivableCredit.Storage storage s = ReceivableCredit.store();
        assembly ("memory-safe") {
            slot := s.slot
        }
        assertEq(slot, keccak256("casheth.ReceivableCredit.v1"));
    }

    // ------------------------------------------------------------------ gate checks

    function test_exec_revertsForeignTaker() public {
        ISwapVM.Order memory order = _ship(_args());
        bytes memory td = _takerData(FILL);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.NotFacilityTaker.selector, stranger));
        router.swap(order, FILL, td);
    }

    function test_exec_revertsShortTakerArgs() public {
        ISwapVM.Order memory order = _ship(_args());
        bytes memory td = _takerDataWithArgs(FILL, abi.encodePacked(id, uint8(0x23)));
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.TakerArgsTooShort.selector, 33));
        facility.fill(order, FILL, td);
    }

    function test_exec_revertsNotConfirmed() public {
        ISwapVM.Order memory order = _ship(_args());
        vm.prank(address(facility));
        registry.markFinanced(id);
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.ReceivableNotConfirmed.selector, id));
        facility.fill(order, FILL, _takerData(FILL));

        // An unknown id is not Confirmed either.
        bytes32 unknown = keccak256("nope");
        bytes memory td = _takerDataWithArgs(FILL, CashEthTraits.takerArgs(unknown, ADVANCE_BPS));
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.ReceivableNotConfirmed.selector, unknown));
        facility.fill(order, FILL, td);
    }

    function test_exec_revertsSellerNotInSet() public {
        ReceivableCredit.Args memory a = _args();
        a.sellerSet = _sellerSet(makeAddr("otherSeller"));
        ISwapVM.Order memory order = _ship(a);
        vm.expectRevert(ReceivableCredit.SELLER_NOT_FUNDED_BY_LENDER.selector);
        facility.fill(order, FILL, _takerData(FILL));
    }

    function test_exec_sellerSetNarrows_butTheSlabStillApplies() public {
        ReceivableCredit.Args memory a = _args();
        a.sellerSet = new address[](3);
        (a.sellerSet[0], a.sellerSet[1], a.sellerSet[2]) = (makeAddr("s0"), seller, makeAddr("s2"));
        ISwapVM.Order memory listed = _ship(a);
        (uint256 amountIn, uint256 amountOut,) = facility.fill(listed, FILL, _takerData(FILL));
        assertEq(amountIn, FILL);
        assertEq(amountOut, FILL);

        // Listed but in a slab the lender does not fund (a new seller scores 600: medium risk).
        a.slabMask = LOW;
        ISwapVM.Order memory lowOnly = _ship(a);
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.SlabNotFunded.selector, RiskPricing.Slab.Medium, LOW));
        facility.fill(lowOnly, FILL, _takerData(FILL));
    }

    function test_exec_fillsOnlyTheSlabsTheLenderFunds() public {
        ReceivableCredit.Args memory a = _args();
        a.slabMask = LOW;
        ISwapVM.Order memory order = _ship(a);

        // Score 600 + 15 x 6 = 690: still medium risk.
        for (uint256 i; i < 6; i++) kya.recordRepayment(makeAddr("someBuyer"), seller, true);
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.SlabNotFunded.selector, RiskPricing.Slab.Medium, LOW));
        facility.fill(order, FILL, _takerData(FILL));

        // One more on-time repayment: 705, low risk, fills at 8% - 4 bps x 5 = 7.80%.
        kya.recordRepayment(makeAddr("someBuyer"), seller, true);
        facility.fill(order, FILL, _takerData(FILL));
        assertEq(facility.fills(0).aprBps, 780);
    }

    function test_exec_revertsTenor() public {
        // The receivable is due in exactly 30 days.
        ReceivableCredit.Args memory a = _args();
        a.maxTenorDays = 30;
        ISwapVM.Order memory atLimit = _ship(a);
        a.maxTenorDays = 29;
        ISwapVM.Order memory tooShort = _ship(a);

        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.TenorTooLong.selector, 30, 29));
        facility.fill(tooShort, FILL, _takerData(FILL));

        (, uint256 amountOut,) = facility.fill(atLimit, FILL, _takerData(FILL));
        assertEq(amountOut, FILL);

        // Remaining tenor is reported in whole days rounded up: 29 days + 1s -> 30.
        vm.warp(block.timestamp + 1 days - 1);
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.TenorTooLong.selector, 30, 29));
        facility.fill(tooShort, FILL, _takerData(FILL));

        // Once the remaining tenor is 29 days, the tighter order fills too.
        vm.warp(block.timestamp + 1);
        (, amountOut,) = facility.fill(tooShort, FILL, _takerData(FILL));
        assertEq(amountOut, FILL);
    }

    function test_exec_revertsPastDue() public {
        ISwapVM.Order memory order = _ship(_args());
        IReceivableRegistry.Receivable memory r = registry.get(id);
        vm.warp(r.dueDate);
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.ReceivablePastDue.selector, id, r.dueDate));
        facility.fill(order, FILL, _takerData(FILL));
    }

    function test_exec_revertsAdvance() public {
        ReceivableCredit.Args memory a = _args();
        a.maxAdvanceBps = ADVANCE_BPS - 1;
        ISwapVM.Order memory order = _ship(a);
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.AdvanceTooHigh.selector, ADVANCE_BPS, ADVANCE_BPS - 1));
        facility.fill(order, FILL, _takerData(FILL));
    }

    function test_exec_revertsNotFinanceable() public {
        ISwapVM.Order memory order = _ship(_args());
        kya.recordRepayment(makeAddr("someBuyer"), seller, false); // late: 560, still financeable
        kya.recordRepayment(makeAddr("someBuyer"), seller, false); // late: 520
        facility.fill(order, FILL, _takerData(FILL));
        assertEq(facility.fills(0).aprBps, 1340, "high risk, 13.4%");

        vm.prank(address(facility));
        kya.recordDefault(makeAddr("someBuyer"), seller); // -200: 320, below 500
        vm.expectRevert(abi.encodeWithSelector(RiskPricing.NotFinanceable.selector, int256(320)));
        facility.fill(order, FILL, _takerData(FILL));
    }

    function test_exec_pricesFromTheSellersRecord_notTheBuyers() public {
        ISwapVM.Order memory order = _ship(_args());
        // A buyer with a long on-time record does not change the seller's price.
        for (uint256 i; i < 10; i++) kya.recordRepayment(buyer, makeAddr("someSeller"), true);
        // Two on-time repayments as a seller: 630, 11% - 3 bps x 30 = 10.10%.
        kya.recordRepayment(makeAddr("someBuyer"), seller, true);
        kya.recordRepayment(makeAddr("someBuyer"), seller, true);
        facility.fill(order, FILL, _takerData(FILL));
        assertEq(facility.fills(0).aprBps, 1010);
    }

    function test_exec_revertsWrongTokenOut() public {
        // Direction USDC -> RCN: tokenOut is RCN, not the receivable's currency.
        ISwapVM.Order memory order = _ship(_args());
        bytes memory td = TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(facility),
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: address(usdc) < address(rcn),
                allowPartialFill: false,
                usePermit2: false,
                threshold: "",
                to: address(facility),
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: CashEthTraits.takerArgs(id, ADVANCE_BPS),
                signature: ""
            })
        );
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.WrongTokenOut.selector, address(rcn)));
        facility.quote(order, FILL, td);
    }

    // ------------------------------------------------------------------ pricing and limits

    function test_exec_pricesOneToOne_exactIn() public {
        ISwapVM.Order memory order = _ship(_args());
        (uint256 qIn, uint256 qOut,) = facility.quote(order, FILL, _takerData(FILL));
        assertEq(qIn, FILL);
        assertEq(qOut, FILL);

        (uint256 amountIn, uint256 amountOut,) = facility.fill(order, FILL, _takerData(FILL));
        assertEq(amountIn, FILL);
        assertEq(amountOut, FILL);
        assertEq(usdc.balanceOf(address(facility)), FILL);
        assertEq(rcn.balanceOf(maker), FILL);
    }

    function test_exec_pricesOneToOne_exactOut() public {
        ISwapVM.Order memory order = _ship(_args());
        (uint256 qIn, uint256 qOut,) = facility.quote(order, FILL, _takerDataExactOut(FILL));
        assertEq(qIn, FILL);
        assertEq(qOut, FILL);

        (uint256 amountIn, uint256 amountOut,) = facility.fill(order, FILL, _takerDataExactOut(FILL));
        assertEq(amountIn, FILL);
        assertEq(amountOut, FILL);
        assertEq(usdc.balanceOf(address(facility)), FILL);
        assertEq(rcn.balanceOf(maker), FILL);
        assertEq(router.exposure(maker, buyer), FILL);
        assertEq(facility.fills(0).usdcIn, FILL);
    }

    function test_exec_revertsInsufficientLiquidity() public {
        ISwapVM.Order memory order = _ship(_args(), FILL - 1);
        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.InsufficientLiquidity.selector, FILL, FILL - 1));
        facility.fill(order, FILL, _takerData(FILL));
    }

    function test_exec_exposureAccumulatesAcrossFills_andCaps() public {
        ReceivableCredit.Args memory a = _args();
        // forge-lint: disable-next-line(unsafe-typecast)
        a.maxPerBuyer = uint128(2 * FILL + 1);
        ISwapVM.Order memory order = _ship(a);
        // A second strategy from the same lender shares the per-buyer exposure.
        ISwapVM.Order memory other = _ship(a);

        facility.fill(order, FILL, _takerData(FILL));
        assertEq(router.exposure(maker, buyer), FILL);
        facility.fill(other, FILL, _takerData(FILL));
        assertEq(router.exposure(maker, buyer), 2 * FILL);

        vm.expectRevert(abi.encodeWithSelector(ReceivableCredit.BuyerExposureExceeded.selector, 2 * FILL + 2, a.maxPerBuyer));
        facility.fill(order, 2, _takerData(2));

        // Exactly up to the cap still fills.
        facility.fill(order, 1, _takerData(1));
        assertEq(router.exposure(maker, buyer), 2 * FILL + 1);
        assertEq(router.exposure(stranger, buyer), 0, "exposure is per maker");
        assertEq(facility.fillCount(), 3);
    }

    function test_exec_revertsReserveTooLow() public {
        ReceivableCredit.Args memory a = _args();
        // forge-lint: disable-next-line(unsafe-typecast)
        a.minReserve = uint128(MAKER_WALLET - FILL + 1);
        ISwapVM.Order memory order = _ship(a);
        vm.expectRevert(ReceivableCredit.LENDER_RESERVE_TOO_LOW.selector);
        facility.fill(order, FILL, _takerData(FILL));

        // A wallet holding less than the fill amount reverts with the same error, not an underflow.
        a.minReserve = 0;
        ISwapVM.Order memory noReserve = _ship(a);
        vm.prank(maker);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        usdc.transfer(stranger, MAKER_WALLET - FILL + 1);
        vm.expectRevert(ReceivableCredit.LENDER_RESERVE_TOO_LOW.selector);
        facility.fill(noReserve, FILL, _takerData(FILL));

        // Exactly at the reserve: allowed.
        vm.prank(stranger);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        usdc.transfer(maker, MAKER_WALLET - FILL + 1);
        // forge-lint: disable-next-line(unsafe-typecast)
        a.minReserve = uint128(MAKER_WALLET - FILL);
        ISwapVM.Order memory atReserve = _ship(a);
        facility.fill(atReserve, FILL, _takerData(FILL));
        assertEq(usdc.balanceOf(maker), MAKER_WALLET - FILL);
    }

    // ------------------------------------------------------------------ quote and full fill

    function test_quote_doesNotCallFacility_orMutate() public {
        ISwapVM.Order memory order = _ship(_args());
        bytes32 orderHash = router.hash(order);

        (uint256 amountIn, uint256 amountOut, bytes32 qHash) = facility.quote(order, FILL, _takerData(FILL));

        assertEq(amountIn, FILL);
        assertEq(amountOut, FILL);
        assertEq(qHash, orderHash);
        assertEq(facility.fillCount(), 0, "no onCreditFill");
        assertEq(router.exposure(maker, buyer), 0, "exposure unchanged");
        assertEq(usdc.balanceOf(maker), MAKER_WALLET);
        assertEq(rcn.balanceOf(maker), 0);
        (uint256 balUsdc, uint256 balRcn) =
            aqua.safeBalances(maker, address(router), orderHash, address(usdc), address(rcn));
        assertEq(balUsdc, SHIP);
        assertEq(balRcn, 0);
    }

    function test_fullAquaFill_movesUsdcToTakerAndRcnToMaker() public {
        ISwapVM.Order memory order = _ship(_args());
        bytes32 orderHash = router.hash(order);
        uint256 facilityRcnBefore = rcn.balanceOf(address(facility));

        (uint256 amountIn, uint256 amountOut, bytes32 fHash) = facility.fill(order, FILL, _takerData(FILL));

        assertEq(amountIn, FILL);
        assertEq(amountOut, FILL);
        assertEq(fHash, orderHash);

        // USDC: maker -> taker (facility).
        assertEq(usdc.balanceOf(address(facility)), FILL, "taker +amount");
        assertEq(usdc.balanceOf(maker), MAKER_WALLET - FILL, "maker -amount");
        // RCN: taker -> router -> maker (Aqua push).
        assertEq(rcn.balanceOf(maker), FILL, "maker RCN +amount");
        assertEq(rcn.balanceOf(address(facility)), facilityRcnBefore - FILL);
        assertEq(rcn.balanceOf(address(router)), 0);
        assertEq(rcn.allowance(address(facility), address(router)), 0);

        // Aqua virtual balances follow the fill.
        (uint256 balUsdc, uint256 balRcn) =
            aqua.safeBalances(maker, address(router), orderHash, address(usdc), address(rcn));
        assertEq(balUsdc, SHIP - FILL);
        assertEq(balRcn, FILL);

        // Callback and exposure.
        assertEq(facility.fillCount(), 1);
        MockFacilityTaker.CreditFill memory f = facility.fills(0);
        assertEq(f.caller, address(router));
        assertEq(f.id, id);
        assertEq(f.maker, maker);
        assertEq(f.usdcIn, FILL);
        assertEq(f.aprBps, NEW_SELLER_APR, "the seller's price, not the lender's");
        assertEq(router.exposure(maker, buyer), FILL);
    }

    function slice(bytes calldata data, uint256 from, uint256 to) external pure returns (bytes memory) {
        return data[from:to];
    }
}
