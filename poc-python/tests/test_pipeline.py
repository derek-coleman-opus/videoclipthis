"""End-to-end mock test. Run: PYTHONPATH=. python3 tests/test_pipeline.py  (or pytest)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from videoclipthis.models import Candidate, Moment
from videoclipthis.pipeline import run_scout
from videoclipthis.production import MockClipper, compose_post
from videoclipthis.publishing import DryRunPublisher
from videoclipthis.scoring import MockScorer
from videoclipthis.selection import MockSelector
from videoclipthis.sources import build_sources


def _run():
    return run_scout(
        build_sources({}, mock=True),
        MockScorer(), MockSelector(), MockClipper(), DryRunPublisher(),
        threshold=70,
    )


def test_scout_produces_credit_first_clip():
    produced = _run()
    assert len(produced) >= 1, "expected at least one clip from the mock source"
    post = produced[0].post_text
    assert "@airesearcher" in post          # credit-first: tags the speaker
    assert "full talk:" in post             # always links the full talk
    assert "fork it" in post                # labels itself agent-made


def test_low_signal_is_filtered():
    titles = [c.candidate.title for c in _run()]
    assert "Weekly channel update #214" not in titles


def test_compose_post_falls_back_without_handle():
    c = Candidate(source="youtube", url="https://x", video_id="x", title="t")
    assert "this speaker" in compose_post(c, Moment(0, 30, "great bit"))


if __name__ == "__main__":
    test_scout_produces_credit_first_clip()
    test_low_signal_is_filtered()
    test_compose_post_falls_back_without_handle()
    print("\nAll tests passed ✅")
