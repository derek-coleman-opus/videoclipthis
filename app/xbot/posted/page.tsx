import { desc, inArray } from "drizzle-orm";
import { db, xbotDrafts } from "@/lib/db";
import XbotPlugButton from "@/components/XbotPlugButton";

export const dynamic = "force-dynamic";

export default async function XbotPostedPage() {
  let rows: Awaited<ReturnType<typeof load>>;
  try {
    rows = await load();
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }

  return (
    <div>
      <h2 className="mb-3 text-sm font-medium text-neutral-400">Posted &amp; approved ({rows.length})</h2>
      <p className="mb-4 text-xs text-neutral-500">
        Approved drafts wait here until X credentials are configured; posted ones link to X.
        When one of your posts gets traction, hit &ldquo;Plug product&rdquo; to draft a self-reply
        with your product link — that traffic converts.
      </p>
      <div className="overflow-x-auto rounded-lg border border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-900 text-left text-neutral-400">
            <tr>
              <th className="p-2 font-medium">Kind</th>
              <th className="p-2 font-medium">Text</th>
              <th className="p-2 font-medium">Status</th>
              <th className="p-2 font-medium">Edited</th>
              <th className="p-2 font-medium">When</th>
              <th className="p-2 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {rows.map((d) => (
              <tr key={d.id}>
                <td className="p-2 text-neutral-400">{d.kind}</td>
                <td className="max-w-lg p-2">
                  {d.xPostId ? (
                    <a href={`https://x.com/i/status/${d.xPostId}`} target="_blank" rel="noreferrer" className="hover:underline">
                      {d.text}
                    </a>
                  ) : d.text}
                </td>
                <td className="p-2">{d.status}</td>
                <td className="p-2 text-neutral-500">{d.editedByHuman ? "yes" : ""}</td>
                <td className="p-2 text-neutral-500">
                  {(d.postedAt ?? d.createdAt) ? new Date(d.postedAt ?? d.createdAt!).toLocaleString() : ""}
                </td>
                <td className="p-2">
                  {d.kind === "post" && d.status === "posted" && d.xPostId && (
                    <XbotPlugButton draftId={d.id} />
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-3 text-neutral-500">Nothing approved or posted yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function load() {
  return db()
    .select()
    .from(xbotDrafts)
    .where(inArray(xbotDrafts.status, ["approved", "scheduled", "posted", "failed"]))
    .orderBy(desc(xbotDrafts.createdAt))
    .limit(100);
}
