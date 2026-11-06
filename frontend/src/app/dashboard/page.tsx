import type { Metadata } from "next";
import { Suspense } from "react";
import { DashboardApp } from "@/components/dashboard/DashboardApp";

export const metadata: Metadata = {
  title: "Agent dashboard - CashETH",
  description: "Follow what your seller, buyer or lender agent does through the CashETH MCP server: wallet, credit, invoices and every tool call.",
};

// Public: no session check. The page only reads the MCP read API and the Hedera mirror node.
// Suspense lets the live clock render on the client instead of during prerender (Cache Components).
export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <DashboardApp />
    </Suspense>
  );
}
