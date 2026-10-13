#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$(git rev-parse --show-toplevel)"

case "${EVENT_NAME:?EVENT_NAME is required}" in
  pull_request)
    base=$(bash "$script_dir/changed-base-ref.sh")
    ;;
  merge_group)
    # Include every entry in the group, not just the last synthetic commit.
    base=${MERGE_GROUP_BASE_SHA:?MERGE_GROUP_BASE_SHA is required}
    ;;
  push)
    # A push can contain several commits; HEAD^ would omit earlier inputs.
    base=${PUSH_BEFORE_SHA:?PUSH_BEFORE_SHA is required}
    ;;
  *)
    echo "Unsupported workflow script selection event: $EVENT_NAME" >&2
    exit 2
    ;;
esac

base=$(git rev-parse --verify "${base}^{commit}")
git merge-base --is-ancestor "$base" HEAD || {
  echo "Workflow script selection base is not an ancestor of HEAD" >&2
  exit 2
}

changed_files=$(mktemp)
trap 'rm -f "$changed_files"' EXIT
# Preserve both sides of a move and paths containing whitespace/newlines.
git diff --no-renames --name-only -z "$base" HEAD > "$changed_files"
has_changes=false
needed=false
while IFS= read -r -d '' path; do
  has_changes=true
  case "$path" in
    turbo/apps/api/src/signals/services/*)
      # Release rollback adapters consume API service writer paths.
      needed=true
      break
      ;;
    docs/*.md | turbo/apps/api/src/*.ts | turbo/apps/api/src/*.tsx | \
      turbo/apps/platform/src/*.ts | turbo/apps/platform/src/*.tsx)
      # Audited business source/prose is not an input to these script/native
      # fixtures. Its owning product/static/security pipelines still run.
      ;;
    *)
      # Includes workflows/actions, retained tools/fixtures, Ansible, native
      # owners, ops, and package/build/config inputs. Unknown ownership runs.
      needed=true
      break
      ;;
  esac
done < "$changed_files"

# An empty diff is not proof that the retained work is inapplicable.
if [ "$has_changes" = false ]; then
  needed=true
fi
printf 'needed=%s\n' "$needed"
