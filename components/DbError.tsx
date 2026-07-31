import { describeDbError } from "@/lib/db";

/** The single "the database said no" panel every admin page renders, so the operator always gets
 *  the right next step instead of a blanket "set DATABASE_URL and run db:push". */
export default function DbError({ error }: { error: unknown }) {
  const info = describeDbError(error);
  return (
    <div className="rounded-lg border border-amber-800 bg-amber-950/40 p-4 text-sm">
      <p className="font-medium text-amber-300">
        {info.title}
        {info.retryable && (
          <span className="ml-2 rounded bg-amber-900/60 px-1.5 py-0.5 text-xs font-normal text-amber-200">
            transient
          </span>
        )}
      </p>
      <p className="mt-1 text-neutral-400">{info.hint}</p>
      <p className="mt-2 break-words font-mono text-xs text-neutral-500">{info.message}</p>
    </div>
  );
}
