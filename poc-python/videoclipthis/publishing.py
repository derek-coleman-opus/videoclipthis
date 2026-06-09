"""Publishing to X (build plan §4, §7). DryRunPublisher prints; XPublisher is M3."""
from __future__ import annotations

from typing import Protocol

from .models import ProducedClip


class Publisher(Protocol):
    def publish(self, clip: ProducedClip) -> str: ...


class DryRunPublisher:
    """Prints what would be posted; returns a fake id. Used by --dry-run and tests."""

    def publish(self, clip: ProducedClip) -> str:
        where = f"reply to {clip.reply_to}" if clip.reply_to else "new post"
        print(f"\n--- WOULD PUBLISH ({where}) ---")
        print(clip.post_text)
        print(f"[clip: {clip.clip_path}]")
        print("--- end ---")
        return "dry-run-id"


class XPublisher:
    """Posts to X via API v2. Account must carry the 'Automated' label."""

    def __init__(self, settings):
        self.settings = settings

    def publish(self, clip: ProducedClip) -> str:
        # TODO(M3): tweepy v2 — media upload (clip_path) + create_tweet (reply if clip.reply_to).
        # Rate-limit summon replies; never reply unless tagged.
        raise NotImplementedError("XPublisher is stubbed — see build plan §4/§7 (M3).")
