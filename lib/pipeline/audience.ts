/** AUDIENCE PROFILES — the one place that decides what this account is about.
 *
 *  Four prompts have to agree or the account produces incoherent output:
 *    1. the SCORER  (scoring.ts)   — which videos are worth paying to render
 *    2. the CURATOR (opusclip.ts)  — which 30 seconds inside the video get cut
 *    3. the EDITOR  (editorial.ts) — whether the finished clip is shareable enough to post
 *    4. DISCOVERY   (sources.ts)   — which channels and search terms are looked at
 *
 *  Before profiles existed, (1) and (3) read a `niche` string from settings while still
 *  hard-coding "working developer" in their rubric bodies, and (2) ignored the niche entirely.
 *  Changing the niche therefore half-switched the account: viral-topic videos were still cut and
 *  vetoed for developers. A profile moves all four together, which is the entire point.
 *
 *  Switching profiles in the admin snapshots the current profile's fields first, so flipping
 *  back and forth never loses hand-tuned topics or channels.
 */

export interface AudienceProfile {
  key: string;
  label: string;
  /** One-line audience description. Injected into every prompt as the reader being served. */
  niche: string;
  /** The weighted scoring axes. Must sum to 100 and must name what to REJECT, not only what to
   *  reward — an "informative" bias is what produces well-made clips nobody shares. */
  rubric: string;
  /** What the curator hunts for inside the video. This is the highest-leverage string in the
   *  repo: the scorer only decides which video gets paid for, this decides what people see. */
  curationBrief: string;
  /** The editor's CLIP-level shareability rubric. Deliberately separate from `rubric`, which
   *  judges whole videos before spending money — by the time the editor runs, the question is no
   *  longer "is this source promising" but "will this exact 40 seconds travel". */
  editorialRubric: string;
  /** What the editor refuses to post regardless of score, as one prose paragraph. */
  editorialFloor: string;
  /** Hard refusals, enforced at all three model steps (score 0 / don't select / veto). Stated as
   *  content rules rather than topic bans so they survive being pasted into any prompt. */
  guardrails: string[];
  searchTopics: string[];
  watchChannels: { name: string; handle?: string; xHandle?: string }[];
  /** Clip-worthiness gate. Higher where the candidate pool is larger. */
  threshold: number;
  /** Shareability floor for the editor. Below this a clip is not auto-posted. */
  editorialMinScore: number;
}

/** The original account: AI / developer tooling. Rubric and brief text are carried over verbatim
 *  from the pre-profile scorer, curator and editor prompts, so this profile reproduces the previous
 *  behavior. One assembly difference, deliberate and semantically neutral: the video's title and
 *  speaker are now stated as their own leading sentence rather than interpolated mid-clause into
 *  the brief's first line, because the brief is no longer a template. */
export const AI_DEVELOPER: AudienceProfile = {
  key: "ai-developer",
  label: "AI / developer tooling",
  niche: "AI / developer tooling",
  rubric: `- shareability (35): does it contain claims worth arguing about? Specific numbers, named tools,
  contrarian opinions, admissions that something doesn't work, predictions with dates. The test is
  whether a viewer would quote-tweet it to agree or push back — not whether it is informative.
- specificity (20): concrete detail from real work — demos, benchmarks, failures, tradeoffs —
  rather than abstraction and framing. Penalize videos that stay at the level of "AI is changing
  everything" no matter how well delivered.
- novelty (20): new release/announcement/genuinely new info?
- authority (10): is the speaker/org high-signal in this niche? A tiebreaker, NOT the main axis —
  a famous person saying something agreeable is worth less here than an unknown engineer showing
  something surprising.
- freshness (10): recent + window still open?
- saturation (5, inverse): penalize already-widely-clipped.
Score below 50 for keynote roadmap narration, panel pleasantries, and explainers of things this
audience already understands, however prestigious the source.`,
  curationBrief: `Find the single most ARGUABLE moment for an audience of AI engineers and developers on X (Twitter).
The bar is not "informative" — it is whether a working developer would stop scrolling and reply to it. Prioritize, in order: (1) a specific, falsifiable claim — a number, a benchmark, a named tool, a tradeoff, a prediction with a date, or an admission that something does not work; (2) a contrarian or surprising opinion that cuts against what this audience already believes; (3) a live demo or a concrete war story from real work; (4) a sharp, quotable framework.
The moment must open on the CLAIM ITSELF. The first spoken sentence should be the strong statement, not the wind-up to it — someone scrolling with sound off reads the caption of the first 2 seconds and decides there.
Reject boring segments even if they are the best available: slide reading, roadmap or feature narration, definitions of things this audience knows, agreeable consensus nobody would reply to, and motivational or futurist filler ("AI will change everything"). It is better to return a shorter, sharper moment than a well-delivered but unarguable one.
When the source shows a concrete artifact on screen — a terminal, an editor, code, a benchmark chart, a live demo — prefer a moment where that artifact is visible; those clips carry far better than a talking head. Where the source is only slides or a whiteboard, the moment must stand entirely on what is SPOKEN.`,
  editorialRubric: `- 40: is there a SPECIFIC claim? A number, a benchmark, a named tool, a tradeoff, a prediction with
  a date, an admission something doesn't work. Something a reply could contradict.
- 25: is it CONTRARIAN or surprising? Does it cut against what this audience already believes?
- 20: is it CONCRETE? Real detail from real work, not abstraction. A demo, a failure, a war story.
- 15: is it SELF-CONTAINED? Understandable cold, with no setup.`,
  editorialFloor: `vague futurism ("AI will change everything"), agreeable consensus that
nobody would reply to, roadmap or feature narration, motivational filler, a definition or
explainer of something this audience already knows, or a thought that needs the previous ten
minutes to land.`,
  guardrails: [],
  // Kept in config.ts as SEARCH_TOPICS / WATCHLIST and mirrored here so a profile switch can
  // restore them. config.ts remains the fallback when settings are blank.
  searchTopics: [
    "AI agents", "LLM agents", "coding agents", "frontier models", "open source LLM",
    "AI coding", "model context protocol", "AI evals", "reinforcement learning from human feedback",
    "long context models", "multimodal AI", "AI interview", "GPU inference", "vibe coding",
    "prompt engineering", "RAG retrieval augmented generation",
  ],
  watchChannels: [
    { name: "Anthropic", handle: "anthropic-ai", xHandle: "AnthropicAI" },
    { name: "Google DeepMind", handle: "Google_DeepMind", xHandle: "GoogleDeepMind" },
    { name: "OpenAI", handle: "OpenAI", xHandle: "OpenAI" },
    { name: "AI Engineer", handle: "aiDotEngineer", xHandle: "aiDotEngineer" },
    { name: "Latent Space", handle: "LatentSpaceTV", xHandle: "latentspacepod" },
    { name: "Dwarkesh Patel", handle: "DwarkeshPatel", xHandle: "dwarkesh_sp" },
    { name: "No Priors", handle: "NoPriorsPodcast", xHandle: "NoPriorsPod" },
    { name: "Y Combinator", handle: "ycombinator", xHandle: "ycombinator" },
    { name: "a16z", handle: "a16z", xHandle: "a16z" },
    { name: "Sequoia Capital", handle: "sequoiacapital", xHandle: "sequoia" },
    { name: "Machine Learning Street Talk", handle: "MachineLearningStreetTalk", xHandle: "MLStreetTalk" },
    { name: "Lex Fridman", handle: "lexfridman", xHandle: "lexfridman" },
  ],
  threshold: 70,
  editorialMinScore: 65,
};

/** Broad general interest — reach first. Culture, sport, money, celebrity, courtroom.
 *
 *  The axis weights are deliberately lopsided (shareability 50 + emotional charge 25 = 75 of the
 *  score) because the failure mode here is NOT missing good content, it is producing competent
 *  clips of interesting-but-inert moments. In this lane the pool is enormous and the constraint is
 *  attention, so the rubric is written to reject hard and often.
 *
 *  Specificity drops to 5 (from 20): in the dev lane a number is what makes a claim arguable, but
 *  broad audiences share a REACTION, not a datapoint. Authority stays at 10 — recognition helps a
 *  clip travel, but a nobody's astonishing moment still beats a famous person being pleasant.
 */
export const VIRALITY: AudienceProfile = {
  key: "virality",
  label: "Virality (broad general interest)",
  niche: "a broad general audience on X — the biggest, most shareable human moments in culture, sport, money and celebrity",
  rubric: `- shareability (50): would a stranger send this to someone else within ten seconds of seeing it?
  The test is the IMPULSE TO FORWARD, not interest, not quality, not information. Reward moments
  that make a viewer want to say "you have to see this" — a stunning admission, a confrontation, a
  reversal, a claim that sounds impossible, a question nobody expected to be answered honestly.
- emotional charge (25): does the moment carry a strong, legible feeling — shock, outrage,
  vindication, secondhand embarrassment, awe, delight? A moment with no emotional temperature does
  not travel regardless of how notable the speaker is. Reward visible, on-camera reaction.
- authority / recognition (10): would a scrolling stranger recognize this person, or the situation?
  Recognition speeds a clip up but does not rescue a boring moment — an unknown person saying
  something astonishing beats a household name being agreeable.
- freshness (10): is this moment part of a conversation happening RIGHT NOW? Reward the first 48
  hours of a story; penalize evergreen content with no reason to be posted today.
- specificity (5): a concrete, checkable detail that makes the moment credible rather than vague.
  Deliberately low: broad audiences share a reaction, not a datapoint.
Score below 40 for: interviews that stay pleasant throughout, promotional appearances, anything
whose interest depends on already following the subject, competent explanation of a topic, and
"inspiring" content with no specific moment in it. A prestigious source is not a reason to score
higher. Most videos in this lane should score below the threshold — be ruthless.`,
  curationBrief: `Find the single most SHAREABLE human moment — the one a stranger would forward to a friend within ten seconds.
The bar is not "interesting" and not "informative": it is whether someone watching with no context feels an immediate urge to send this to somebody. Prioritize, in order: (1) a confrontation, challenge, or interruption — someone being pushed and responding in real time; (2) a stunning admission or confession, especially one the speaker seems to regret starting; (3) a reversal — the moment a story or an opinion turns and the listener's face changes; (4) a claim so bold, specific or unlikely that a viewer wants to argue with it; (5) a genuinely delightful or astonishing moment.
The moment MUST open on the peak itself. The first spoken sentence has to be the striking line — never the wind-up, never the question that sets it up. Someone scrolling with the sound off reads the first two seconds of caption and decides there.
Prefer moments where a REACTION is visible on camera — the listener's face, the room's response, the pause before an answer. A reaction shot is what separates a clip that travels from a talking head, so where the source offers one, take it.
Reject, even when it is the best available: pleasant conversation, mutual agreement, promotional talk about a project, anything that needs context from earlier in the video to land, well-delivered general wisdom, and any moment whose appeal depends on already knowing who the speaker is. A shorter, sharper moment beats a complete but inert one — and returning nothing is better than returning something merely competent.`,
  editorialRubric: `- 45: FORWARD IMPULSE — would a stranger send this to someone within ten seconds? Not "is it good",
  not "is it interesting": would they hit share. This is the whole job; weight it accordingly.
- 25: EMOTIONAL CHARGE — is there a strong, legible feeling in the moment (shock, outrage,
  vindication, secondhand embarrassment, awe, delight)? Flat moments do not travel.
- 20: DOES IT OPEN ON THE PEAK? The first sentence must be the striking line itself, not the
  wind-up. A clip that takes ten seconds to get going is dead on arrival, however good the payoff.
- 10: is it SELF-CONTAINED? Understandable cold by someone who has never heard of this person.`,
  editorialFloor: `pleasant conversation, mutual agreement, promotional talk, general
wisdom however well phrased, anything that needs earlier context to land, and any moment whose
appeal depends on the viewer already knowing who is speaking.`,
  guardrails: [
    "Never build a hook around death, violence, injury, disaster, or crime victims. A moment whose shareability depends on someone's tragedy is out, however well it performs.",
    "Public figures speaking publicly are fair game. Never build a hook around humiliating a private individual — an audience member, an employee, an unnamed member of the public, or anyone who did not choose to be on camera.",
  ],
  // Broad-interest search terms. Phrased as MOMENTS rather than subjects: "athlete press
  // conference" surfaces clippable events, where "sports" surfaces highlight compilations that
  // are already clipped to death and carry no speech to quote.
  searchTopics: [
    "celebrity interview moment", "athlete press conference", "podcast confrontation",
    "courtroom moment", "heated interview", "unexpected answer interview",
    "money advice interview", "relationship debate podcast", "asked about rumors",
    "walks out of interview", "caught off guard interview", "awkward interview moment",
    "responds to critics", "first interview since", "breaks silence interview",
  ],
  // STARTING POINT — VERIFY BEFORE RELYING ON. These handles are best-effort; a wrong handle is
  // not fatal but falls back to a name search at 100 YouTube quota units instead of 1. Check them
  // with /api/debug/youtube and correct them in the admin, which persists per profile.
  watchChannels: [
    { name: "Hot Ones", handle: "FirstWeFeast", xHandle: "firstwefeast" },
    { name: "The Diary Of A CEO", handle: "TheDiaryOfACEO", xHandle: "StevenBartlett" },
    { name: "Club Shay Shay", handle: "ClubShayShay", xHandle: "ClubShayShay" },
    { name: "Jimmy Kimmel Live", handle: "JimmyKimmelLive", xHandle: "JimmyKimmelLive" },
    { name: "The Tonight Show Starring Jimmy Fallon", handle: "FallonTonight", xHandle: "FallonTonight" },
    { name: "Team Coco", handle: "teamcoco", xHandle: "TeamCoco" },
    { name: "GQ", handle: "GQ", xHandle: "GQMagazine" },
    { name: "WIRED", handle: "WIRED", xHandle: "WIRED" },
    { name: "Vanity Fair", handle: "VanityFair", xHandle: "VanityFair" },
    { name: "Law&Crime Network", handle: "LawAndCrime", xHandle: "LawCrimeNetwork" },
    { name: "The Ramsey Show", handle: "TheRamseyShow", xHandle: "RamseyShow" },
    { name: "TED", handle: "TED", xHandle: "TEDTalks" },
  ],
  // Higher than the dev profile: the candidate pool is an order of magnitude larger here, so the
  // gate has to be tighter to keep spend on the few moments that actually travel.
  threshold: 75,
  // Lower than the dev profile: the editor's own rubric is already the harsher gate in this lane,
  // and a 65 floor on top of a ruthless scorer starved the queue.
  editorialMinScore: 60,
};

export const PROFILES: AudienceProfile[] = [AI_DEVELOPER, VIRALITY];

export const DEFAULT_PROFILE_KEY = AI_DEVELOPER.key;

export function findProfile(key: string | null | undefined): AudienceProfile {
  return PROFILES.find((p) => p.key === key) ?? AI_DEVELOPER;
}

/** Render guardrails for injection into a prompt. Empty string when the profile has none, so the
 *  dev profile's prompts stay byte-identical to their pre-profile form. */
export function guardrailBlock(guardrails: string[]): string {
  if (!guardrails.length) return "";
  return `\nHARD RULES — these override every scoring or selection consideration above:\n${
    guardrails.map((g) => `- ${g}`).join("\n")}\n`;
}
