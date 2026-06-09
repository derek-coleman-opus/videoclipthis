"""Clip-worthiness scoring — the precision gate (build plan §3.3).

Only candidates scoring >= threshold proceed to clipping. This is the single
most important quality lever: it stops the bot from posting boring clips.
"""
from __future__ import annotations

from typing import Protocol

from . import config
from .models import Candidate, ScoredCandidate

RUBRIC_PROMPT = """You are the editor for a developer/AI clip account.
Given a long video's title, channel/speaker, and transcript, score it 0-100 on
clip-worthiness for an audience of AI/dev builders, weighting:
- authority (25): is the speaker/org high-signal?
- novelty (20): new release/announcement/genuinely new info?
- relevance (20): do AI/dev builders care right now?
- virality (20): strong claims, quotable lines, a demo, a hot take?
- freshness (10): recent + window still open?
- saturation (5, inverse): penalize already-widely-clipped.
Return JSON: {"score": int, "rationale": str}."""


class Scorer(Protocol):
    def score(self, candidate: Candidate) -> ScoredCandidate: ...


class MockScorer:
    """Heuristic scorer for tests/demo — no LLM call."""

    def score(self, candidate: Candidate) -> ScoredCandidate:
        s = 50
        if candidate.channel.lower() in config.HIGH_AUTHORITY_CHANNELS:
            s += 30
        hot = ("agents", "demo", "nobody expects", "live", "2027", "refactor")
        if any(w in candidate.transcript.lower() for w in hot):
            s += 10
        if candidate.duration_s < 900:  # very short / likely vlog filler
            s -= 20
        s = max(0, min(100, s))
        return ScoredCandidate(candidate, s, rationale="mock heuristic")


class ClaudeScorer:
    """Real scorer — Claude applies the rubric to transcript + metadata."""

    def __init__(self, api_key: str, model: str = "claude-sonnet-4-6"):
        self.api_key = api_key
        self.model = model

    def score(self, candidate: Candidate) -> ScoredCandidate:
        # TODO(M1): call the Anthropic Messages API with RUBRIC_PROMPT + candidate fields,
        # parse {"score","rationale"}. Lazy-import `anthropic` inside this method.
        raise NotImplementedError("ClaudeScorer is stubbed — see build plan §3.3 (M1).")
