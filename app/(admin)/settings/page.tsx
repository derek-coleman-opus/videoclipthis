import { getSettings } from "@/lib/settings";
import SettingsForm from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  let cfg;
  try {
    cfg = await getSettings();
  } catch (e) {
    return <div className="text-sm text-amber-300">Database not ready: {(e as Error).message}</div>;
  }

  return (
    <div>
      <h2 className="mb-4 text-sm font-medium text-neutral-400">Settings</h2>
      <SettingsForm
        initial={{
          paused: cfg.paused, threshold: cfg.threshold, autonomy: cfg.autonomy,
          niche: cfg.niche ?? "", watchChannels: cfg.watchChannels ?? "",
        }}
      />
      <p className="mt-6 max-w-md text-xs leading-relaxed text-neutral-500">
        <b>Autonomy</b> — <b>review</b> queues every clip for your approval (default, safest while tuning the
        ranking). <b>auto</b> posts to X automatically above the threshold.
        <br />
        <b>Threshold</b> is the clip-worthiness gate (0–100); raise it to be more selective.
        <br />
        <b>Niche + Watched channels + Figures</b> are the fork points: set them and the bot clips
        your industry — no code changes.
      </p>
    </div>
  );
}
