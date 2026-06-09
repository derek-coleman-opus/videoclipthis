"""Source ingestion — watch the SOURCE platforms, not just X (build plan §3.1).

The whole edge is finding a fresh long-form talk *before* anyone clips it onto X.
M0: MockSource works end-to-end. Real sources are stubbed with TODO(M1) markers
describing the exact mechanism (WebSub push, Data API, RSS, filtered stream).
"""
from __future__ import annotations

from typing import Iterable, Protocol, runtime_checkable

from . import config
from .models import Candidate


@runtime_checkable
class Source(Protocol):
    name: str

    def discover(self) -> Iterable[Candidate]:
        """Yield freshly-detected long-form candidates."""
        ...


class MockSource:
    """Deterministic demo source so the pipeline runs with no keys/network."""
    name = "mock"

    def discover(self) -> Iterable[Candidate]:
        return [
            Candidate(
                source="youtube",
                url="https://youtu.be/DEMO123",
                video_id="DEMO123",
                title="The Future of Coding Agents",
                speaker="A. Researcher",
                speaker_handle="airesearcher",
                channel="Anthropic",
                event="AI Engineer Summit",
                duration_s=3012,
                published_at="2026-06-08T15:00:00Z",
                detected_at="2026-06-08T15:09:00Z",
                signal_strength=0.8,
                transcript=(
                    "... the thing nobody expects is that agents will write most code by 2027 ... "
                    "here's the demo where Claude refactors a 200k-line repo live ..."
                ),
            ),
            Candidate(
                source="youtube",
                url="https://youtu.be/SKIP456",
                video_id="SKIP456",
                title="Weekly channel update #214",
                speaker="Some Creator",
                speaker_handle="",
                channel="Random Vlog",
                duration_s=600,
                detected_at="2026-06-08T15:10:00Z",
                signal_strength=0.1,
                transcript="hey everyone welcome back to the channel, smash that like button ...",
            ),
        ]


class YouTubeSource:
    """Watchlist YouTube channels (build plan §3.1)."""
    name = "youtube"

    def __init__(self, channels: list[dict], api_key: str):
        self.channels = channels
        self.api_key = api_key

    def discover(self) -> Iterable[Candidate]:
        # TODO(M1): subscribe to each channel's WebSub/PubSubHubbub feed for near-real-time
        # new-upload pushes; fall back to Data API v3 playlistItems polling. Filter by
        # duration (long-form) + recency; fetch transcript via youtube-transcript-api.
        raise NotImplementedError("YouTubeSource is stubbed — see build plan §3.1 (M1).")


def build_sources(watchlist: dict, *, mock: bool) -> list[Source]:
    if mock:
        return [MockSource()]
    sources: list[Source] = []
    yt = watchlist.get("youtube_channels", [])
    if yt:
        sources.append(YouTubeSource(yt, config.Settings.youtube_key))
    # TODO(M2): PodcastSource (RSS), XSignalSource (filtered stream), HNSource, RedditSource.
    return sources
