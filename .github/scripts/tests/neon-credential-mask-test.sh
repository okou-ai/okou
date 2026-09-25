#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

mapfile -t generator_files < <(
  rg \
    --files-with-matches \
    --fixed-strings \
    --glob '*.yml' \
    --glob '*.yaml' \
    'neonctl connection-string' \
    .github/actions \
    .github/workflows |
    sort
)

expected_generator_files=(
  .github/actions/neon-branch/action.yml
  .github/actions/production-migration-smoke/action.yml
  .github/workflows/release-please.yml
  .github/workflows/turbo.yml
)

if [[ ${#generator_files[@]} -ne ${#expected_generator_files[@]} ]]; then
  fail "Neon generator inventory changed"
fi

for index in "${!expected_generator_files[@]}"; do
  if [[ "${generator_files[$index]}" != "${expected_generator_files[$index]}" ]]; then
    fail "Neon generator inventory changed"
  fi
done

mapfile -t invocations < <(
  rg \
    --line-number \
    --no-heading \
    --fixed-strings \
    'neonctl connection-string' \
    "${generator_files[@]}"
)

if [[ ${#invocations[@]} -ne 8 ]]; then
  fail "expected eight reviewed Neon connection-string invocations"
fi

mapfile -t raw_mask_variables <<'VARIABLES'
$DATABASE_URL
${DATABASE_URL}
$PARENT_DATABASE_URL
${PARENT_DATABASE_URL}
$database_url
${database_url}
VARIABLES

for variable in "${raw_mask_variables[@]}"; do
  if rg --quiet --fixed-strings "::add-mask::$variable" "${generator_files[@]}"; then
    fail "generated database URLs must not be passed directly to add-mask"
  fi
done

if rg --quiet --fixed-strings 'DATABASE_URL value:' "${generator_files[@]}"; then
  fail "generated database URLs must not be logged"
fi

mapfile -t raw_database_url_emissions < <(
  for file in "${generator_files[@]}"; do
    awk -v file="$file" '
      /^[[:space:]]*(echo|printf)[[:space:]]/ &&
      (index($0, "$DATABASE_URL") > 0 ||
       index($0, "${DATABASE_URL}") > 0 ||
       index($0, "$PARENT_DATABASE_URL") > 0 ||
       index($0, "${PARENT_DATABASE_URL}") > 0 ||
       index($0, "$database_url") > 0 ||
       index($0, "${database_url}") > 0) {
        sub(/^[[:space:]]+/, "")
        print file ":" $0
      }
    ' "$file"
  done
)

mapfile -t expected_raw_database_url_emissions <<'EMISSIONS'
.github/actions/neon-branch/action.yml:echo "database-url=$DATABASE_URL" >> "$GITHUB_OUTPUT"
.github/actions/production-migration-smoke/action.yml:echo "database-url=$DATABASE_URL" >> "$GITHUB_OUTPUT"
.github/workflows/release-please.yml:echo "database-url=$DATABASE_URL" >> "$GITHUB_OUTPUT"
.github/workflows/turbo.yml:echo "database-url=$DATABASE_URL" >> "$GITHUB_OUTPUT"
EMISSIONS

if [[ ${#raw_database_url_emissions[@]} -ne ${#expected_raw_database_url_emissions[@]} ]]; then
  fail "generated database URLs must only be written to reviewed outputs"
fi

for index in "${!expected_raw_database_url_emissions[@]}"; do
  if [[ "${raw_database_url_emissions[$index]}" != "${expected_raw_database_url_emissions[$index]}" ]]; then
    fail "generated database URLs must only be written to reviewed outputs"
  fi
done

assert_ordered() {
  local file="$1"
  local boundary="$2"
  shift 2

  local previous_line=0
  local pattern
  for pattern in "$@"; do
    local matches
    matches="$(rg --line-number --no-heading --fixed-strings -- "$pattern" "$file")" || matches=""

    local line
    line="$(awk -F: -v previous="$previous_line" '$1 > previous { print $1; exit }' <<< "$matches")"
    if [[ -z "$line" ]]; then
      fail "$boundary is missing an ordered credential boundary line: $pattern"
    fi
    previous_line="$line"
  done
}

cr_escape_pattern="WORKFLOW_COMMAND_DATA=\"\${WORKFLOW_COMMAND_DATA//\$'\\r'/%0D}\""
lf_escape_pattern="WORKFLOW_COMMAND_DATA=\"\${WORKFLOW_COMMAND_DATA//\$'\\n'/%0A}\""
mask_pattern="printf '::add-mask::%s\\n' \"\$WORKFLOW_COMMAND_DATA\""

assert_boundary() {
  local file="$1"
  local boundary="$2"
  local variable="$3"
  local resolution_pattern="$4"
  local consumer_pattern="$5"
  local percent_escape_pattern
  printf -v percent_escape_pattern "WORKFLOW_COMMAND_DATA=\"\${%s//%%/%%25}\"" "$variable"

  assert_ordered \
    "$file" \
    "$boundary" \
    "$resolution_pattern" \
    "$percent_escape_pattern" \
    "$cr_escape_pattern" \
    "$lf_escape_pattern" \
    "$mask_pattern" \
    "$consumer_pattern"
}

while IFS='|' read -r file boundary variable resolution_pattern consumer_pattern; do
  assert_boundary "$file" "$boundary" "$variable" "$resolution_pattern" "$consumer_pattern"
done <<'BOUNDARIES'
.github/actions/neon-branch/action.yml|Neon branch action|DATABASE_URL|DATABASE_URL=$(neonctl connection-string "$BRANCH_NAME" --project-id "$NEON_PROJECT_ID" --database-name "$INPUT_DATABASE_NAME" --role-name "$INPUT_ROLE_NAME" --ssl verify-full)|echo "database-url=$DATABASE_URL" >> "$GITHUB_OUTPUT"
.github/actions/production-migration-smoke/action.yml|Production migration smoke action|DATABASE_URL|DATABASE_URL=$(neonctl connection-string "$BRANCH_ID"|echo "database-url=$DATABASE_URL" >> "$GITHUB_OUTPUT"
.github/workflows/turbo.yml|Turbo parent database|PARENT_DATABASE_URL|PARENT_DATABASE_URL=$(neonctl connection-string --project-id "$NEON_PROJECT_ID" --database-name neondb --role-name neondb_owner --ssl verify-full)|(cd turbo && DATABASE_URL="$PARENT_DATABASE_URL" pnpm -F @okouai/db db:migrate)
.github/workflows/turbo.yml|Turbo preview database|DATABASE_URL|DATABASE_URL=$(neonctl connection-string "$BRANCH_NAME" --project-id "$NEON_PROJECT_ID" --database-name neondb --role-name neondb_owner --ssl verify-full)|DATABASE_URL="$DATABASE_URL" pnpm -F @okouai/db db:migrate
.github/workflows/release-please.yml|Production release database|DATABASE_URL|DATABASE_URL=$(neonctl connection-string production|echo "database-url=$DATABASE_URL" >> "$GITHUB_OUTPUT"
BOUNDARIES

mapfile -t release_shell_patterns <<'PATTERNS'
- name: Get Production Database URL
shell: bash
DATABASE_URL=$(neonctl connection-string production
PATTERNS
assert_ordered \
  .github/workflows/release-please.yml \
  'Production release database shell' \
  "${release_shell_patterns[@]}"

echo "Neon credential masking checks passed (8 invocations, 5 resolved values)"
