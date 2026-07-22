import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/publicClips";

/** Index the public library; keep crawlers out of the (auth-gated anyway) admin + API. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: ["/", "/clips", "/speakers"], disallow: ["/api/", "/dashboard", "/found", "/posts", "/replies", "/figures", "/settings", "/xbot"] },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
