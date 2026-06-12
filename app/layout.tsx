import "./globals.css";
import type { ReactNode } from "react";
import Link from "next/link";

export const metadata = {
  title: "videoclipthis — admin",
  description: "Bot activity: found · posted · replied",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="mx-auto max-w-6xl px-4 py-6">
          <header className="flex items-center justify-between border-b border-neutral-800 pb-4">
            <div>
              <h1 className="text-lg font-semibold">@videoclipthis</h1>
              <p className="text-xs text-neutral-500">bot activity — found · posted · replied</p>
            </div>
            <nav className="flex gap-4 text-sm text-neutral-300">
              <Link href="/" className="hover:text-white">Dashboard</Link>
              <Link href="/found" className="hover:text-white">Found</Link>
              <Link href="/posts" className="hover:text-white">Posts</Link>
              <Link href="/replies" className="hover:text-white">Replies</Link>
              <Link href="/figures" className="hover:text-white">Figures</Link>
              <Link href="/settings" className="hover:text-white">Settings</Link>
              <span className="flex gap-4 border-l border-neutral-700 pl-4">
                <Link href="/xbot" className="hover:text-white">XBot</Link>
                <Link href="/xbot/targets" className="hover:text-white">Targets</Link>
                <Link href="/xbot/queue" className="hover:text-white">Queue</Link>
                <Link href="/xbot/posted" className="hover:text-white">Posted</Link>
                <Link href="/xbot/playbook" className="hover:text-white">Playbook</Link>
                <Link href="/xbot/settings" className="hover:text-white">XBot Settings</Link>
              </span>
            </nav>
          </header>
          <main className="py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
