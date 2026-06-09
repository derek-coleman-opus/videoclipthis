"""Configuration: watchlist + scoring rubric + secrets.

Loads YAML from config/ when pyyaml is installed; otherwise falls back to the
built-in defaults below so the --mock pipeline runs with zero dependencies.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"

try:
    import yaml  # type: ignore
    _HAVE_YAML = True
except Exception:  # pragma: no cover - depends on env
    _HAVE_YAML = False


DEFAULT_WATCHLIST: dict[str, Any] = {
    "youtube_channels": [
        {"name": "Anthropic", "channel_id": "TODO"},
        {"name": "Google DeepMind", "channel_id": "TODO"},
        {"name": "OpenAI", "channel_id": "TODO"},
        {"name": "AI Engineer", "channel_id": "TODO"},
    ],
    "podcasts": [],
    "x_signal_accounts": ["karpathy", "AnthropicAI", "GoogleDeepMind", "OpenAIDevs"],
    "subreddits": ["LocalLLaMA", "MachineLearning"],
}

DEFAULT_SCORING: dict[str, Any] = {
    "weights": {
        "authority": 25, "novelty": 20, "relevance": 20,
        "virality": 20, "freshness": 10, "saturation": 5,
    },
    "threshold": 70,
}

# Channels we treat as inherently high-authority for the mock scorer's heuristic.
HIGH_AUTHORITY_CHANNELS = {"anthropic", "google deepmind", "openai", "ai engineer"}


def _load_yaml(name: str, default: dict) -> dict:
    path = CONFIG_DIR / name
    if _HAVE_YAML and path.exists():
        with open(path) as f:
            return yaml.safe_load(f) or default
    return default


def load_watchlist() -> dict:
    return _load_yaml("watchlist.yaml", DEFAULT_WATCHLIST)


def load_scoring() -> dict:
    return _load_yaml("scoring.yaml", DEFAULT_SCORING)


class Settings:
    """Secrets / endpoints from the environment (see .env.example)."""
    anthropic_key = os.getenv("ANTHROPIC_API_KEY", "")
    opusclip_key = os.getenv("OPUSCLIP_API_KEY", "")
    opusclip_base = os.getenv("OPUSCLIP_API_BASE", "https://api.opus.pro")
    youtube_key = os.getenv("YOUTUBE_API_KEY", "")
    x_bearer = os.getenv("X_BEARER_TOKEN", "")
    x_api_key = os.getenv("X_API_KEY", "")
    x_api_secret = os.getenv("X_API_SECRET", "")
    x_access_token = os.getenv("X_ACCESS_TOKEN", "")
    x_access_secret = os.getenv("X_ACCESS_SECRET", "")
