#!/usr/bin/env bash
set -euo pipefail

# Create ci-gate check runs on the release PR head commit. GITHUB_TOKEN pushes
# don't trigger pull_request events, so the CI workflows never run on the new
# commit. The Checks API with GITHUB_TOKEN produces check runs with
# integration_id 15368 (GitHub Actions), satisfying the required_status_checks
# ruleset.

require_env() {
  local name=$1
  if [ -z "${!name:-}" ]; then
    echo "missing required env: ${name}" >&2
    exit 2
  fi
}

require_env GH_TOKEN
require_env GITHUB_REPOSITORY

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "current directory is not inside a Git repository" >&2
  exit 2
}
CHECK_COVERAGE="${REPO_ROOT}/.github/scripts/checks/check-release-please-workspace-coverage.sh"
CHECK_ACTION_PINS="${REPO_ROOT}/.github/scripts/checks/check-action-pins.py"
PROMOTION="${REPO_ROOT}/ios/scripts/archive-promotion.py"

PR_JSON=$(gh pr view release-please--branches--main --repo "$GITHUB_REPOSITORY" --json number,headRefOid,headRefName,baseRefOid,baseRefName 2>/dev/null || echo "")
if [ -z "$PR_JSON" ]; then
  echo "No release PR found, skipping"
  exit 0
fi

PR_NUMBER=$(jq -r .number <<<"$PR_JSON")
PR_HEAD=$(jq -er '.headRefOid | select(type == "string" and test("^[0-9a-f]{40}$"))' <<<"$PR_JSON")
PR_BASE=$(jq -er '.baseRefOid | select(type == "string" and test("^[0-9a-f]{40}$"))' <<<"$PR_JSON")
if [ "$(jq -r .baseRefName <<<"$PR_JSON")" != main ]; then
  echo "Release validation requires the main base branch" >&2
  exit 1
fi

create_gate_check() {
  local gate="$1"
  local conclusion="$2"
  local title="$3"
  local summary="$4"

  gh api "repos/${GITHUB_REPOSITORY}/check-runs" -X POST \
    -f name="$gate" \
    -f head_sha="$PR_HEAD" \
    -f status="completed" \
    -f conclusion="$conclusion" \
    -f "output[title]=$title" \
    -f "output[summary]=$summary"
  echo "✅ Created $gate check run on $PR_HEAD with conclusion $conclusion"
}

RELEASE_WORKTREE_ROOT=$(mktemp -d)
RELEASE_WORKTREE="${RELEASE_WORKTREE_ROOT}/head"
RELEASE_WORKTREE_ADDED=false
cleanup_release_worktree() {
  if [ "$RELEASE_WORKTREE_ADDED" = true ]; then
    git -C "$REPO_ROOT" worktree remove --force "$RELEASE_WORKTREE"
  fi
  rm -rf "$RELEASE_WORKTREE_ROOT"
}
trap cleanup_release_worktree EXIT

git -C "$REPO_ROOT" fetch --no-tags --depth=64 origin "$PR_HEAD" "$PR_BASE"
PR_MERGE_BASE=$(git -C "$REPO_ROOT" merge-base "$PR_BASE" "$PR_HEAD")
# Bind the entire path selection to the inspected head, including renamed-away inputs.
CHANGED_FILES_FILE="${RELEASE_WORKTREE_ROOT}/changed-files"
git -C "$REPO_ROOT" diff --no-renames --name-only -z "$PR_MERGE_BASE" "$PR_HEAD" >"$CHANGED_FILES_FILE"
native_needed=false
while IFS= read -r -d '' changed_file; do
  case "$changed_file" in
    ios/* | .github/workflows/ios.yml | .github/workflows/ios-build-cache.yml | .github/actions/setup-ios-build-cache/* | .github/workflows/ios-archive-proof.yml | .github/workflows/release-please.yml | .github/scripts/checks/changed-base-ref.sh | release-please-config.json) native_needed=true ;;
  esac
done <"$CHANGED_FILES_FILE"
git -C "$REPO_ROOT" worktree add --detach "$RELEASE_WORKTREE" "$PR_HEAD"
RELEASE_WORKTREE_ADDED=true

RELEASE_VALIDATION_OUTPUT=""
if ! RELEASE_VALIDATION_OUTPUT=$(
  cd "$RELEASE_WORKTREE" &&
    "$CHECK_COVERAGE" 2>&1 &&
    python3 "$CHECK_ACTION_PINS" "$RELEASE_WORKTREE" 2>&1
); then
  create_gate_check ci-gate-turbo success "Release PR — CI skipped" "Release-please PRs only contain version bumps and changelogs."
  create_gate_check ci-gate-crates success "Release PR — CI skipped" "Release-please PRs only contain version bumps and changelogs."
  create_gate_check \
    ci-gate-security \
    failure \
    "Release PR validation failed" \
    "$RELEASE_VALIDATION_OUTPUT"
  echo "::error::Release PR validation failed for exact head $PR_HEAD"
  printf '%s\n' "$RELEASE_VALIDATION_OUTPUT" >&2
  exit 1
fi
printf '%s\n' "$RELEASE_VALIDATION_OUTPUT"
echo "Release Please workspace coverage passed for exact head $PR_HEAD"

# Publish decisions only for the revision whose complete diff and inputs we read.
current_pr=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json headRefOid)
if [ "$(jq -er .headRefOid <<<"$current_pr")" != "$PR_HEAD" ]; then
  echo "Release PR head changed; leave its new revision to the next refresh."
  exit 0
fi

# Bot updates do not trigger pull_request CI. Metadata can reuse actual tests
# from a main ancestor; other changes retain native validation on this head.
if [ "$native_needed" = true ]; then
  release_branch=$(jq -er '.headRefName | select(type == "string" and length > 0)' <<<"$PR_JSON")
  runs=$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/ios.yml/runs?head_sha=${PR_HEAD}&event=workflow_dispatch&per_page=100" --paginate --slurp)
  existing=$(jq -c --arg head "$PR_HEAD" --arg branch "$release_branch" '
    [.[].workflow_runs[] | select(.head_sha == $head and .head_branch == $branch)] |
    sort_by([.created_at, .id]) | reverse |
    ([.[] | select(.status != "completed")] + .) | first // empty
  ' <<<"$runs")
  if [ -n "$existing" ]; then
    run_url=$(jq -er .html_url <<<"$existing")
    if [ "$(jq -r .status <<<"$existing")" = completed ] && [ "$(jq -r .conclusion <<<"$existing")" != success ]; then
      create_gate_check ci-gate-ios failure "Existing iOS validation did not pass" "Inspect ${run_url}; release refresh does not automatically retry failed or cancelled validation."
      exit 1
    fi
    echo "Retaining existing iOS validation for $PR_HEAD: $run_url"
  else
    decision=$(cd "$RELEASE_WORKTREE" && python3 "$PROMOTION" release-pr-tests --base "$PR_BASE")
    if [ "$(jq -er '.reuse | if type == "boolean" then tostring else error("missing reuse decision") end' <<<"$decision")" = true ]; then
      evidence_url=$(jq -er .runUrl <<<"$decision")
      create_gate_check ci-gate-ios success "Release metadata verified against main tests" "Native test inputs match successful main validation: ${evidence_url}. The merge queue still verifies its actual toolchain and version-specific archive."
    else
      current_pr=$(gh pr view "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --json headRefOid)
      if [ "$(jq -er .headRefOid <<<"$current_pr")" != "$PR_HEAD" ]; then
        echo "Release PR head changed before dispatch; leave its new revision to the next refresh."
        exit 0
      fi
      gh workflow run ios.yml --repo "$GITHUB_REPOSITORY" --ref "$release_branch"
      echo "Dispatched iOS validation for release PR head $PR_HEAD"
    fi
  fi
else
  create_gate_check ci-gate-ios success "No iOS changes" "This release PR does not change iOS inputs."
fi

db_release_in_pr=false
api_release_in_pr=false
if grep -zqx "turbo/packages/db/package.json" "$CHANGED_FILES_FILE"; then
  db_release_in_pr=true
fi
if grep -zqx "turbo/apps/api/package.json" "$CHANGED_FILES_FILE"; then
  api_release_in_pr=true
fi

if [ "$db_release_in_pr" = "true" ] && [ "$api_release_in_pr" != "true" ]; then
  create_gate_check \
    ci-gate-turbo \
    failure \
    "DB release requires API release" \
    "Release PRs that bump turbo/packages/db must also bump turbo/apps/api because production migrations are owned by the API release lifecycle."
  create_gate_check ci-gate-crates success "Release PR — CI skipped" "Release-please PRs only contain version bumps and changelogs."
  create_gate_check ci-gate-security success "Release PR validation passed" "Release Please workspace coverage and action pins passed for exact head $PR_HEAD."
  echo "::error::turbo/packages/db release PR changes must ship with turbo/apps/api."
  exit 1
fi

for gate in ci-gate-turbo ci-gate-crates; do
  create_gate_check "$gate" success "Release PR — CI skipped" "Release-please PRs only contain version bumps and changelogs."
done
create_gate_check ci-gate-security success "Release PR validation passed" "Release Please workspace coverage and action pins passed for exact head $PR_HEAD."
