#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SCRIPT_DIR}/../update-rollback-dashboard-body.sh"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

cat >"${fake_bin}/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = "api" ]
release_prefix=repos/okou-ai/okou/releases/tags/
[[ "${2:-}" == "${release_prefix}"* ]]
release_tag=${2#"$release_prefix"}
jq -e --arg release_tag "$release_tag" \
  --arg returned_tag "${MOCK_RETURNED_RELEASE_TAG:-}" \
  '.[]
   | select(.tag_name == $release_tag)
   | if $returned_tag == "" then . else .tag_name = $returned_tag end' \
  "$MOCK_RELEASES_FILE"
SH
chmod +x "${fake_bin}/gh"

body_file="${tmp_dir}/body.md"
output_file="${tmp_dir}/output.md"
releases_file="${tmp_dir}/releases.json"
rollback_url=https://github.com/okou-ai/okou/actions/workflows/rollback-production.yml

release_tags_from_file() {
  jq -c '[.[].tag_name]' "$releases_file"
}

release_tags_for_target() {
  local target=$1
  jq -c --arg target "$target" \
    '[.[] | select(.target_commitish == $target) | .tag_name]' \
    "$releases_file"
}

cat >"$body_file" <<'EOF'
This issue is automatically maintained by CI. Do not edit manually.

<!-- ROLLBACK_ENTRIES_START -->
### legacy entry
| Component | Version |
| api | v1.0.0 |
<!-- ROLLBACK_ENTRY_START aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->
## 07-22-2026 07:39:39 Asia/Singapore · 07-21-2026 16:39:39 SF · RollbackId: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`

### [legacy-app](https://example.test/legacy-app): `1.0.0`

**Change Log**

#### Dependencies

* old dependency

#### Bug Fixes

* retained fix

### [legacy-core](https://example.test/legacy-core): `2.0.0`

**Change Log**

#### Dependencies

* trailing dependency

<!-- ROLLBACK_ENTRY_END -->
<!-- ROLLBACK_ENTRIES_END -->
EOF

target_commit=1111111111111111111111111111111111111111
jq -n --arg target "$target_commit" '[
  {
    tag_name: "zeta-v2.0.0",
    target_commitish: $target,
    html_url: "https://github.com/okou-ai/okou/releases/tag/zeta-v2.0.0",
    published_at: "2026-07-22T23:39:32Z",
    body: "## [2.0.0](https://example.test/zeta) (2026-07-22)\n\n### Features\n\n* zeta feature"
  },
  {
    tag_name: "core-v8.452.0",
    target_commitish: $target,
    html_url: "https://github.com/okou-ai/okou/releases/tag/core-v8.452.0",
    published_at: "2026-07-22T23:39:31Z",
    body: "## [8.452.0](https://example.test/core) (2026-07-22)\n\n### Dependencies\n\n* core dependency"
  },
  {
    tag_name: "runner-rs-v0.147.2",
    target_commitish: $target,
    html_url: "https://github.com/okou-ai/okou/releases/tag/runner-rs-v0.147.2",
    published_at: "2026-07-22T23:39:40Z",
    body: "## [0.147.2](https://example.test/runner) (2026-07-22)\n\n### Performance Improvements\n\n* runner improvement"
  },
  {
    tag_name: "api-v1.303.0",
    target_commitish: $target,
    html_url: "https://github.com/okou-ai/okou/releases/tag/api-v1.303.0",
    published_at: "2026-07-22T23:39:33Z",
    body: "## [1.303.0](https://example.test/api) (2026-07-22)\n\n### Features\n\n* api feature"
  },
  {
    tag_name: "app-v0.618.0",
    target_commitish: $target,
    html_url: "https://github.com/okou-ai/okou/releases/tag/app-v0.618.0",
    published_at: "2026-07-22T23:39:34Z",
    body: "## [0.618.0](https://example.test/app) (2026-07-22)\n\n### Features\n\n* app feature\n\n### Dependencies\n\n* app dependency"
  },
  {
    tag_name: "okou-desktop-v0.618.0",
    target_commitish: $target,
    html_url: "https://github.com/okou-ai/okou/releases/tag/okou-desktop-v0.618.0",
    published_at: "2026-07-22T23:39:35Z",
    body: "Signed and notarized Okou release"
  },
  {
    tag_name: "unrelated-v9.9.9",
    target_commitish: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    html_url: "https://example.test/unrelated",
    published_at: "2026-07-22T23:39:59Z",
    body: "must not appear"
  }
]' >"$releases_file"

PATH="${fake_bin}:$PATH" \
  GITHUB_REPOSITORY=okou-ai/okou \
  MOCK_RELEASES_FILE="$releases_file" \
  "$TARGET" "$body_file" "$target_commit" "$rollback_url" \
  "$(release_tags_for_target "$target_commit")" >"$output_file"

grep -Fqx -- "[Rollback Runner and API](${rollback_url})" "$output_file"
grep -Fqx -- "App Worker versions are rolled back manually in Cloudflare." "$output_file"
grep -Fqx -- "<summary>07-23-2026 07:39:40 SGT</summary>" "$output_file"
grep -Fqx -- "* RevertId: \`${target_commit}\`" "$output_file"
grep -Fqx -- "* PDT 07-22-2026 16:39:40" "$output_file"
grep -Fqx -- "### [app](https://github.com/okou-ai/okou/releases/tag/app-v0.618.0): \`0.618.0\`" "$output_file"
grep -Fqx -- "### [api](https://github.com/okou-ai/okou/releases/tag/api-v1.303.0): \`1.303.0\`" "$output_file"
grep -Fqx -- "### [runner-rs](https://github.com/okou-ai/okou/releases/tag/runner-rs-v0.147.2): \`0.147.2\`" "$output_file"
grep -Fqx -- "### [okou-desktop](https://github.com/okou-ai/okou/releases/tag/okou-desktop-v0.618.0): \`0.618.0\`" "$output_file"
grep -Fqx -- "### [core](https://github.com/okou-ai/okou/releases/tag/core-v8.452.0): \`8.452.0\`" "$output_file"
grep -Fqx -- "### [zeta](https://github.com/okou-ai/okou/releases/tag/zeta-v2.0.0): \`2.0.0\`" "$output_file"
grep -Fqx -- "<summary>07-22-2026 07:39:39 SGT</summary>" "$output_file"
grep -Fqx -- "* RevertId: \`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\`" "$output_file"
grep -Fqx -- "* PDT 07-21-2026 16:39:39" "$output_file"
grep -Fqx -- "### [legacy-app](https://example.test/legacy-app): \`1.0.0\`" "$output_file"
grep -Fqx -- "### [legacy-core](https://example.test/legacy-core): \`2.0.0\`" "$output_file"
if grep -Eq 'Change Log|app feature|api feature|runner improvement|zeta feature|retained fix|Signed and notarized' "$output_file"; then
  fail "dashboard should link to releases without copying release notes"
fi

revert_id_line=$(grep -n -F "* RevertId: \`${target_commit}\`" "$output_file" | cut -d: -f1)
pdt_line=$(grep -n -F "* PDT 07-22-2026 16:39:40" "$output_file" | cut -d: -f1)
if ! [ "$revert_id_line" -lt "$pdt_line" ]; then
  fail "RevertId should appear above Pacific time"
fi

app_line=$(grep -n '^### \[app\]' "$output_file" | cut -d: -f1)
api_line=$(grep -n '^### \[api\]' "$output_file" | cut -d: -f1)
runner_line=$(grep -n '^### \[runner-rs\]' "$output_file" | cut -d: -f1)
core_line=$(grep -n '^### \[core\]' "$output_file" | cut -d: -f1)
okou_desktop_line=$(grep -n '^### \[okou-desktop\]' "$output_file" | cut -d: -f1)
zeta_line=$(grep -n '^### \[zeta\]' "$output_file" | cut -d: -f1)
if ! [ "$app_line" -lt "$api_line" ] || \
  ! [ "$api_line" -lt "$runner_line" ] || \
  ! [ "$runner_line" -lt "$core_line" ] || \
  ! [ "$core_line" -lt "$okou_desktop_line" ] || \
  ! [ "$okou_desktop_line" -lt "$zeta_line" ]; then
  fail "release artifacts are not ordered by production priority"
fi

if grep -Fq 'legacy entry' "$output_file"; then
  fail "legacy dashboard entries were not removed"
fi
if grep -Fq 'must not appear' "$output_file"; then
  fail "release from another target was included"
fi
if grep -Fq '## [0.618.0]' "$output_file"; then
  fail "duplicate release title was not removed"
fi
if grep -Fq 'RollbackId:' "$output_file"; then
  fail "rollback commit should not be visible in entry headings"
fi
if grep -Fq '#### Dependencies' "$output_file" || \
  grep -Fq 'app dependency' "$output_file" || \
  grep -Fq 'core dependency' "$output_file" || \
  grep -Fq 'old dependency' "$output_file" || \
  grep -Fq 'trailing dependency' "$output_file"; then
  fail "dependency-only changelog sections were not removed"
fi
if sed -n '/^### \[core\]/,/^### \[okou-desktop\]/p' "$output_file" |
  grep -Fq '**Change Log**'; then
  fail "dependency-only release retained an empty changelog heading"
fi
if grep -Eq '^<details[[:space:]]+open' "$output_file"; then
  fail "rollback entries should be collapsed by default"
fi
initial_details_count=$(grep -c '^<details>$' "$output_file")
initial_details_end_count=$(grep -c '^</details>$' "$output_file")
if [ "$initial_details_count" -ne "$initial_details_end_count" ]; then
  fail "legacy dashboard migration left an unclosed details block"
fi

write_single_release() {
  local commit=$1
  local published_at=$2
  local body_size=${3:-0}

  jq -n \
    --arg target "$commit" \
    --arg published_at "$published_at" \
    --argjson body_size "$body_size" \
    '[{
      tag_name: "app-v1.2.3",
      target_commitish: $target,
      html_url: "https://example.test/app-v1.2.3",
      published_at: $published_at,
      body: (
        "## [1.2.3](https://example.test/app) (2026-07-22)\n\n### Features\n\n* "
        + ("x" * $body_size)
      )
    }]' >"$releases_file"
}

for digit in 2 3 4 5 6 7 8; do
  commit=$(printf '%040d' "$digit")
  write_single_release "$commit" "2026-07-22T23:39:4${digit}Z"
  PATH="${fake_bin}:$PATH" \
    GITHUB_REPOSITORY=okou-ai/okou \
    MOCK_RELEASES_FILE="$releases_file" \
    "$TARGET" "$output_file" "$commit" "$rollback_url" \
    "$(release_tags_for_target "$commit")" >"${output_file}.next"
  mv "${output_file}.next" "$output_file"
done

entry_count=$(grep -c '^<!-- ROLLBACK_ENTRY_START [0-9a-f]\{40\} -->$' "$output_file")
if [ "$entry_count" -ne 7 ]; then
  fail "expected 7 dashboard entries, found $entry_count"
fi
details_count=$(grep -c '^<details>$' "$output_file")
if [ "$details_count" -ne "$entry_count" ]; then
  fail "expected every dashboard entry to be a collapsible details block"
fi

latest_commit=0000000000000000000000000000000000000008
grep -Fq -- "<!-- ROLLBACK_ENTRY_START ${latest_commit} -->" "$output_file"
if grep -Fq "$target_commit" "$output_file"; then
  fail "oldest dashboard entry was not trimmed"
fi

write_single_release "$latest_commit" "2026-07-22T23:39:48Z"
PATH="${fake_bin}:$PATH" \
  GITHUB_REPOSITORY=okou-ai/okou \
  MOCK_RELEASES_FILE="$releases_file" \
  "$TARGET" "$output_file" "$latest_commit" "$rollback_url" \
  "$(release_tags_for_target "$latest_commit")" >"${output_file}.next"
duplicate_count=$(grep -c "ROLLBACK_ENTRY_START ${latest_commit}" "${output_file}.next")
if [ "$duplicate_count" -ne 1 ]; then
  fail "duplicate target commit was not collapsed"
fi

printf '%s\n' \
  'This issue is automatically maintained by CI. Do not edit manually.' \
  '<!-- ROLLBACK_ENTRIES_START -->' \
  '<!-- ROLLBACK_ENTRIES_END -->' >"$body_file"
for digit in 1 2 3 4 5 6 7; do
  commit=$(printf '%040d' "$digit")
  write_single_release "$commit" "2026-07-22T23:40:0${digit}Z" 130000
  PATH="${fake_bin}:$PATH" \
    GITHUB_REPOSITORY=okou-ai/okou \
    MOCK_RELEASES_FILE="$releases_file" \
    "$TARGET" "$body_file" "$commit" "$rollback_url" \
    "$(release_tags_for_target "$commit")" >"${body_file}.next"
  mv "${body_file}.next" "$body_file"
done

body_bytes=$(wc -c <"$body_file")
if [ "$body_bytes" -gt 65000 ]; then
  fail "dashboard body exceeded the safe GitHub issue size"
fi
entry_count=$(grep -c '^<!-- ROLLBACK_ENTRY_START ' "$body_file")
if [ "$entry_count" -ne 7 ]; then
  fail "large release notes should not displace compact rollback history"
fi
if grep -Fq '**Change Log**' "$body_file"; then
  fail "large release notes were copied into the dashboard"
fi
start_count=$entry_count
end_count=$(grep -c '^<!-- ROLLBACK_ENTRY_END -->$' "$body_file")
if [ "$start_count" -ne "$end_count" ]; then
  fail "dashboard size trimming removed a partial entry"
fi
grep -Fq 'ROLLBACK_ENTRY_START 0000000000000000000000000000000000000007' "$body_file"

# Migrate an already-published verbose entry while keeping its rollback metadata.
verbose_history_commit=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
{
  printf '<!-- ROLLBACK_ENTRY_START %s -->\n' "$verbose_history_commit"
  printf '<details>\n<summary>07-23-2026 07:40:00 SGT</summary>\n\n'
  printf '* RevertId: `%s`\n* PDT 07-22-2026 16:40:00\n\n' "$verbose_history_commit"
  printf '### [api](https://example.test/api-v1.0.0): `1.0.0`\n\n**Change Log**\n\n'
  printf '```\n### [not-an-artifact](https://example.test/fake): `9.9.9`\n```\n'
  jq -nr '"history " * 20000'
  printf '</details>\n<!-- ROLLBACK_ENTRY_END -->\n'
} >"$body_file"
write_single_release "$latest_commit" "2026-07-22T23:39:48Z" 130000
PATH="${fake_bin}:$PATH" \
  GITHUB_REPOSITORY=okou-ai/okou \
  MOCK_RELEASES_FILE="$releases_file" \
  "$TARGET" "$body_file" "$latest_commit" "$rollback_url" \
  "$(release_tags_for_target "$latest_commit")" >"$output_file"
grep -Fqx -- '* RevertId: `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`' "$output_file"
grep -Fqx -- '<summary>07-23-2026 07:40:00 SGT</summary>' "$output_file"
grep -Fqx -- '* PDT 07-22-2026 16:40:00' "$output_file"
grep -Fqx -- '### [api](https://example.test/api-v1.0.0): `1.0.0`' "$output_file"
if grep -Eq 'history|Change Log|not-an-artifact' "$output_file"; then
  fail "retained history was not compacted to real rollback metadata"
fi
if [ "$(wc -c <"$output_file")" -ge 2000 ]; then
  fail "compact entries should not grow with current or historical release notes"
fi

# The byte limit still trims complete old entries if metadata itself is large.
long_url=$(jq -nr '"https://example.test/" + ("x" * 12000)')
for digit in 1 2 3 4 5 6 7; do
  commit=$(printf '%040d' "$digit")
  write_single_release "$commit" "2026-07-22T23:40:0${digit}Z"
  jq --arg url "$long_url" '.[0].html_url = $url' "$releases_file" >"${releases_file}.next"
  mv "${releases_file}.next" "$releases_file"
  PATH="${fake_bin}:$PATH" \
    GITHUB_REPOSITORY=okou-ai/okou \
    MOCK_RELEASES_FILE="$releases_file" \
    "$TARGET" "$body_file" "$commit" "$rollback_url" \
    "$(release_tags_for_target "$commit")" >"${body_file}.next"
  mv "${body_file}.next" "$body_file"
done
if [ "$(wc -c <"$body_file")" -gt 65000 ]; then
  fail "metadata trimming exceeded the issue byte limit"
fi
entry_count=$(grep -c '^<!-- ROLLBACK_ENTRY_START ' "$body_file")
if [ "$entry_count" -ge 7 ] || \
  [ "$entry_count" -ne "$(grep -c '^<!-- ROLLBACK_ENTRY_END -->$' "$body_file")" ]; then
  fail "metadata trimming should remove complete old entries"
fi
grep -Fq 'ROLLBACK_ENTRY_START 0000000000000000000000000000000000000007' "$body_file"

jq -n '[{
  tag_name: "app-v1.2.3",
  target_commitish: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  html_url: "https://example.test/app-v1.2.3",
  published_at: "2026-07-22T23:40:00Z",
  body: "other target"
}]' >"$releases_file"
if PATH="${fake_bin}:$PATH" \
  GITHUB_REPOSITORY=okou-ai/okou \
  MOCK_RELEASES_FILE="$releases_file" \
  "$TARGET" "$body_file" "$target_commit" "$rollback_url" \
  "$(release_tags_from_file)" \
  >"${tmp_dir}/missing.out" 2>"${tmp_dir}/missing.err"; then
  fail "missing release artifacts should fail"
fi
grep -Fq "Release artifacts do not all target ${target_commit}" "${tmp_dir}/missing.err"

if PATH="${fake_bin}:$PATH" \
  GITHUB_REPOSITORY=okou-ai/okou \
  MOCK_RELEASES_FILE="$releases_file" \
  MOCK_RETURNED_RELEASE_TAG=other-v1.2.3 \
  "$TARGET" "$body_file" \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "$rollback_url" \
  '["app-v1.2.3"]' \
  >"${tmp_dir}/wrong-tag.out" 2>"${tmp_dir}/wrong-tag.err"; then
  fail "mismatched release tag should fail"
fi
grep -Fq \
  "Release artifacts do not match the requested release tags" \
  "${tmp_dir}/wrong-tag.err"

for invalid_release_tags in \
  '[]' \
  '[123]' \
  '["not-a-version-tag"]' \
  '["app-v1.2.3","app-v1.2.3"]' \
  'not-json'; do
  if PATH="${fake_bin}:$PATH" \
    GITHUB_REPOSITORY=okou-ai/okou \
    MOCK_RELEASES_FILE="$releases_file" \
    "$TARGET" "$body_file" "$target_commit" "$rollback_url" \
    "$invalid_release_tags" \
    >"${tmp_dir}/invalid-tags.out" 2>"${tmp_dir}/invalid-tags.err"; then
    fail "invalid release tag input should fail"
  fi
  grep -Fq \
    "release tags must be a non-empty JSON array of unique version tags" \
    "${tmp_dir}/invalid-tags.err"
done

if PATH="${fake_bin}:$PATH" \
  GITHUB_REPOSITORY=okou-ai/okou \
  MOCK_RELEASES_FILE="$releases_file" \
  "$TARGET" "$body_file" "$target_commit" "$rollback_url" \
  '["app-v1.2.3","missing-v1.0.0"]' \
  >"${tmp_dir}/unavailable.out" 2>"${tmp_dir}/unavailable.err"; then
  fail "partially unavailable release tags should fail"
fi
if [ -s "${tmp_dir}/unavailable.out" ]; then
  fail "partially unavailable release tags produced a partial dashboard"
fi

echo "update-rollback-dashboard-body tests passed"
