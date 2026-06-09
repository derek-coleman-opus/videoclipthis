import { db, candidates, clips, events, settings } from "@/lib/db";
import { composePost } from "@/lib/pipeline/production";

/** Populate realistic demo activity so the admin panel is alive without any API keys. */
export async function seedDemo(): Promise<void> {
  const database = db();
  await database.insert(settings).values({ id: 1 }).onConflictDoNothing();

  // 1) A posted clip the speaker reshared (the credit-first growth loop working).
  const [c1] = await database.insert(candidates).values({
    source: "youtube", url: "https://youtu.be/DEMO123", videoId: "DEMO123",
    title: "The Future of Coding Agents", speaker: "A. Researcher", speakerHandle: "airesearcher",
    channel: "Anthropic", event: "AI Engineer Summit", durationS: 3012, signalStrength: 0.8,
    status: "posted", score: 90, rationale: "high authority + strong viral claim",
  }).returning();
  const post1 = composePost(
    { source: "youtube", url: "https://youtu.be/DEMO123", videoId: "DEMO123", title: "",
      speakerHandle: "airesearcher", event: "AI Engineer Summit" },
    { startS: 0, endS: 47, hookCaption: "agents will write most code by 2027", confidence: 0.92 },
  );
  const [clip1] = await database.insert(clips).values({
    candidateId: c1.id, startS: 0, endS: 47, hookCaption: "agents will write most code by 2027",
    postText: post1, clipUrl: "https://mock.clips/DEMO123_0-47.mp4", kind: "scout", status: "posted",
    xPostId: "1999999999", views: 41200, resharedBySpeaker: true, costUsd: 0.04, postedAt: new Date(),
  }).returning();

  // 2) A clip waiting in the review queue.
  const [c2] = await database.insert(candidates).values({
    source: "youtube", url: "https://youtu.be/GEMINI22", videoId: "GEMINI22",
    title: "Gemini deep-dive: new tool use", speaker: "DeepMind Eng", speakerHandle: "dmeng",
    channel: "Google DeepMind", event: "Tech Talk", durationS: 2600, signalStrength: 0.6,
    status: "selected", score: 82, rationale: "new release + highly relevant",
  }).returning();
  const post2 = composePost(
    { source: "youtube", url: "https://youtu.be/GEMINI22", videoId: "GEMINI22", title: "",
      speakerHandle: "dmeng", event: "Tech Talk" },
    { startS: 120, endS: 158, hookCaption: "the tool-use trick nobody noticed", confidence: 0.8 },
  );
  await database.insert(clips).values({
    candidateId: c2.id, startS: 120, endS: 158, hookCaption: "the tool-use trick nobody noticed",
    postText: post2, clipUrl: "https://mock.clips/GEMINI22_120-158.mp4", kind: "scout",
    status: "pending_review", costUsd: 0.05,
  });

  // 3) A low-signal skip and a held-for-credit candidate (the two gates working).
  await database.insert(candidates).values({
    source: "youtube", url: "https://youtu.be/VLOG", videoId: "VLOG01",
    title: "Weekly channel update #214", channel: "Random Vlog", durationS: 600, signalStrength: 0.1,
    status: "skipped", score: 30, rationale: "low signal / filler",
  });
  await database.insert(candidates).values({
    source: "hn", url: "https://youtu.be/NOCRED", videoId: "NOCRED1",
    title: "Great talk, unknown speaker", channel: "Unknown", durationS: 2400, signalStrength: 0.5,
    status: "held", score: 74, rationale: "clip-worthy but unattributed",
  });

  await database.insert(events).values([
    { type: "posted", message: "Posted: The Future of Coding Agents — reshared by @airesearcher 🎉", refTable: "clips", refId: clip1.id },
    { type: "scored", message: "Queued for review [82]: Gemini deep-dive: new tool use", refTable: "candidates", refId: c2.id },
    { type: "held", message: "Held [74] — no speaker credit: Great talk, unknown speaker", refTable: "candidates" },
    { type: "skipped", message: "Skipped [30]: Weekly channel update #214", refTable: "candidates" },
    { type: "run", message: "Seed data loaded" },
  ]);
}
