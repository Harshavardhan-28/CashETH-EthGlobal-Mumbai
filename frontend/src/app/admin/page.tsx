import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import type { ReactNode } from "react";
import { SESSION_COOKIE, isValidSession } from "@/lib/admin/session";
import { SignOutButton } from "@/components/admin/SignOutButton";

export const metadata: Metadata = {
  title: "Admin console - CashETH",
  robots: { index: false, follow: false },
};

/**
 * Verifies the session cookie at request time (behind Suspense, as Cache Components
 * requires). The proxy already redirects signed-out visitors; this is the real check.
 */
async function AdminGate({ children }: { children: ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!isValidSession(token)) redirect("/admin/login");
  return <>{children}</>;
}

// Placeholder body: replaced by <AdminApp /> in a later task.
function AdminBody() {
  return (
    <main style={{ padding: 32 }}>
      <h1>Admin console</h1>
      <SignOutButton />
    </main>
  );
}

export default function AdminPage() {
  return (
    <Suspense fallback={null}>
      <AdminGate>
        <AdminBody />
      </AdminGate>
    </Suspense>
  );
}
