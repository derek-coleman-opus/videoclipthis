import "./globals.css";
import type { ReactNode } from "react";

import type { Metadata } from "next";

const TITLE = "videoclipthis — the open-source AI clip agent";
const DESCRIPTION =
  "An autonomous agent that finds the best moments in long videos, clips them with AI, and posts them — point it at any niche.";

// Social-preview metadata so links shared on X render a proper card. metadataBase falls
// back to the Vercel deployment URL when a custom domain isn't configured.
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  metadataBase: process.env.NEXT_PUBLIC_SITE_URL
    ? new URL(process.env.NEXT_PUBLIC_SITE_URL)
    : process.env.VERCEL_URL
      ? new URL(`https://${process.env.VERCEL_URL}`)
      : undefined,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    siteName: "videoclipthis",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    creator: "@derekisbuilding",
    site: "@videoclipthis",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
