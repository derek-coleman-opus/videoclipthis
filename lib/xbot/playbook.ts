/** One-time account-setup prerequisites (the "0 followers" checklist) — small-account
 *  growth methods agree content can't outrun a bad profile setup. Completion ids are
 *  persisted in xbot_settings.setupChecklist. */

export interface PlaybookItem {
  id: string;
  label: string;
  detail: string;
}

export const SETUP_ITEMS: PlaybookItem[] = [
  { id: "premium", label: "Buy X Premium", detail: "~$8/mo — X boosts Premium replies and people trust (and follow) verified accounts more." },
  { id: "mission", label: "Pick a public mission and set it in XBot Settings", detail: "e.g. \"0 → $1k MRR in public\" — a storyline makes people remember you; every post becomes a beat of it." },
  { id: "headshot", label: "Profile photo: real headshot", detail: "Show your face — faceless accounts get ignored." },
  { id: "banner", label: "Banner that fits X", detail: "Not LinkedIn-corporate; show the product or the mission." },
  { id: "bio", label: "Bio states mission + current progress", detail: "What you're building, where you are on the journey." },
  { id: "pinned", label: "Pinned tweet showcases what you're building", detail: "First thing profile visitors see — make it the product." },
  { id: "roster", label: "Build the creator roster: 40–50 niche accounts under 5k followers", detail: "Add them as XBot targets (and an X List) and engage with their posts regularly." },
  { id: "community", label: "Join one big niche community and set its ID in XBot Settings", detail: "e.g. Build in Public for SaaS — small accounts reach further posting there than into the void." },
];
