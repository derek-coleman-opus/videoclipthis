import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "videoclipthis — the open-source AI clip agent",
  description:
    "An autonomous agent that finds the best moments in long videos, clips them with AI, and posts them — point it at any niche.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
