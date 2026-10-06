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
  if (!expected) {
    // FAIL CLOSED in production. This used to allow the request unconditionally, so a deployment
    // that simply forgot ADMIN_PASSWORD served the whole admin surface — dashboard, Settings, the
    // review queues, /api/admin/*, and the debug routes that print raw API responses — to anyone
    // who guessed the path, with nothing anywhere to indicate it. An unset password is a
    // misconfiguration, and the safe reading of a misconfiguration is "closed", not "open".
    // 503, not 401: no password exists, so no credential could ever satisfy a challenge.
    if (process.env.NODE_ENV === "production") {
      return new NextResponse(
        "Admin is locked: ADMIN_PASSWORD is not set on this deployment. Set it in the environment "
        + "and redeploy.",
        { status: 503 },
      );
    }
    return NextResponse.next(); // local dev → allow
  }

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
