// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title RiskPricing
/// @notice The credit score of a seller and the APR it pays, computed from on-chain data only, so no lender, solver or
///         server can charge a different rate. Mirrors `packages/engine/src/pricing.ts`; both are tested against the
///         same table.
/// @dev Score: 600, +15 per on-time repayment (at most 10), -40 per late one, -200 per default, -50 when the tenor
///      is over 60 days. Slabs: low risk 700 and up, medium 600-699, high 500-599; below 500 is not financeable.
///      APR is piecewise linear through (750, 6%), (700, 8%), (600, 11%), (500, 14%), so a slightly better score always
///      pays slightly less, with no jump at a slab boundary.
library RiskPricing {
    enum Slab {
        None,
        Low,
        Medium,
        High
    }

    int256 internal constant BASE_SCORE = 600;
    int256 internal constant ON_TIME_POINTS = 15;
    uint256 internal constant ON_TIME_CAP = 10;
    int256 internal constant LATE_PENALTY = 40;
    int256 internal constant DEFAULT_PENALTY = 200;
    int256 internal constant LONG_TENOR_PENALTY = 50;
    uint256 internal constant LONG_TENOR = 60 days;

    int256 internal constant BEST_SCORE = 750;
    int256 internal constant LOW_RISK_FROM = 700;
    int256 internal constant MEDIUM_RISK_FROM = 600;
    int256 internal constant MIN_SCORE = 500;

    uint16 internal constant APR_AT_BEST = 600;
    uint16 internal constant APR_AT_LOW_RISK = 800;
    uint16 internal constant APR_AT_MEDIUM_RISK = 1100;
    uint16 internal constant APR_AT_MIN = 1400;

    error NotFinanceable(int256 score);

    function score(uint32 onTime, uint32 late, uint32 defaults, uint256 tenor) internal pure returns (int256 s) {
        uint256 counted = onTime < ON_TIME_CAP ? onTime : ON_TIME_CAP;
        s = BASE_SCORE + ON_TIME_POINTS * int256(counted) - LATE_PENALTY * int256(uint256(late))
            - DEFAULT_PENALTY * int256(uint256(defaults));
        if (tenor > LONG_TENOR) s -= LONG_TENOR_PENALTY;
    }

    function slabOf(int256 s) internal pure returns (Slab) {
        if (s >= LOW_RISK_FROM) return Slab.Low;
        if (s >= MEDIUM_RISK_FROM) return Slab.Medium;
        if (s >= MIN_SCORE) return Slab.High;
        return Slab.None;
    }

    /// @return The APR in basis points for a financeable score (500 and up), floored.
    function aprBps(int256 s) internal pure returns (uint16) {
        if (s < MIN_SCORE) revert NotFinanceable(s);
        if (s >= BEST_SCORE) return APR_AT_BEST;
        if (s >= LOW_RISK_FROM) return _between(s, LOW_RISK_FROM, BEST_SCORE, APR_AT_LOW_RISK, APR_AT_BEST);
        if (s >= MEDIUM_RISK_FROM) return _between(s, MEDIUM_RISK_FROM, LOW_RISK_FROM, APR_AT_MEDIUM_RISK, APR_AT_LOW_RISK);
        return _between(s, MIN_SCORE, MEDIUM_RISK_FROM, APR_AT_MIN, APR_AT_MEDIUM_RISK);
    }

    /// @dev The rate at `s` on the line from (`from`, `aprFrom`) down to (`to`, `aprTo`), with `aprTo < aprFrom`.
    function _between(int256 s, int256 from, int256 to, uint16 aprFrom, uint16 aprTo) private pure returns (uint16) {
        uint256 drop = uint256(aprFrom - aprTo) * uint256(s - from) / uint256(to - from);
        return uint16(aprFrom - drop);
    }
}
