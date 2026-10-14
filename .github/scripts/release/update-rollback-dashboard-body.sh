#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: update-rollback-dashboard-body.sh BODY_FILE TARGET_COMMIT ROLLBACK_URL RELEASE_TAGS_JSON" >&2
  exit 2
fi

body_file=$1
target_commit=$2
rollback_url=$3
release_tags=$4

if [[ ! "$target_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "target commit must be a full lowercase SHA-1: $target_commit" >&2
  exit 2
fi

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

jq -e '
  type == "array" and
  length > 0 and
  all(.[]; type == "string" and test("^.+-v[0-9]")) and
  length == (unique | length)
' <<<"$release_tags" >/dev/null || {
  echo "release tags must be a non-empty JSON array of unique version tags" >&2
  exit 2
}

work_dir=$(mktemp -d)
entries_dir="${work_dir}/entries"
releases_file="${work_dir}/releases.json"
normalized_releases_file="${work_dir}/normalized-releases.json"
release_rows_file="${work_dir}/release-rows.tsv"
rendered_body_file="${work_dir}/body.md"
mkdir -p "$entries_dir"
trap 'rm -rf "$work_dir"' EXIT

while IFS= read -r release_tag; do
  gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${release_tag}"
done < <(jq -r '.[]' <<<"$release_tags") | jq -s . >"$releases_file"

jq -ce \
  --arg target "$target_commit" \
  --argjson expected_tags "$release_tags" '
  if ([.[].tag_name] | sort) != ($expected_tags | sort) then
    error("Release artifacts do not match the requested release tags")
  elif any(.[]; .target_commitish != $target) then
    error("Release artifacts do not all target " + $target)
  else
    [
      .[]
      | (.tag_name | capture("^(?<artifact>.+)-v(?<version>[0-9].*)$")) as $tag
      | {
          artifact: $tag.artifact,
          version: $tag.version,
          url: .html_url,
          published_at: .published_at,
          priority: (
            if $tag.artifact == "app" then 0
            elif $tag.artifact == "api" then 1
            elif $tag.artifact == "runner-rs" then 2
            else 3
            end
          )
        }
    ]
  end
  | if length == 0 then
      error("No release artifacts found for target " + $target)
    else
      sort_by([.priority, .artifact])
    end
' "$releases_file" >"$normalized_releases_file"

published_at=$(jq -r 'map(.published_at) | max' "$normalized_releases_file")
singapore_time=$(TZ=Asia/Singapore date -d "$published_at" '+%m-%d-%Y %H:%M:%S')
sf_time=$(TZ=America/Los_Angeles date -d "$published_at" '+%m-%d-%Y %H:%M:%S')
sf_zone=$(TZ=America/Los_Angeles date -d "$published_at" '+%Z')
jq -r '.[] | [.artifact, .version, .url] | @tsv' \
  "$normalized_releases_file" >"$release_rows_file"

new_entry_file="${entries_dir}/000.md"
{
  printf '<!-- ROLLBACK_ENTRY_START %s -->\n' "$target_commit"
  printf '<details>\n'
  printf '<summary>%s SGT</summary>\n\n' "$singapore_time"
  printf '* RevertId: `%s`\n' "$target_commit"
  printf '* %s %s\n\n' "$sf_zone" "$sf_time"

  while IFS=$'\t' read -r artifact version url; do
    printf '### [%s](%s): `%s`\n\n' "$artifact" "$url" "$version"
  done <"$release_rows_file"

  printf '</details>\n'
  printf '<!-- ROLLBACK_ENTRY_END -->\n'
} >"$new_entry_file"

awk -v entries_dir="$entries_dir" -v target="$target_commit" '
  /^<!-- ROLLBACK_ENTRY_START [0-9a-f]+ -->$/ {
    commit = $0
    sub(/^<!-- ROLLBACK_ENTRY_START /, "", commit)
    sub(/ -->$/, "", commit)
    capture = commit != target && kept < 6
    if (capture) {
      kept++
      entry_file = sprintf("%s/%03d.md", entries_dir, kept)
      print > entry_file
    }
    next
  }
  capture { print >> entry_file }
  /^<!-- ROLLBACK_ENTRY_END -->$/ {
    if (capture) close(entry_file)
    capture = 0
  }
' "$body_file"

normalize_retained_entry() {
  local entry_file=$1
  local normalized_entry_file="${entry_file}.normalized"

  awk '
    /^<!-- ROLLBACK_ENTRY_START [0-9a-f]+ -->$/ {
      entry_commit = $0
      sub(/^<!-- ROLLBACK_ENTRY_START /, "", entry_commit)
      sub(/ -->$/, "", entry_commit)
      print
      next
    }
    /^```/ {
      in_fence = !in_fence
      next
    }
    in_fence { next }
    /^## .* Asia\/Singapore · .* SF · RollbackId:/ {
      singapore_time = $0
      sub(/^## /, "", singapore_time)
      sub(/ Asia\/Singapore ·.*$/, "", singapore_time)

      sf_time = $0
      sub(/^.* Asia\/Singapore · /, "", sf_time)
      sub(/ SF · RollbackId:.*$/, "", sf_time)

      print "<details>"
      print "<summary>" singapore_time " SGT</summary>"
      print ""
      print "* RevertId: `" entry_commit "`"
      print "* PDT " sf_time
      print ""
      converted = 1
      next
    }
    /^<details>$/ || /^\* RevertId: `[0-9a-f]+`$/ {
      print
      next
    }
    /^<summary>.*<\/summary>$/ || /^\* (PDT|PST) / ||
    /^### \[.*\]\(.*\): `.*`$/ {
      print
      print ""
      next
    }
    /^<\/details>$/ { print; next }
    /^<!-- ROLLBACK_ENTRY_END -->$/ {
      if (converted) print "</details>"
      print
      next
    }
  ' "$entry_file" >"$normalized_entry_file"

  mv "$normalized_entry_file" "$entry_file"
}

for entry_file in "$entries_dir"/[0-9][0-9][1-9].md; do
  if [ -f "$entry_file" ]; then
    normalize_retained_entry "$entry_file"
  fi
done

render_body() {
  local output_file=$1
  local entry_file

  {
    printf 'This issue is automatically maintained by CI. Do not edit manually.\n\n'
    printf '[Rollback Runner and API](%s)\n\n' "$rollback_url"
    printf 'App Worker versions are rolled back manually in Cloudflare.\n\n'
    printf '<!-- ROLLBACK_ENTRIES_START -->\n'
    for entry_file in "$entries_dir"/*.md; do
      command cat "$entry_file"
      printf '\n'
    done
    printf '<!-- ROLLBACK_ENTRIES_END -->\n'
  } >"$output_file"
}

max_body_bytes=65000
while true; do
  render_body "$rendered_body_file"
  body_bytes=$(wc -c <"$rendered_body_file")
  if [ "$body_bytes" -le "$max_body_bytes" ]; then
    break
  fi

  entry_files=("$entries_dir"/*.md)
  entry_count=${#entry_files[@]}
  if [ "$entry_count" -eq 1 ]; then
    echo "latest rollback dashboard entry exceeds ${max_body_bytes} bytes" >&2
    exit 1
  fi
  rm -f "${entry_files[$((entry_count - 1))]}"
done

command cat "$rendered_body_file"
