import { NextRequest, NextResponse } from "next/server";

// Public landing + showcase lives at "/"; everything else (admin pages, APIs) is behind
// HTTP Basic auth. Cron routes authenticate via CRON_SECRET inside their handlers.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

/** Paths anyone may load without a password. Keep this list tight: the public surface is
 *  the landing page + the SEO clip library (posted clips only) + crawler plumbing. */
function isPublic(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/clips" || pathname.startsWith("/clips/") ||
    pathname.startsWith("/speakers/") ||
    pathname === "/sitemap.xml" || pathname === "/robots.txt"
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();
  if (pathname.startsWith("/api/cron")) {
    return NextResponse.next(); // authenticated by CRON_SECRET in the route handlers
  }
  // Read-only health, authenticated by HEALTH_TOKEN inside the handler (and disabled entirely when
  // that is unset). Kept out of basic auth so an external monitor can watch the pipeline without
  // holding admin credentials — it exposes state, never control and never secrets.
  if (pathname === "/api/health") {
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
