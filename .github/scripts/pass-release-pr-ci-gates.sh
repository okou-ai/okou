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
CHECK_COVERAGE="${REPO_ROOT}/.github/scripts/check-release-please-workspace-coverage.sh"

PR_JSON=$(gh pr view release-please--branches--main --repo "$GITHUB_REPOSITORY" --json number,headRefOid 2>/dev/null || echo "")
if [ -z "$PR_JSON" ]; then
  echo "No release PR found, skipping"
  exit 0
fi

PR_NUMBER=$(jq -r .number <<<"$PR_JSON")
PR_HEAD=$(jq -r .headRefOid <<<"$PR_JSON")
CHANGED_FILES=$(gh pr diff "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" --name-only)

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

# iOS has no release-please package. Only an unrelated release may report this
# gate without running the iOS workflow; changes to the client still require CI.
if grep -qE '^ios/|^\.github/workflows/ios\.yml$|^\.github/scripts/changed-base-ref\.sh$' <<<"$CHANGED_FILES"; then
  create_gate_check \
    ci-gate-ios \
    failure \
    "iOS changes require validation" \
    "This release PR changes iOS inputs. Run the iOS workflow on this commit before merging."
  echo "::error::Release PR changes iOS inputs and cannot skip iOS validation"
  exit 1
fi
create_gate_check ci-gate-ios success "No iOS changes" "This release PR does not change iOS inputs."

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

git -C "$REPO_ROOT" fetch --no-tags --depth=1 origin "$PR_HEAD"
git -C "$REPO_ROOT" worktree add --detach "$RELEASE_WORKTREE" "$PR_HEAD"
RELEASE_WORKTREE_ADDED=true

RELEASE_VALIDATION_OUTPUT=""
if ! RELEASE_VALIDATION_OUTPUT=$(
  cd "$RELEASE_WORKTREE"
  "$CHECK_COVERAGE" 2>&1
); then
  create_gate_check ci-gate-turbo success "Release PR — CI skipped" "Release-please PRs only contain version bumps and changelogs."
  create_gate_check ci-gate-crates success "Release PR — CI skipped" "Release-please PRs only contain version bumps and changelogs."
  create_gate_check \
    ci-gate-security \
    failure \
    "Release Please workspace coverage failed" \
    "$RELEASE_VALIDATION_OUTPUT"
  echo "::error::Release Please workspace coverage failed for exact head $PR_HEAD"
  printf '%s\n' "$RELEASE_VALIDATION_OUTPUT" >&2
  exit 1
fi
printf '%s\n' "$RELEASE_VALIDATION_OUTPUT"
echo "Release Please workspace coverage passed for exact head $PR_HEAD"

db_release_in_pr=false
api_release_in_pr=false
if printf '%s\n' "$CHANGED_FILES" | grep -qx "turbo/packages/db/package.json"; then
  db_release_in_pr=true
fi
if printf '%s\n' "$CHANGED_FILES" | grep -qx "turbo/apps/api/package.json"; then
  api_release_in_pr=true
fi

if [ "$db_release_in_pr" = "true" ] && [ "$api_release_in_pr" != "true" ]; then
  create_gate_check \
    ci-gate-turbo \
    failure \
    "DB release requires API release" \
    "Release PRs that bump turbo/packages/db must also bump turbo/apps/api because production migrations are owned by the API release lifecycle."
  create_gate_check ci-gate-crates success "Release PR — CI skipped" "Release-please PRs only contain version bumps and changelogs."
  create_gate_check ci-gate-security success "Release PR validation passed" "Release Please workspace coverage passed for exact head $PR_HEAD."
  echo "::error::turbo/packages/db release PR changes must ship with turbo/apps/api."
  exit 1
fi

for gate in ci-gate-turbo ci-gate-crates; do
  create_gate_check "$gate" success "Release PR — CI skipped" "Release-please PRs only contain version bumps and changelogs."
done
create_gate_check ci-gate-security success "Release PR validation passed" "Release Please workspace coverage passed for exact head $PR_HEAD."
