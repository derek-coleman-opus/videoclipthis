/** Resolve the COMPLETE text of a tweet for drafting context.
 *
 *  The X v2 `text` field is truncated to 280 chars for long-form (X Premium) posts — the full
 *  body lives in `note_tweet.text`. And for retweets the `text` is just "RT @user: …" while the
 *  real content is the referenced tweet; quote tweets carry their commentary plus a separate
 *  quoted tweet. Callers must request `note_tweet` + the `referenced_tweets` fields and the
 *  `referenced_tweets.id` expansion so the originals arrive in `includes.tweets`. */

export interface RawTweet {
  id: string;
  text: string;
  note_tweet?: { text?: string };
  referenced_tweets?: { type: string; id: string }[];
}

export interface TweetIncludes {
  tweets?: RawTweet[];
}

/** Full body of a single tweet: long-form note text when present, else the plain text. */
function bodyOf(t: RawTweet): string {
  return (t.note_tweet?.text?.trim() || t.text || "").trim();
}

/** The complete text we should reason about: unwraps retweets to the original and appends the
 *  quoted tweet for quote-tweets, using the un-truncated note_tweet body at every level. */
export function fullTweetText(tweet: RawTweet, includes?: TweetIncludes): string {
  const find = (id: string) => includes?.tweets?.find((t) => t.id === id);
  const refs = tweet.referenced_tweets ?? [];

  // A retweet's real content is the post it retweeted.
  const retweeted = refs.find((r) => r.type === "retweeted");
  if (retweeted) {
    const orig = find(retweeted.id);
    if (orig) return bodyOf(orig);
  }

  let text = bodyOf(tweet);

  // A quote tweet = our author's commentary + the tweet they quoted; give Claude both.
  const quoted = refs.find((r) => r.type === "quoted");
  if (quoted) {
    const q = find(quoted.id);
    if (q) text = `${text}\n\n[quote-tweeting: ${bodyOf(q)}]`.trim();
  }
  return text;
}

/** Tweet fields + expansion every read must request to make fullTweetText() work. */
export const FULL_TWEET_FIELDS = ["created_at", "public_metrics", "text", "note_tweet", "referenced_tweets"] as const;
export const FULL_TWEET_EXPANSIONS = ["referenced_tweets.id"] as const;
