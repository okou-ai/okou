#!/usr/bin/env bash
set -euo pipefail

human_stats=$(sccache --show-stats)
printf '%s\n' "$human_stats"
json_stats=$(sccache --show-stats --stats-format=json)
printf '%s\n' "$json_stats"

{
  printf '### sccache statistics\n\n~~~text\n%s\n~~~\n\n' "$human_stats"
  printf '~~~json\n%s\n~~~\n' "$json_stats"
} >> "$GITHUB_STEP_SUMMARY"
