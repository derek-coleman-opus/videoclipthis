/**
 * Manual pipeline runner — trigger the bot from the terminal whenever you want, without the
 * HTTP layer or the cron schedule.
 *
 *   npm run scout       # discover -> score -> clip -> queue/post one cycle (force, ignores paused)
 *   npm run summon      # process new @mentions
 *   npm run feedback    # refresh metrics + reshare signal on posted clips
 *   npm run pipeline    # scout, then summon, then feedback (the full daily cycle)
 *
 * Env is loaded via `node --env-file=.env` (see package.json). Missing keys abort loudly —
 * there is no mock fallback.
 */
import { runScout } from "@/lib/pipeline/runScout";
import { runSummon } from "@/lib/pipeline/summon";
import { runFeedback } from "@/lib/pipeline/feedback";

type Command = "scout" | "summon" | "feedback" | "all" | "pipeline";

async function main() {
  const cmd = (process.argv[2] ?? "scout") as Command;
  switch (cmd) {
    case "scout":
      console.log(JSON.stringify(await runScout({ force: true }), null, 2));
      break;
    case "summon":
      console.log(JSON.stringify(await runSummon(), null, 2));
      break;
    case "feedback":
      console.log(JSON.stringify(await runFeedback(), null, 2));
      break;
    case "all":
    case "pipeline": {
      const scout = await runScout({ force: true });
      const summon = await runSummon();
      const feedback = await runFeedback();
      console.log(JSON.stringify({ scout, summon, feedback }, null, 2));
      break;
    }
    default:
      console.error(`Unknown command "${cmd}". Use: scout | summon | feedback | pipeline`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
