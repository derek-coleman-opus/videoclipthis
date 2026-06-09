"""Scout orchestration + CLI entry point (build plan §2).

Wires the discovery engine: ingest -> score (gate) -> credit-check -> select -> produce -> publish.
Run:  PYTHONPATH=. python3 -m videoclipthis.pipeline --mock --dry-run
"""
from __future__ import annotations

import argparse
from typing import Optional

from . import config
from .models import ProducedClip
from .production import MockClipper, OpusClipClipper, needs_credit_resolution
from .publishing import DryRunPublisher, XPublisher
from .scoring import ClaudeScorer, MockScorer
from .selection import MockSelector, OpusClipSelector
from .sources import build_sources


def run_scout(sources, scorer, selector, clipper, publisher, threshold: int) -> list[ProducedClip]:
    produced: list[ProducedClip] = []
    for src in sources:
        for cand in src.discover():
            scored = scorer.score(cand)
            if scored.score < threshold:
                print(f"  skip [{scored.score}] {cand.title!r} ({src.name})")
                continue
            if needs_credit_resolution(cand):
                # Credit-first rule (build plan §1): don't post what we can't attribute.
                print(f"  hold [{scored.score}] {cand.title!r} — unresolved speaker credit")
                continue
            moment = selector.select(cand)
            if moment is None:
                continue
            clip = clipper.produce(cand, moment)
            publisher.publish(clip)
            produced.append(clip)
            print(f"  post [{scored.score}] {cand.title!r}")
    return produced


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="videoclipthis Scout")
    ap.add_argument("--mock", action="store_true", help="run on mock data, no keys/network")
    ap.add_argument("--dry-run", action="store_true", help="print posts instead of publishing")
    ap.add_argument("--threshold", type=int, default=None, help="override clip-worthiness threshold")
    args = ap.parse_args(argv)

    scoring_cfg = config.load_scoring()
    threshold = args.threshold if args.threshold is not None else scoring_cfg["threshold"]

    if args.mock:
        sources = build_sources({}, mock=True)
        scorer, selector, clipper = MockScorer(), MockSelector(), MockClipper()
    else:
        sources = build_sources(config.load_watchlist(), mock=False)
        s = config.Settings
        scorer = ClaudeScorer(s.anthropic_key)
        selector = OpusClipSelector(s.opusclip_key, s.anthropic_key)
        clipper = OpusClipClipper(s.opusclip_key, s.opusclip_base)

    dry = args.dry_run or args.mock
    publisher = DryRunPublisher() if dry else XPublisher(config.Settings)

    print(f"Scout running (threshold={threshold}, mock={args.mock}, dry_run={dry})")
    produced = run_scout(sources, scorer, selector, clipper, publisher, threshold)
    print(f"\nProduced {len(produced)} clip(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
