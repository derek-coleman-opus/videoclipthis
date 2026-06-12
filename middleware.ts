import { NextRequest, NextResponse } from "next/server";

// Public landing + showcase lives at "/"; everything else (admin pages, APIs) is behind
// HTTP Basic auth. Cron routes authenticate via CRON_SECRET inside their handlers.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

/** Paths anyone may load without a password. Keep this list tight: the public surface
 *  of an open-source deployment is the landing page and nothing else. */
function isPublic(pathname: string): boolean {
  return pathname === "/";
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();
  if (pathname.startsWith("/api/cron")) {
    return NextResponse.next(); // authenticated by CRON_SECRET in the route handlers
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
