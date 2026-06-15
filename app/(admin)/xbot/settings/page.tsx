import { getXbotSettings } from "@/lib/xbot/settings";
import XbotSettingsForm from "@/components/XbotSettingsForm";

export const dynamic = "force-dynamic";

export default async function XbotSettingsPage() {
  let s: Awaited<ReturnType<typeof getXbotSettings>>;
  try {
    s = await getXbotSettings();
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }

  return (
    <div>
      <h2 className="mb-4 text-sm font-medium text-neutral-400">XBot settings</h2>
      <XbotSettingsForm
        initial={{
          paused: s.paused,
          replyAutonomy: s.replyAutonomy,
          postAutonomy: s.postAutonomy,
          likesAuto: s.likesAuto,
          dailyReplyCap: s.dailyReplyCap,
          dailyLikeCap: s.dailyLikeCap,
          dailyPostCap: s.dailyPostCap,
          dailyEngageCap: s.dailyEngageCap,
          cooldownDays: s.cooldownDays,
          quietStartUtc: s.quietStartUtc,
          quietEndUtc: s.quietEndUtc,
          maxFollowers: s.maxFollowers,
          keywords: s.keywords,
          voiceNotes: s.voiceNotes ?? "",
          mission: s.mission ?? "",
          productUrl: s.productUrl ?? "",
          communityId: s.communityId ?? "",
        }}
      />
    </div>
  );
}
