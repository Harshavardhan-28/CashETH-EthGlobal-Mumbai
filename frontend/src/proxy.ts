import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, isValidSession } from "@/lib/admin/session";

// Optimistic redirect only: it keeps signed-out visitors off /admin and signed-in
// ones off the login page. The /admin page re-verifies the cookie itself.
export function proxy(request: NextRequest) {
  const signedIn = isValidSession(request.cookies.get(SESSION_COOKIE)?.value);
  const onLogin = request.nextUrl.pathname.startsWith("/admin/login");

  if (!signedIn && !onLogin) {
    return NextResponse.redirect(new URL("/admin/login", request.url));
  }
  if (signedIn && onLogin) {
    return NextResponse.redirect(new URL("/admin", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
