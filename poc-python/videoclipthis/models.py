"""Core data models passed between pipeline stages.

These typed records are the contract between stages, so each stage can be
developed and tested independently (and the generation backend swapped:
OpusClip now, Agent Opus later).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class Candidate:
    """A long-form video detected by a source, before scoring."""
    source: str                      # "youtube" | "podcast" | "x" | "hn" | "reddit" | ...
    url: str
    video_id: str
    title: str
    speaker: str = ""
    speaker_handle: str = ""         # resolved X handle (no @); "" if unknown -> credit must be resolved or held
    channel: str = ""
    event: str = ""
    duration_s: int = 0
    published_at: Optional[str] = None   # ISO8601
    detected_at: Optional[str] = None    # ISO8601 — starts the first-to-clip latency clock
    signal_strength: float = 0.0         # how much buzz the detector saw
    transcript: str = ""


@dataclass
class ScoredCandidate:
    """A candidate after the clip-worthiness precision gate (build plan §3.3)."""
    candidate: Candidate
    score: int                       # 0-100
    rationale: str = ""


@dataclass
class Moment:
    """A specific viral-worthy segment chosen from the source."""
    start_s: float
    end_s: float
    hook_caption: str
    confidence: float = 0.0

    @property
    def length_s(self) -> int:
        return int(round(self.end_s - self.start_s))


@dataclass
class ProducedClip:
    """A rendered, credit-first clip ready to publish."""
    candidate: Candidate
    moment: Moment
    clip_path: str                   # local path or signed URL to the rendered 9:16 clip
    post_text: str                   # credit-first composed copy (see production.compose_post)
    reply_to: Optional[str] = None   # tweet id for summon replies; None for Scout posts
