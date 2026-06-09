"""Production — render the clip + compose the credit-first post (build plan §1, §4).

compose_post() IS the credit-first "gift, not competition" model in code: every
post leads by crediting + tagging the speaker, links the full talk, and labels
itself agent-made. Real, tested logic (the clip render itself is stubbed for M1).
"""
from __future__ import annotations

from typing import Protocol

from .models import Candidate, Moment, ProducedClip

FOOTER = "🤖 found, clipped & posted by an agent · built on OpusClip · fork it"


def compose_post(candidate: Candidate, moment: Moment) -> str:
    """Credit-first copy. The speaker is the hero, not us."""
    if candidate.speaker_handle:
        who = f"@{candidate.speaker_handle}"
    elif candidate.speaker:
        who = candidate.speaker
    else:
        who = "this speaker"
    event = f" at {candidate.event}" if candidate.event else ""
    line = (
        f"Loved {who}'s talk{event} 🙌 Clipped my favorite {moment.length_s}s for you — "
        f"{moment.hook_caption} 👇 (full talk: {candidate.url})"
    )
    return f"{line}\n\n{FOOTER}"


def needs_credit_resolution(candidate: Candidate) -> bool:
    """Credit-first rule (build plan §1): hold a clip we can't confidently attribute."""
    return not (candidate.speaker_handle or candidate.speaker)


class Clipper(Protocol):
    def produce(self, candidate: Candidate, moment: Moment) -> ProducedClip: ...


class MockClipper:
    def produce(self, candidate: Candidate, moment: Moment) -> ProducedClip:
        return ProducedClip(
            candidate=candidate,
            moment=moment,
            clip_path=f"/tmp/{candidate.video_id}_{int(moment.start_s)}-{int(moment.end_s)}.mp4",
            post_text=compose_post(candidate, moment),
        )


class OpusClipClipper:
    """Render via OpusClip: clip -> reframe 9:16 -> caption -> export."""

    def __init__(self, api_key: str, base: str):
        self.api_key = api_key
        self.base = base

    def produce(self, candidate: Candidate, moment: Moment) -> ProducedClip:
        # TODO(M1): call OpusClip clip/reframe/caption/export for [start,end]; confirm
        # exact endpoints/tool names at api.opus.pro. Return the signed clip URL + post.
        raise NotImplementedError("OpusClipClipper is stubbed — see build plan §4 (M1).")
