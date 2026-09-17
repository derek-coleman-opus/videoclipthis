#!/usr/bin/env bash
#
# Polls /api/health and keeps ONE GitHub issue in sync with the answer.
#
# This exists because the pipeline had no way to report its own failure. Every outage was found
# days late, by noticing an absence of posts. A scheduled run of this script turns that absence
# into a notification.
#
# Deliberately posts only `problems[]` and the scalar counters. It does NOT post the health
# payload's `recentErrors`, which echo the pipeline's raw exception text and could carry a
# connection string or similar in a driver-level error.
#
# Required env: HEALTH_URL, HEALTH_TOKEN, GH_TOKEN (or GITHUB_TOKEN), GH_REPO.

set -uo pipefail

TITLE="[pipeline-health] Pipeline needs attention"
LABEL="pipeline-health"

# --- resolve state -----------------------------------------------------------------------------

state=""; summary=""; detail=""

if [[ -z "${HEALTH_URL:-}" || -z "${HEALTH_TOKEN:-}" ]]; then
  state="unconfigured"
  summary="Monitoring is not configured"
  detail=$'The health monitor ran but `HEALTH_URL` or `HEALTH_TOKEN` is not set in this repository\'s\nsecrets, so it checked nothing. **Nothing is watching the pipeline right now.**\n\nFix: Settings → Secrets and variables → Actions → New repository secret.\n\n- `HEALTH_URL` — e.g. `https://your-domain.vercel.app/api/health`\n- `HEALTH_TOKEN` — the same value set as `HEALTH_TOKEN` in Vercel'
else
  # Token goes in the Authorization header, never the URL, so it cannot land in a log line.
  body="$(curl -sS --max-time 30 -w $'\n%{http_code}' \
    -H "Authorization: Bearer ${HEALTH_TOKEN}" "${HEALTH_URL}" 2>&1)"
  curl_rc=$?
  code="$(tail -n1 <<<"$body")"
  body="$(sed '$d' <<<"$body")"

  if [[ $curl_rc -ne 0 ]]; then
    state="unreachable"; summary="Health endpoint unreachable"
    detail="\`curl\` failed (exit ${curl_rc}) against the health endpoint. The app may be down, or the URL wrong."
  elif [[ "$code" == "503" ]]; then
    state="unreachable"; summary="Health endpoint disabled"
    detail="The endpoint returned **503**, which means \`HEALTH_TOKEN\` is not set *in Vercel*. The endpoint fails closed, so it is serving nothing."
  elif [[ "$code" == "401" ]]; then
    state="unreachable"; summary="Health token rejected"
    detail="The endpoint returned **401**. The \`HEALTH_TOKEN\` secret in this repository does not match the one set in Vercel."
  elif [[ "$code" != "200" ]]; then
    state="unreachable"; summary="Health endpoint returned HTTP ${code}"
    detail="Expected 200; got **${code}**."
  elif ! jq -e . >/dev/null 2>&1 <<<"$body"; then
    state="unreachable"; summary="Health endpoint returned malformed JSON"
    detail="The response was 200 but not parseable as JSON — usually an error page from an edge or auth layer in front of the app."
  else
    stalled="$(jq -r '.stalled // false' <<<"$body")"
    ok="$(jq -r '.ok // false' <<<"$body")"
    problems="$(jq -r '(.problems // []) | map("- " + .) | join("\n")' <<<"$body")"
    counters="$(jq -r '.pipeline | del(.recentErrors)' <<<"$body")"

    if [[ "$stalled" == "true" ]]; then
      state="stalled"; summary="Pipeline is STALLED"
    elif [[ "$ok" == "true" ]]; then
      state="healthy"; summary="Pipeline is healthy"
    else
      state="attention"; summary="Pipeline needs attention"
    fi
    detail=$'**Problems reported**\n\n'"${problems}"$'\n\n<details><summary>Counters</summary>\n\n```json\n'"${counters}"$'\n```\n\n</details>'
  fi
fi

echo "state=${state}"
echo "summary=${summary}"

# --- sync the issue ----------------------------------------------------------------------------

# Find the issue by LABEL, not by title search: a label is an exact filter, whereas a text
# search can silently miss and open a duplicate every hour. Creating it is idempotent.
gh label create "$LABEL" --repo "$GH_REPO" --color B60205 \
  --description "Automated pipeline health monitor" >/dev/null 2>&1 || true
existing="$(gh issue list --repo "$GH_REPO" --state open --label "$LABEL" \
  --json number,body --jq '.[0]' 2>/dev/null)"
number="$(jq -r '.number // empty' <<<"${existing:-{\}}")"
prev_fp="$(jq -r '.body // ""' <<<"${existing:-{\}}" | sed -n 's/.*<!-- fingerprint: \([a-z0-9]*\) -->.*/\1/p')"

if [[ "$state" == "healthy" ]]; then
  if [[ -n "$number" ]]; then
    gh issue comment "$number" --repo "$GH_REPO" \
      --body "✅ Recovered — the pipeline reports healthy as of $(date -u '+%Y-%m-%d %H:%M UTC'). Closing."
    gh issue close "$number" --repo "$GH_REPO"
    echo "closed=${number}"
  else
    echo "healthy=nothing-to-do"
  fi
  exit 0
fi

fp="$(printf '%s\n%s' "$state" "$detail" | sha256sum | cut -c1-12)"
issue_body="$(cat <<BODY
**${summary}** — last checked $(date -u '+%Y-%m-%d %H:%M UTC').

${detail}

---
This issue is maintained automatically by \`.github/workflows/pipeline-health.yml\`. It updates in
place while the problem persists and closes itself when the pipeline recovers.

<!-- fingerprint: ${fp} -->
BODY
)"

if [[ -z "$number" ]]; then
  gh issue create --repo "$GH_REPO" --title "$TITLE" --label "$LABEL" --body "$issue_body"
  echo "opened=1"
else
  # Always refresh the body so "last checked" stays current, but only COMMENT when the problem
  # actually changed. An hourly comment on an unchanged problem is how a monitor gets muted.
  gh issue edit "$number" --repo "$GH_REPO" --body "$issue_body"
  if [[ "$fp" != "$prev_fp" ]]; then
    gh issue comment "$number" --repo "$GH_REPO" --body "🔄 Status changed — **${summary}**"$'\n\n'"${detail}"
    echo "commented=1"
  else
    echo "unchanged=1"
  fi
fi
