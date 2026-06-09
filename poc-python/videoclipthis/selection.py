"""Moment selection — OpusClip ClipAnything + a Claude curator (build plan §3.4).

OpusClip's virality scoring finds engagement-ranked segments; Claude picks the
1-3 best self-contained moments and writes the hook caption.
"""
from __future__ import annotations

from typing import Optional, Protocol

from .models import Candidate, Moment


class Selector(Protocol):
    def select(self, candidate: Candidate) -> Optional[Moment]: ...


class MockSelector:
    def select(self, candidate: Candidate) -> Optional[Moment]:
        return Moment(start_s=0.0, end_s=47.0,
                      hook_caption="the part everyone will quote", confidence=0.9)


class OpusClipSelector:
    """OpusClip virality scoring + ClipAnything; Claude curates the best moment."""

    def __init__(self, opusclip_key: str, anthropic_key: str):
        self.opusclip_key = opusclip_key
        self.anthropic_key = anthropic_key

    def select(self, candidate: Candidate) -> Optional[Moment]:
        # TODO(M1): call OpusClip ClipAnything/virality on candidate.url to get scored
        # segments; have Claude pick the best self-contained moment + write the hook.
        raise NotImplementedError("OpusClipSelector is stubbed — see build plan §3.4 (M1).")
