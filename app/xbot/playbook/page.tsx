import Link from "next/link";
import { getXbotSettings, parseSetupChecklist } from "@/lib/xbot/settings";
import { SETUP_ITEMS } from "@/lib/xbot/playbook";
import XbotPlaybook from "@/components/XbotPlaybook";

export const dynamic = "force-dynamic";

const RULES: Array<{ title: string; points: string[] }> = [
  {
    title: "Replies (the small-account growth engine)",
    points: [
      "Engage your 40–50 target creators regularly — replies are how you grow before your posts work.",
      "Every reply must be funny, contrarian, or value-adding. \"Good post\" / \"Best of luck\" replies are auto-rejected by the drafting guard.",
      "Reply to EVERYONE who engages with your posts — the algorithm shows new posts to followers first; engaged followers keep the account alive.",
    ],
  },
  {
    title: "Posts (3–5 per day)",
    points: [
      "Document the journey: progress, setbacks, lessons, features shown off in a cool way — that's where inbound users come from.",
      "Open with a number or a take; short sentences, no long paragraphs.",
      "Never text-only: attach an image or video (drafts come with a media suggestion).",
      "Post 9am–5pm EST — the default quiet hours (22–14 UTC) enforce this.",
      "When a post gets traction, use \"Plug product\" on the Posted page to reply with your product link and convert the impressions into visitors.",
    ],
  },
  {
    title: "What kills accounts (don't)",
    points: [
      "One-liner / \"let's connect\" tweets: the follows they bring never engage again, so the algorithm buries everything you post after.",
      "Cold DMs — never. Warm DMs are different: invite people who regularly engage with your posts to try the product.",
    ],
  },
];

export default async function XbotPlaybookPage() {
  let initialDone: string[];
  try {
    initialDone = parseSetupChecklist(await getXbotSettings());
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }

  return (
    <div className="max-w-3xl">
      <h2 className="mb-1 text-sm font-medium text-neutral-400">XBot playbook</h2>
      <p className="mb-4 text-xs text-neutral-500">
        The growth method the bot encodes; prompts and guards enforce the reply/post rules,
        the checklist below is the human part. Mission, community, and product URL live in{" "}
        <Link href="/xbot/settings" className="underline hover:text-neutral-300">XBot Settings</Link>.
      </p>

      <div className="mb-6">
        <XbotPlaybook items={SETUP_ITEMS} initialDone={initialDone} />
      </div>

      <div className="space-y-4">
        {RULES.map((section) => (
          <div key={section.title} className="rounded-lg border border-neutral-800 p-3">
            <h3 className="mb-2 text-sm font-medium text-neutral-400">{section.title}</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm text-neutral-300">
              {section.points.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
