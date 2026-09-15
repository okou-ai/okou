#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
script="${repo_root}/.github/scripts/resolve-production-rollback-target.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

target_commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

cat >"${fake_bin}/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >>"$MOCK_BOUNDARY_LOG"
case "${1:-}" in
  fetch|cat-file) exit 0 ;;
  merge-base)
    if [ "${3:-}" = "c093e0ffdab988d2a8a071809f90d87fa3e79f20" ]; then
      [ "${MOCK_READER_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "febec8a3399be74b0f14a89cb9f42e39dd5ce69f" ]; then
      if [ "${4:-}" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]; then
        [ "${MOCK_BLANK_RUNNER_FLOOR_VALID:-1}" = "1" ]
      else
        [ "${MOCK_BLANK_TARGET_FLOOR_VALID:-1}" = "1" ]
      fi
    elif [ "${3:-}" = "6d391117e4fead19e2105136fb2792a6e77801d8" ]; then
      # The retained Runner predates S1 even when the API target contains it.
      if [ "${4:-}" = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ]; then
        exit 1
      fi
      [ "${MOCK_GOAL_TARGET_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "2c231766e383b651867893852cfb47dcc78af0bd" ]; then
      [ "${4:-}" != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ] &&
        [ "${MOCK_GOAL_SCHEMA_READER_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "077a9a644986e13bed4750796f91e55c4a876aad" ]; then
      [ "${4:-}" != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ] &&
        [ "${MOCK_GOAL_SCHEMA_REPAIR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "669d0befc9a181e44e3f1f9e39093efddabcc0f8" ]; then
      [ "${MOCK_CLIENT_PRODUCT_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "eb2f211a9af41450d0d5dad10c0c8ad12fac0a24" ]; then
      [ "${MOCK_PREPARED_DOMAIN_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "6e1abbb785dc1613d0f5cd1b1dd80fae694abb46" ]; then
      [ "${MOCK_MORNING_BRIEF_ELIGIBILITY_FLOOR_VALID:-1}" = "1" ]
    elif [ "${3:-}" = "8a5e1299b4d26bd114ccec017b84b7a83fb4a164" ]; then
      [ "${MOCK_PERSONAL_SUBSCRIPTION_PRIORITY_FLOOR_VALID:-1}" = "1" ]
    else
      [ "${MOCK_ANCESTRY_VALID:-1}" = "1" ]
    fi
    ;;
  tag)
    printf 'vm0-v1.2.3\n'
    ;;
  show)
    printf '[package]\nversion = "1.2.3"\n'
    ;;
  rev-list)
    printf 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n'
    ;;
  *)
    echo "unexpected git command: $*" >&2
    exit 2
    ;;
esac
SH

cat >"${fake_bin}/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'curl %s\n' "$*" >>"$MOCK_BOUNDARY_LOG"
if [[ "$*" == *"api.vercel.com/v6/deployments"* ]]; then
  jq -n \
    --arg sha "$TARGET_COMMIT" \
    --argjson count "${MOCK_VERCEL_MATCH_COUNT:-1}" \
    '{deployments: [range(0; $count) | {
      meta: {githubCommitSha: $sha},
      state: "READY",
      target: "production",
      url: ("api-" + (tostring) + ".vercel.app")
    }]}'
  exit 0
fi

if [ "${MOCK_RUNNER_ASSETS_VALID:-1}" = "1" ]; then
  jq -n '{assets: [
    {name: "runner-v1.2.3-aarch64-linux"},
    {name: "runner-v1.2.3-x86_64-linux"}
  ]}'
else
  jq -n '{assets: [{name: "runner-v1.2.3-aarch64-linux"}]}'
fi
SH

cat >"${fake_bin}/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'ssh %s\n' "$*" >>"$MOCK_BOUNDARY_LOG"
if [ "${1:-}" = "-n" ]; then shift; fi
remote=$1
host=${remote#*@}
case "$host" in
  arm-1) printf 'aarch64\n' ;;
  x86-1) printf 'x86_64\n' ;;
  *) exit 255 ;;
esac
SH
chmod +x "${fake_bin}/git" "${fake_bin}/curl" "${fake_bin}/ssh"

run_resolver() {
  local output_file=$1
  shift
  : >"$output_file"
  env -i \
    PATH="${fake_bin}:$PATH" \
    HOME="${HOME:-/tmp}" \
    AWS_METAL_RUNNER_HOSTS=arm-1,x86-1 \
    GH_TOKEN=test-github-token \
    GITHUB_OUTPUT="$output_file" \
    GITHUB_REPOSITORY=vm0-ai/vm0 \
    METAL_USER=ci \
    MOCK_BOUNDARY_LOG="${tmp_dir}/boundaries.log" \
    TARGET_COMMIT="$target_commit" \
    VERCEL_ORG_ID=test-org \
    VERCEL_PROJECT_ID=test-project \
    VERCEL_TOKEN=test-vercel-token \
    "$@" \
    bash "$script"
}

assert_failure() {
  local expected_message=$1
  shift
  if "$@" >"${tmp_dir}/failure.out" 2>"${tmp_dir}/failure.err"; then
    fail "expected command to fail: ${expected_message}"
  fi
  grep -q "$expected_message" "${tmp_dir}/failure.err" || fail "missing failure message: ${expected_message}"
}

# A combined-S4-compatible API target must still resolve its valid pre-S1 Runner.
: >"${tmp_dir}/boundaries.log"
output_file="${tmp_dir}/success.output"
run_resolver "$output_file" >"${tmp_dir}/success.log"
grep -Fxq "git merge-base --is-ancestor 8a5e1299b4d26bd114ccec017b84b7a83fb4a164 ${target_commit}" "${tmp_dir}/boundaries.log" || fail "compatible target must pass the accepted personal subscription floor"
grep -qx "target_commit=${target_commit}" "$output_file" || fail "missing target commit output"
grep -qx "api_deployment_url=https://api-0.vercel.app" "$output_file" || fail "missing API deployment output"
grep -qx "runner_version=1.2.3" "$output_file" || fail "missing Runner version output"
grep -qx "runner_tag=runner-rs-v1.2.3" "$output_file" || fail "missing retained Runner tag output"
runner_matrix=$(sed -n 's/^runner_matrix=//p' "$output_file")
jq -e 'length == 2 and .[0].id == "arm64" and .[1].id == "x86_64"' >/dev/null <<<"$runner_matrix" || fail "unexpected Runner matrix"

: >"${tmp_dir}/boundaries.log"
assert_failure "found 0" run_resolver "${tmp_dir}/zero.output" MOCK_VERCEL_MATCH_COUNT=0
[ ! -s "${tmp_dir}/zero.output" ] || fail "failed resolution must not publish outputs"

: >"${tmp_dir}/boundaries.log"
assert_failure "found 2" run_resolver "${tmp_dir}/multiple.output" MOCK_VERCEL_MATCH_COUNT=2
[ ! -s "${tmp_dir}/multiple.output" ] || fail "ambiguous API resolution must not publish outputs"

: >"${tmp_dir}/boundaries.log"
assert_failure "is missing runner-v1.2.3-x86_64-linux" run_resolver "${tmp_dir}/missing-runner.output" MOCK_RUNNER_ASSETS_VALID=0
[ ! -s "${tmp_dir}/missing-runner.output" ] || fail "missing Runner asset must not publish outputs"

invalid_commit=not-a-full-sha
target_commit_before=$target_commit
target_commit=$invalid_commit
: >"${tmp_dir}/boundaries.log"
assert_failure "must be a full lowercase SHA-1" run_resolver "${tmp_dir}/invalid.output"
target_commit=$target_commit_before
[ ! -s "${tmp_dir}/boundaries.log" ] || fail "invalid target must fail before external boundaries"

: >"${tmp_dir}/boundaries.log"
assert_failure \
  "first compatible release is 89c6a521944e2ac8550da424f164db08f4f80f0c" \
  run_resolver \
  "${tmp_dir}/reader-floor.output" \
  MOCK_READER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/reader-floor.output" ] || fail "incompatible reader target must not publish outputs"
if grep -qE '^(curl|aws) ' "${tmp_dir}/boundaries.log"; then
  fail "reader-floor rejection must happen before artifact resolution"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Target commit predates the blank sandbox status reader" \
  run_resolver "${tmp_dir}/blank-target-floor.output" MOCK_BLANK_TARGET_FLOOR_VALID=0
[ ! -s "${tmp_dir}/blank-target-floor.output" ] || fail "old blank reader target must not publish outputs"
if grep -q '^curl ' "${tmp_dir}/boundaries.log"; then
  fail "blank reader target rejection must precede artifact resolution"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Target commit predates the Okou Goal retirement boundary" \
  run_resolver "${tmp_dir}/goal-target-floor.output" \
  MOCK_READER_FLOOR_VALID=1 MOCK_BLANK_TARGET_FLOOR_VALID=1 MOCK_GOAL_TARGET_FLOOR_VALID=0
grep -Fq "first compatible release is 1f68f182a2457ec3aea52d8063be2bd2d2263abd (API 1.571.1)" \
  "${tmp_dir}/failure.err" || fail "Goal rejection must identify the first compatible API release"
[ ! -s "${tmp_dir}/goal-target-floor.output" ] || fail "pre-S1 API target must not publish outputs"
[ ! -s "${tmp_dir}/failure.out" ] || fail "pre-S1 API target must not print resolved targets"
if grep -qE '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "Goal target rejection must precede API and Runner artifact resolution"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Runner release runner-rs-v1.2.3 predates the blank sandbox status reader" \
  run_resolver "${tmp_dir}/blank-runner-floor.output" MOCK_BLANK_RUNNER_FLOOR_VALID=0
[ ! -s "${tmp_dir}/blank-runner-floor.output" ] || fail "old Runner artifact must not publish outputs"
if grep -q 'api.github.com/repos/.*/releases/tags/' "${tmp_dir}/boundaries.log"; then
  fail "blank reader artifact rejection must precede asset resolution"
fi

# S1/S2/S3-only and original-S4-without-repair targets fail before any artifacts.
for floors in "0 0" "1 0" "0 1"; do
  read -r reader repair <<<"$floors"
  : >"${tmp_dir}/boundaries.log"
  assert_failure "lacks the combined S4 Goal schema compatibility boundary" \
    run_resolver "${tmp_dir}/schema-floor.output" \
    MOCK_GOAL_SCHEMA_READER_VALID="$reader" MOCK_GOAL_SCHEMA_REPAIR_VALID="$repair"
  grep -Fq "4a4881bf84cb1d79723fd38c83e00f2215bb1e31 (API 1.580.0)" \
    "${tmp_dir}/failure.err" || fail "schema rejection must identify the verified release"
  [ ! -s "${tmp_dir}/schema-floor.output" ] || fail "unsafe schema target published output"
  [ ! -s "${tmp_dir}/failure.out" ] || fail "unsafe schema target printed resolved targets"
  if grep -qE '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
    fail "schema rejection must precede API and Runner artifact resolution"
  fi
done

# Targets that still declare client_product fail before any artifacts.
: >"${tmp_dir}/boundaries.log"
assert_failure "Target commit predates the computer_use_hosts.client_product drop" \
  run_resolver "${tmp_dir}/client-product-floor.output" MOCK_CLIENT_PRODUCT_FLOOR_VALID=0
grep -Fq "669d0befc9a181e44e3f1f9e39093efddabcc0f8" "${tmp_dir}/failure.err" ||
  fail "client_product rejection must identify the drop commit"
[ ! -s "${tmp_dir}/client-product-floor.output" ] || fail "pre-drop API target must not publish outputs"
[ ! -s "${tmp_dir}/failure.out" ] || fail "pre-drop API target must not print resolved targets"
if grep -qE '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "client_product rejection must precede API and Runner artifact resolution"
fi

# Targets that still declare morning_brief_default_eligible_at fail before any artifacts.
: >"${tmp_dir}/boundaries.log"
assert_failure "Target commit predates the org_members_metadata.morning_brief_default_eligible_at drop" \
  run_resolver "${tmp_dir}/morning-brief-eligibility-floor.output" \
  MOCK_MORNING_BRIEF_ELIGIBILITY_FLOOR_VALID=0
grep -Fq "6e1abbb785dc1613d0f5cd1b1dd80fae694abb46" "${tmp_dir}/failure.err" ||
  fail "morning brief eligibility rejection must identify the drop commit"
[ ! -s "${tmp_dir}/morning-brief-eligibility-floor.output" ] || fail "pre-drop API target must not publish outputs"
[ ! -s "${tmp_dir}/failure.out" ] || fail "pre-drop API target must not print resolved targets"
if grep -qE '^(curl|ssh|git (show|rev-list)) ' "${tmp_dir}/boundaries.log"; then
  fail "morning brief eligibility rejection must precede API and Runner artifact resolution"
fi

release_target_script="${tmp_dir}/resolve-release-target.sh"
ruby -e '
  require "json"
  require "yaml"
  workflow = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  release_job = workflow.fetch("jobs").fetch("release-please")
  release_target_step = release_job.fetch("steps").find { |step| step["id"] == "release-target" }
  raise "missing release target resolver step" unless release_target_step

  resolver_env = release_target_step.fetch("env")
  unless resolver_env.keys == ["RELEASE_SHAS"]
    raise "release target resolver environment must contain only RELEASE_SHAS"
  end

  projection = resolver_env.fetch("RELEASE_SHAS")
  projected_paths = projection.scan(/steps\.release\.outputs\[\x27([^\x27]+)--sha\x27\]/).flatten
  output_reference_count = projection.scan(/steps\.release\.outputs/).length
  unless output_reference_count == projected_paths.length
    raise "release bodies, changelogs, and complete outputs must not enter the release target resolver environment"
  end

  configured_paths = JSON.parse(File.read(ARGV[1])).fetch("packages").keys
  missing_paths = configured_paths - projected_paths
  unknown_paths = projected_paths - configured_paths
  duplicate_paths = projected_paths.group_by(&:itself).select { |_, paths| paths.length > 1 }.keys
  unless missing_paths.empty? && unknown_paths.empty? && duplicate_paths.empty?
    raise "release SHA projection mismatch: missing=#{missing_paths.sort}, unknown=#{unknown_paths.sort}, duplicates=#{duplicate_paths.sort}"
  end

  puts release_target_step.fetch("run")
' \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/release-please-config.json" \
  >"$release_target_script"

release_target=cccccccccccccccccccccccccccccccccccccccc
release_target_output="${tmp_dir}/release-target.output"
RELEASE_SHAS="$(jq -nc --arg target "$release_target" '[null, "", $target, null]')" \
  GITHUB_OUTPUT="$release_target_output" \
  bash "$release_target_script"
grep -qx "sha=${release_target}" "$release_target_output" || fail "release target resolver did not publish the unique release SHA"

missing_release_target_output="${tmp_dir}/missing-release-target.output"
assert_failure \
  "release-please returned no release SHA" \
  env \
  RELEASE_SHAS='["", ""]' \
  GITHUB_OUTPUT="$missing_release_target_output" \
  bash "$release_target_script"
[ ! -s "$missing_release_target_output" ] || fail "missing release SHA must not publish an output"

invalid_release_target_output="${tmp_dir}/invalid-release-target.output"
assert_failure \
  "release-please returned invalid release SHA" \
  env \
  RELEASE_SHAS='["cccccccccccccccccccccccccccccccccccccccc", "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"]' \
  GITHUB_OUTPUT="$invalid_release_target_output" \
  bash "$release_target_script"
[ ! -s "$invalid_release_target_output" ] || fail "invalid release SHA must not publish an output"

multiple_release_targets=$(jq -nc '[
  "cccccccccccccccccccccccccccccccccccccccc",
  "dddddddddddddddddddddddddddddddddddddddd"
]')
multiple_release_target_output="${tmp_dir}/multiple-release-target.output"
assert_failure \
  "release-please returned multiple release SHAs" \
  env \
  RELEASE_SHAS="$multiple_release_targets" \
  GITHUB_OUTPUT="$multiple_release_target_output" \
  bash "$release_target_script"
[ ! -s "$multiple_release_target_output" ] || fail "ambiguous release SHAs must not publish an output"

release_tags_script="${tmp_dir}/resolve-release-tags.sh"
ruby -e '
  require "json"
  require "yaml"
  workflow = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  release_job = workflow.fetch("jobs").fetch("release-please")
  release_tags_step = release_job.fetch("steps").find { |step| step["id"] == "release-tags" }
  raise "missing current release tag resolver step" unless release_tags_step

  resolver_env = release_tags_step.fetch("env")
  unless resolver_env.keys == ["RELEASE_TAGS", "DESKTOP_RELEASE_CREATED", "DESKTOP_VERSION"]
    raise "release tag resolver environment has unexpected inputs"
  end

  projection = resolver_env.fetch("RELEASE_TAGS")
  projected_paths = projection.scan(/steps\.release\.outputs\[\x27([^\x27]+)--tag_name\x27\]/).flatten
  output_reference_count = projection.scan(/steps\.release\.outputs/).length
  unless output_reference_count == projected_paths.length
    raise "release bodies, changelogs, and complete outputs must not enter the release tag resolver environment"
  end

  configured_paths = JSON.parse(File.read(ARGV[1])).fetch("packages").keys
  missing_paths = configured_paths - projected_paths
  unknown_paths = projected_paths - configured_paths
  duplicate_paths = projected_paths.group_by(&:itself).select { |_, paths| paths.length > 1 }.keys
  unless missing_paths.empty? && unknown_paths.empty? && duplicate_paths.empty?
    raise "release tag projection mismatch: missing=#{missing_paths.sort}, unknown=#{unknown_paths.sort}, duplicates=#{duplicate_paths.sort}"
  end

  desktop_release_created = "$" + "{{ steps.release.outputs[\x27turbo/apps/desktop--release_created\x27] }}"
  desktop_version = "$" + "{{ steps.release.outputs[\x27turbo/apps/desktop--version\x27] }}"
  unless resolver_env.fetch("DESKTOP_RELEASE_CREATED") == desktop_release_created &&
      resolver_env.fetch("DESKTOP_VERSION") == desktop_version
    raise "release tag resolver must derive the Okou Desktop tag from the Desktop release outputs"
  end

  puts release_tags_step.fetch("run")
' \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/release-please-config.json" \
  >"$release_tags_script"

release_tags_output="${tmp_dir}/release-tags.output"
RELEASE_TAGS='[null,"","api-v1.2.3","app-v4.5.6"]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$release_tags_output" \
  bash "$release_tags_script"
grep -Fqx 'tags=["api-v1.2.3","app-v4.5.6"]' "$release_tags_output" || \
  fail "release tag resolver did not publish the current release tags"

desktop_release_tags_output="${tmp_dir}/desktop-release-tags.output"
RELEASE_TAGS='["desktop-v4.5.6"]' \
  DESKTOP_RELEASE_CREATED=true \
  DESKTOP_VERSION=4.5.6 \
  GITHUB_OUTPUT="$desktop_release_tags_output" \
  bash "$release_tags_script"
grep -Fqx 'tags=["desktop-v4.5.6","okou-desktop-v4.5.6"]' "$desktop_release_tags_output" || \
  fail "release tag resolver did not publish the derived Okou Desktop tag"

missing_release_tags_output="${tmp_dir}/missing-release-tags.output"
assert_failure \
  "release-please returned no release tag" \
  env \
  RELEASE_TAGS='[null,""]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$missing_release_tags_output" \
  bash "$release_tags_script"
[ ! -s "$missing_release_tags_output" ] || fail "missing release tags must not publish an output"

non_string_release_tags_output="${tmp_dir}/non-string-release-tags.output"
assert_failure \
  "release-please returned non-string release tag" \
  env \
  RELEASE_TAGS='["api-v1.2.3",123]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$non_string_release_tags_output" \
  bash "$release_tags_script"
[ ! -s "$non_string_release_tags_output" ] || fail "non-string release tags must not publish an output"

invalid_release_tags_output="${tmp_dir}/invalid-release-tags.output"
assert_failure \
  "release-please returned invalid release tag" \
  env \
  RELEASE_TAGS='["not-a-version-tag"]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$invalid_release_tags_output" \
  bash "$release_tags_script"
[ ! -s "$invalid_release_tags_output" ] || fail "invalid release tags must not publish an output"

duplicate_release_tags_output="${tmp_dir}/duplicate-release-tags.output"
assert_failure \
  "release-please returned duplicate release tags: api-v1.2.3" \
  env \
  RELEASE_TAGS='["api-v1.2.3","api-v1.2.3"]' \
  DESKTOP_RELEASE_CREATED='' \
  DESKTOP_VERSION='' \
  GITHUB_OUTPUT="$duplicate_release_tags_output" \
  bash "$release_tags_script"
[ ! -s "$duplicate_release_tags_output" ] || fail "duplicate release tags must not publish an output"

ruby - \
  "${repo_root}/.github/workflows/rollback-production.yml" \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/.github/workflows/turbo.yml" <<'RUBY'
  require "yaml"
  rollback_config = YAML.safe_load(File.read(ARGV[0]), aliases: true)
  release_config = YAML.safe_load(File.read(ARGV[1]), aliases: true)
  turbo_config = YAML.safe_load(File.read(ARGV[2]), aliases: true)
  raise "rollback must not use lossy GitHub concurrency" if rollback_config.key?("concurrency")
  raise "release must not use lossy GitHub concurrency" if release_config.key?("concurrency")
  rollback = rollback_config.fetch("jobs")
  release = release_config.fetch("jobs")
  turbo = turbo_config.fetch("jobs")
  canonical_api_backend_source = "$" + "{{ vars.OKOU_API_BACKEND_URL }}"
  release_api_step = release.fetch("promote-api-production").fetch("steps").find do |step|
    step["name"] == "Resolve API production environment"
  end
  raise "missing release API production environment step" unless release_api_step
  release_runner_step = release.fetch("build-runner-production").fetch("steps").find do |step|
    step["name"] == "Build rootfs and snapshot on production hosts"
  end
  raise "missing release Runner build step" unless release_runner_step
  rollback_runner_step = rollback.fetch("rollback-runner").fetch("steps").find do |step|
    step["name"] == "Roll back Runner on production hosts"
  end
  raise "missing production Runner rollback step" unless rollback_runner_step

  selected_api_backend_sources = [
    release_api_step.fetch("with").fetch("api-backend-url"),
    release_runner_step.fetch("env").fetch("API_URL"),
    rollback_runner_step.fetch("env").fetch("API_URL"),
  ]
  unless selected_api_backend_sources == Array.new(3, canonical_api_backend_source)
    raise "production API backend sources must use only the canonical GitHub variable"
  end

  neutral_api_url = "$" + "{API_URL}"
  {
    "release Runner build" => release_runner_step,
    "production Runner rollback" => rollback_runner_step,
  }.each do |boundary, step|
    env = step.fetch("env")
    if env.key?("OKOU_API_BACKEND_URL")
      raise "#{boundary} must retain the neutral API_URL shell boundary"
    end
    unless step.fetch("run").include?("-e \"api_url=#{neutral_api_url}\"")
      raise "#{boundary} must retain the neutral Ansible api_url input"
    end
  end
  raise "rollback resolver must wait for queue" unless rollback.fetch("resolve-target").fetch("needs") == "queue-production-deploy"
  raise "Runner must wait for resolver" unless rollback.fetch("rollback-runner").fetch("needs") == "resolve-target"
  raise "API must wait for resolver" unless rollback.fetch("rollback-api").fetch("needs") == "resolve-target"
  release_job = release.fetch("release-please")
  release_needs = Array(release_job.fetch("needs"))
  raise "release must wait for production queue" unless release_needs.include?("queue-production-deploy")
  raise "release must wait for release detection" unless release_needs.include?("detect-release-commit")
  queue_needs = Array(release.fetch("queue-production-deploy").fetch("needs"))
  raise "production queue must wait for release detection" unless queue_needs.include?("detect-release-commit")
  release_target_output = "$" + "{{ steps.release-target.outputs.sha }}"
  raise "release job must expose the resolved release target" unless release_job.fetch("outputs").fetch("release_target") == release_target_output
  release_tags_output = "$" + "{{ steps.release-tags.outputs.tags }}"
  raise "release job must expose the current release tags" unless release_job.fetch("outputs").fetch("release_tags") == release_tags_output
  raise "release workflow must not use the triggering workflow SHA as a release target" if File.read(ARGV[1]).include?("github.event.workflow_run.head_sha")

  expected_target = "$" + "{{ needs.release-please.outputs.release_target }}"
  expected_tags = "$" + "{{ needs.release-please.outputs.release_tags }}"
  workflow_source = "$" + "{{ github.sha }}"
  checkout_ref_exceptions = {
    "queue-production-deploy" => "main",
    "refresh-release-pull-request" => "main",
    "update-rollback-dashboard" => workflow_source,
  }
  release.each do |job_name, job|
    checkout_steps = job.fetch("steps", []).select do |step|
      step["uses"].to_s.start_with?("actions/checkout@")
    end
    checkout_steps.each do |checkout_step|
      expected_ref = checkout_ref_exceptions.fetch(job_name, expected_target)
      actual_ref = checkout_step.fetch("with", {})["ref"]
      unless actual_ref == expected_ref
        raise "#{job_name} checkout must use #{expected_ref.inspect}, got #{actual_ref.inspect}"
      end
    end
  end

  host_worker_step = release.fetch("detect-host-worker-deploy-inputs").fetch("steps").find { |step| step["id"] == "detect" }
  raise "Host Worker detection must use the resolved release target" unless host_worker_step.fetch("run").include?("HEAD_SHA=\"#{expected_target}\"")
  schema_step = release.fetch("deploy-api-schema").fetch("steps").find { |step| step["name"] == "Publish Runtime API Schema" }
  raise "Runtime API Schema must use the resolved release target" unless schema_step.fetch("env").fetch("RELEASE_SHA") == expected_target
  dashboard_step = release.fetch("update-rollback-dashboard").fetch("steps").find { |step| step["name"] == "Update rollback dashboard issue" }
  dashboard_job = release.fetch("update-rollback-dashboard")
  dashboard_needs = Array(dashboard_job.fetch("needs"))
  raise "rollback dashboard must wait for Desktop promotion" unless dashboard_needs.include?("promote-desktop-release")
  dashboard_condition = dashboard_job.fetch("if")
  unless dashboard_condition.include?("needs.release-please.outputs.desktop_release_created != \x27true\x27") &&
      dashboard_condition.include?("needs.promote-desktop-release.result == \x27success\x27")
    raise "rollback dashboard must require successful applicable Desktop promotion"
  end
  raise "rollback dashboard must use the resolved release target" unless dashboard_step.fetch("env").fetch("RELEASE_TARGET") == expected_target
  raise "rollback dashboard must use the current release tags" unless dashboard_step.fetch("env").fetch("RELEASE_TAGS") == expected_tags
  raise "rollback dashboard must pass the current release tags to the helper" unless dashboard_step.fetch("run").include?("\"$RELEASE_TAGS\"")

  artifact_fetch_helper = "fetch-okou-app-artifact.sh"
  release_app_step = release.fetch("promote-app-worker-production").fetch("steps").find { |step| step["id"] == "worker-production" }
  release_app_run = release_app_step.fetch("run")
  raise "release App deployment must use the shared artifact fetcher" unless release_app_run.include?(artifact_fetch_helper)
  raise "release App deployment must not fall back to per-file artifacts" if release_app_run.include?("--recursive")

  artifact_upload_step = turbo.fetch("deploy-app").fetch("steps").find { |step| step["name"] == "Upload canonical app artifact" }
  artifact_upload_run = artifact_upload_step.fetch("run")
  raise "deploy-app must upload the archived App artifact" unless artifact_upload_run.include?("/dist.tar.gz")
  raise "deploy-app must not upload per-file App artifacts" if artifact_upload_run.include?("aws s3 cp turbo/apps/platform/dist")
RUBY
: >"${tmp_dir}/boundaries.log"
assert_failure "first supported release is eb2f211a9af41450d0d5dad10c0c8ad12fac0a24" \
  run_resolver "${tmp_dir}/prepared-domain-floor.output" MOCK_PREPARED_DOMAIN_FLOOR_VALID=0
[ ! -s "${tmp_dir}/prepared-domain-floor.output" ] || fail "unprepared API must not publish outputs"
if grep -qE '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
  fail "prepared writer floor must be checked before artifact resolution"
fi

: >"${tmp_dir}/boundaries.log"
assert_failure "Target commit predates personal subscription priority" \
  run_resolver "${tmp_dir}/personal-priority-floor.output" \
  MOCK_PERSONAL_SUBSCRIPTION_PRIORITY_FLOOR_VALID=0
grep -q '8a5e1299b4d26bd114ccec017b84b7a83fb4a164' "${tmp_dir}/failure.err" || fail "priority rejection must identify B"
[ ! -s "${tmp_dir}/personal-priority-floor.output" ] || fail "pre-B target must not publish outputs"
if grep -Eq '^(curl|ssh) ' "${tmp_dir}/boundaries.log"; then
  fail "priority rejection must precede artifact resolution"
fi

echo "resolve-production-rollback-target tests passed"
