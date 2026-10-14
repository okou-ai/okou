#!/usr/bin/env bash
set -euo pipefail

for command in jq shellcheck yq; do
  if ! command -v "$command" >/dev/null; then
    echo "${command} is required" >&2
    exit 2
  fi
done

if (( $# > 0 )); then
  workflows=("$@")
else
  shopt -s nullglob
  workflows=(.github/workflows/*.yml .github/workflows/*.yaml)
fi

for workflow in "${workflows[@]}"; do
  if [[ ! -f "$workflow" ]]; then
    echo "workflow does not exist: ${workflow}" >&2
    exit 2
  fi
done

query="$(
  cat <<'YQ'
  (.defaults.run.shell // "sh") as $workflow_shell |
  .jobs | to_entries[] |
  select(.value.container != null) |
  . as $job |
  ($job.value.defaults.run.shell // $workflow_shell) as $job_shell |
  $job.value.steps[]? |
  select(has("run")) |
  {
    "job": $job.key,
    "step": (.name // "<unnamed>"),
    "shell": (.shell // $job_shell),
    "script": .run,
    "line": (.run | line)
  }
YQ
)"

run_shellcheck() {
  local shell_name="$1"
  local script="$2"
  local output
  local status=0

  output="$(
    shellcheck \
      --norc \
      --format=json \
      "--shell=${shell_name}" \
      - <<< "$script"
  )" || status=$?
  if (( status > 1 )); then
    echo "shellcheck failed with exit code ${status}" >&2
    return "$status"
  fi
  printf '%s' "${output:-[]}"
}

findings=0
for workflow in "${workflows[@]}"; do
  records="$(yq -o=json -I=0 "$query" "$workflow")"
  if [[ -z "$records" ]]; then
    continue
  fi

  while IFS= read -r record; do
    shell="$(jq -r .shell <<< "$record")"
    shell_command="${shell%% *}"
    shell_name="${shell_command##*/}"
    if [[ "$shell_name" != "sh" ]]; then
      continue
    fi

    script="$(jq -r .script <<< "$record")"
    bash_findings="$(run_shellcheck bash "$script")"
    sh_findings="$(run_shellcheck sh "$script")"
    compatibility_findings="$(
      jq -cn \
        --argjson bash "$bash_findings" \
        --argjson sh "$sh_findings" \
        '[
          $sh[] as $candidate |
          select(
            any(
              $bash[];
              .code == $candidate.code and
              .line == $candidate.line and
              .column == $candidate.column
            ) | not
          ) |
          $candidate
        ]'
    )"

    if [[ "$(jq length <<< "$compatibility_findings")" -eq 0 ]]; then
      continue
    fi

    job="$(jq -r .job <<< "$record")"
    step="$(jq -r .step <<< "$record")"
    run_line="$(jq -r .line <<< "$record")"
    while IFS=$'\t' read -r code script_line column message; do
      printf '%s:%d:1: container job %q, step %q uses sh but contains non-POSIX syntax: SC%s at script %s:%s: %s. Declare shell: bash for the step or defaults.run.shell: bash for the job.\n' \
        "$workflow" \
        "$run_line" \
        "$job" \
        "$step" \
        "$code" \
        "$script_line" \
        "$column" \
        "$message" \
        >&2
      ((findings += 1))
    done < <(
      jq -r \
        '.[] | [.code, .line, .column, .message] | @tsv' \
        <<< "$compatibility_findings"
    )
  done <<< "$records"
done

if (( findings > 0 )); then
  echo "workflow shell compatibility check failed with ${findings} finding(s)" >&2
  exit 1
fi
