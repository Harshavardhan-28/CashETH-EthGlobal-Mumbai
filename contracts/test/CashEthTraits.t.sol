// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { TakerTraits, TakerTraitsLib } from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";
import { CashEthTraits } from "../src/core/libs/CashEthTraits.sol";

/// @dev `TakerTraitsLib` accessors read `bytes calldata`, so parsing happens behind an external call.
contract TakerDataReader {
    struct Parsed {
        bool isExactIn;
        bool shouldUnwrapWeth;
        bool isStrictThresholdAmount;
        bool isFirstTransferFromTaker;
        bool useTransferFromAndAquaPush;
        bool isAToB;
        bool allowPartialFill;
        bool usePermit2;
        bool hasPreTransferInCallback;
        bool hasPreTransferOutCallback;
        bool hasThreshold;
        uint256 threshold;
        address to;
        uint40 deadline;
        bytes instructionsArgs;
        bytes signature;
    }

    function read(bytes calldata takerData, address taker) external pure returns (Parsed memory p) {
        (TakerTraits traits, bytes calldata tail) = TakerTraitsLib.parse(takerData);
        p.isExactIn = traits.isExactIn();
        p.shouldUnwrapWeth = traits.shouldUnwrapWeth();
        p.isStrictThresholdAmount = traits.isStrictThresholdAmount();
        p.isFirstTransferFromTaker = traits.isFirstTransferFromTaker();
        p.useTransferFromAndAquaPush = traits.useTransferFromAndAquaPush();
        p.isAToB = traits.isAToB();
        p.allowPartialFill = traits.allowPartialFill();
        p.usePermit2 = traits.usePermit2();
        p.hasPreTransferInCallback = traits.hasPreTransferInCallback();
        p.hasPreTransferOutCallback = traits.hasPreTransferOutCallback();
        (p.hasThreshold, p.threshold) = traits.threshold(tail);
        p.to = traits.to(tail, taker);
        p.deadline = traits.deadline(tail);
        p.instructionsArgs = traits.instructionsArgs(tail);
        p.signature = traits.signature(tail);
    }
}

contract CashEthTraitsTest is Test {
    TakerDataReader internal reader;

    address internal facility = makeAddr("facility");
    address internal low = address(0x1000);
    address internal high = address(0x2000);
    bytes32 internal constant ID = keccak256("receivable-1");
    uint16 internal constant ADVANCE_BPS = 8000;
    uint256 internal constant AMOUNT = 4_000_000;

    function setUp() public {
        reader = new TakerDataReader();
    }

    function test_takerArgs_is34Bytes() public pure {
        bytes memory args = CashEthTraits.takerArgs(ID, ADVANCE_BPS);
        assertEq(args.length, 34);
        // id (32 bytes) then advanceBps big-endian: 8000 = 0x1f40.
        assertEq(args, bytes.concat(ID, hex"1f40"));
    }

    function test_takerData_roundTrip() public view {
        _assertRoundTrip(low, high); // rcn < usdc: A -> B
        _assertRoundTrip(high, low); // rcn > usdc: B -> A
    }

    function _assertRoundTrip(address rcn, address usdc) internal view {
        bytes memory data = CashEthTraits.takerData(facility, rcn, usdc, AMOUNT, ID, ADVANCE_BPS);
        // The router reads `to` with the caller as `taker`; the facility is both.
        TakerDataReader.Parsed memory p = reader.read(data, facility);

        assertTrue(p.isExactIn);
        assertTrue(p.useTransferFromAndAquaPush);
        assertTrue(p.isStrictThresholdAmount);
        assertEq(p.isAToB, rcn < usdc);
        assertFalse(p.shouldUnwrapWeth);
        assertFalse(p.isFirstTransferFromTaker);
        assertFalse(p.allowPartialFill);
        assertFalse(p.usePermit2);
        assertFalse(p.hasPreTransferInCallback);
        assertFalse(p.hasPreTransferOutCallback);
        assertTrue(p.hasThreshold);
        assertEq(p.threshold, AMOUNT);
        assertEq(p.to, facility);
        assertEq(p.deadline, 0);
        assertEq(p.instructionsArgs, CashEthTraits.takerArgs(ID, ADVANCE_BPS));
        assertEq(p.signature.length, 0);
        // 22-byte header + 32-byte threshold + 34-byte instructions args (to == taker is not encoded).
        assertEq(data.length, 22 + 32 + 34);
    }
}
