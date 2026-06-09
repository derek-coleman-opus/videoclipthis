import { NextRequest, NextResponse } from "next/server";

// Protect the whole admin with HTTP Basic auth. Cron routes authenticate via CRON_SECRET instead.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export function middleware(req: NextRequest) {
  if (req.nextUrl.pathname.startsWith("/api/cron")) {
    return NextResponse.next();
  }
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return NextResponse.next(); // unconfigured (local dev) → allow

  const header = req.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      if (pass === expected) return NextResponse.next();
    } catch {
      /* fall through to 401 */
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="videoclipthis admin"' },
  });
}
