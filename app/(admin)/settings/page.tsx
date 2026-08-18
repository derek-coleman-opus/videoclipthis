import DbError from "@/components/DbError";
import { getSettings } from "@/lib/settings";
import SettingsForm from "@/components/SettingsForm";
import CrosspostAccounts from "@/components/CrosspostAccounts";
import { DEFAULT_PROFILE_KEY, PROFILES } from "@/lib/pipeline/audience";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let cfg;
  try {
    cfg = await getSettings();
  } catch (e) {
    return <DbError error={e} />;
  }

  return (
    <div>
      <h2 className="mb-4 text-sm font-medium text-neutral-400">Settings</h2>
      <SettingsForm
        // Remount on a profile switch: the form's field state is seeded from `initial`, so without
        // a changing key a refresh would leave the outgoing profile's topics on screen.
        key={cfg.activeProfile ?? DEFAULT_PROFILE_KEY}
        initial={{
          paused: cfg.paused, threshold: cfg.threshold, autonomy: cfg.autonomy,
          dailyClipCap: cfg.dailyClipCap ?? 6,
          niche: cfg.niche ?? "", watchChannels: cfg.watchChannels ?? "",
          opusBrandTemplateId: cfg.opusBrandTemplateId ?? "",
          searchTopics: cfg.searchTopics ?? "",
          activeProfile: cfg.activeProfile ?? DEFAULT_PROFILE_KEY,
          curationBrief: cfg.curationBrief ?? "",
        }}
        profiles={PROFILES.map((p) => ({
          key: p.key, label: p.label,
          topicCount: p.searchTopics.length, channelCount: p.watchChannels.length,
        }))}
      />
      <CrosspostAccounts />
      <p className="mt-6 max-w-md text-xs leading-relaxed text-neutral-500">
        <b>Autonomy</b> — <b>review</b> queues every clip for your approval (default, safest while tuning the
        ranking). <b>auto</b> posts finished clips on its own, capped at the daily clip cap and spaced
        at least 20 minutes apart so the account reads curated, not firehose.
        <br />
        <b>Threshold</b> is the clip-worthiness gate (0–100); raise it to be more selective.
        <br />
        <b>Niche + Watched channels + Figures</b> are the fork points: set them and the bot clips
        your industry — no code changes.
      </p>
    </div>
  );
}
