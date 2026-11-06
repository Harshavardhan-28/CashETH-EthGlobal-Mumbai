/** Facility state shown in the live console after `shown` audit events have played. */
export function facilityState(shown: number) {
  if (shown === 0) return "—";
  if (shown < 4) return "Pending";
  if (shown < 7) return "Confirmed";
  if (shown < 10) return "Financed";
  return "Repaid";
}

export function consoleStats(shown: number) {
  return {
    base: shown >= 3 ? "$7,500.00" : "—",
    funded: shown >= 7 ? "$6,000.00" : "$0.00",
    owed: shown >= 10 ? "$0.00" : shown >= 7 ? "$6,036.99" : "$0.00",
  };
}
