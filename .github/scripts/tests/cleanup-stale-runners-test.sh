#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

fail() {
  echo "FAIL: $1" >&2
  cat "${case_dir}/output.log" >&2
  exit 1
}

# Exercise the workflow entrypoint and its real ownership/lock/cleanup scripts.
# Only GitHub, SSH transport, and Ansible's remote effects are substituted.
ruby -ryaml - "${repo_root}/.github/workflows/cleanup-stale.yml" \
  "${tmp_dir}/select-prs.js" \
  >"${tmp_dir}/cleanup.sh" <<'RUBY'
workflow = YAML.load_file(ARGV.fetch(0))
%w[cleanup-neon-branches cleanup-github-deployments cleanup-git-branches].each do |name|
  unless workflow.fetch("jobs").fetch(name).fetch("if") == "inputs.runner-pr-numbers == ''"
    raise "a scoped runner cleanup must skip #{name}"
  end
end
job = workflow.fetch("jobs").fetch("cleanup-metal-runners")
step = job.fetch("steps").find { |candidate| candidate["name"] == "Cleanup stale runners" }
puts step.fetch("run")
selection = job.fetch("steps").find { |candidate| candidate["name"] == "Select closed runner PRs" }
File.write(ARGV.fetch(1), selection.fetch("with").fetch("script"))
RUBY

node - "${tmp_dir}/select-prs.js" <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const select = new AsyncFunction('github', 'context', 'core', fs.readFileSync(process.argv[2], 'utf8'));

async function selectPRs(requested) {
  const queried = [];
  const outputs = {};
  process.env.PR_NUMBERS = '[41,42,43,44]';
  process.env.RUNNER_PR_NUMBERS = requested;
  await select(
    { rest: { pulls: { get: async ({ pull_number }) => {
      queried.push(pull_number);
      return { data: { state: pull_number === 43 ? 'open' : 'closed' } };
    } } } },
    { repo: { owner: 'vm0-ai', repo: 'vm0' } },
    { setOutput: (name, value) => { outputs[name] = value; } },
  );
  return { queried, numbers: JSON.parse(outputs.numbers), hasPRs: outputs['has-prs'] };
}

(async () => {
  assert.deepEqual(await selectPRs(' 41, 43, 9999 '), {
    queried: [41, 43], numbers: [41], hasPRs: 'true',
  });
  assert.deepEqual(await selectPRs('9999'), {
    queried: [], numbers: [], hasPRs: 'false',
  });
  assert.deepEqual((await selectPRs('')).numbers, [41, 42, 44]);
  for (const invalid of [' ', '0', '41,', '41,bad', '9007199254740992']) {
    await assert.rejects(selectPRs(invalid), /comma-separated positive PR numbers/);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
JS

fake_bin="${tmp_dir}/bin"
mkdir -p "$fake_bin"

cat >"${fake_bin}/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\n' "$*" >>"$MOCK_EXTERNAL_LOG"

endpoint=""
for argument in "$@"; do
  case "$argument" in
    repos/*) endpoint=$argument ;;
  esac
done

case "$endpoint" in
  repos/vm0-ai/vm0/pulls/*)
    pr_number=${endpoint##*/}
    if [[ " $* " == *" --jq .state "* ]]; then
      printf 'closed\n'
    else
      printf 'feature/pr-%s\tvm0-ai/vm0\n' "$pr_number"
    fi
    ;;
  repos/vm0-ai/vm0/actions/runs)
    if [ "$MOCK_BLOCKED_PR" != "0" ] && [[ " $* " == *" status=queued "* ]]; then
      jq -nc --argjson pr "$MOCK_BLOCKED_PR" '[{workflow_runs: [{
        id: 100, name: "Runner Image", status: "queued", event: "pull_request",
        path: ".github/workflows/runner-image.yml", head_sha: "old-head",
        pull_requests: [{number: $pr}], html_url: "https://example.test/runs/100"
      }]}]'
    else
      printf '[{"workflow_runs":[]}]\n'
    fi
    ;;
  repos/vm0-ai/vm0/actions/runs/100)
    printf 'queued\n'
    ;;
  *)
    echo "unexpected gh endpoint: ${endpoint}" >&2
    exit 1
    ;;
esac
SH

cat >"${fake_bin}/ssh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'ssh\n' >>"$MOCK_EXTERNAL_LOG"
remote=$1
remote_command=$2
host=${remote#*@}
lock_file="${MOCK_LOCK_ROOT}/${host}-${JOB_REF}.lock"

# Execute the real remote lock holder locally with an unprivileged lock path.
local_command=${remote_command#sudo }
local_command=${local_command//"/var/lock/vm0-runner-lifecycle-${JOB_REF}.lock"/$lock_file}
exec bash -c "$local_command"
SH

cat >"${fake_bin}/ansible-playbook" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'ansible %s\n' "$*" >>"$MOCK_EXTERNAL_LOG"
job_ref=""
playbook=""
for argument in "$@"; do
  case "$argument" in
    job_ref=*) job_ref=${argument#job_ref=} ;;
    *.yml) playbook=${argument##*/} ;;
  esac
done
[[ "$job_ref" =~ ^pr-[1-9][0-9]*$ ]]

case "$playbook" in
  cleanup-pr-runner.yml)
    # Deletion must happen while the actual lifecycle lock is still held.
    if flock -n "${MOCK_LOCK_ROOT}/metal.example.test-${job_ref}.lock" true; then
      echo "runner cleanup executed without its namespace lock" >&2
      exit 1
    fi
    rm "${MOCK_RESOURCE_ROOT}/${job_ref}/runner"
    ;;
  cleanup-stripe-listener.yml)
    rm "${MOCK_RESOURCE_ROOT}/${job_ref}/stripe"
    ;;
  *)
    echo "unexpected cleanup playbook: ${playbook}" >&2
    exit 1
    ;;
esac
SH
chmod +x "${fake_bin}/gh" "${fake_bin}/ssh" "${fake_bin}/ansible-playbook"

run_cleanup() {
  local scenario=$1 blocked_pr=$2 dry_run=$3
  local pr_number
  case_dir="${tmp_dir}/${scenario}"
  mkdir -p "${case_dir}/locks"
  for pr_number in 41 42 43 44; do
    mkdir -p "${case_dir}/resources/pr-${pr_number}"
    touch "${case_dir}/resources/pr-${pr_number}/runner" \
      "${case_dir}/resources/pr-${pr_number}/stripe"
  done
  : >"${case_dir}/external.log"

  cleanup_status=0
  (
    cd "$repo_root"
    # PR_NUMBER deliberately starts unset, as it does in this workflow step.
    env -i \
      PATH="${fake_bin}:$PATH" \
      HOME="${HOME:-/tmp}" \
      GH_TOKEN=test-token \
      GITHUB_WORKSPACE="$repo_root" \
      GITHUB_REPOSITORY=vm0-ai/vm0 \
      GITHUB_RUN_ID=900 \
      METAL_HOSTS=metal.example.test \
      METAL_USER=runner \
      PR_NUMBERS='[41,42,43]' \
      DRY_RUN="$dry_run" \
      MOCK_BLOCKED_PR="$blocked_pr" \
      MOCK_EXTERNAL_LOG="${case_dir}/external.log" \
      MOCK_RESOURCE_ROOT="${case_dir}/resources" \
      MOCK_LOCK_ROOT="${case_dir}/locks" \
      SUPERSEDED_RUN_COMPLETION_TIMEOUT_SECONDS=0 \
      RUNNER_LIFECYCLE_LOCK_TIMEOUT_SECONDS=5 \
      bash --noprofile --norc -e -o pipefail "${tmp_dir}/cleanup.sh"
  ) >"${case_dir}/output.log" 2>&1 || cleanup_status=$?
}

assert_resources() {
  local pr_number=$1 expected=$2 resource
  for resource in runner stripe; do
    if [ "$expected" = present ]; then
      [ -f "${case_dir}/resources/pr-${pr_number}/${resource}" ] ||
        fail "PR #${pr_number} ${resource} was deleted without cleanup authority"
    else
      [ ! -e "${case_dir}/resources/pr-${pr_number}/${resource}" ] ||
        fail "PR #${pr_number} ${resource} was not cleaned"
    fi
  done
}

run_cleanup blocked-owner 42 false
[ "$cleanup_status" -eq 1 ] || fail "an owner timeout must remain a failed cleanup"
assert_resources 41 absent
assert_resources 42 present
assert_resources 43 absent
assert_resources 44 present
grep -qx 'Cleaned: 2' "${case_dir}/output.log" || fail "missing successful PR count"
grep -qx 'Failures: 1' "${case_dir}/output.log" || fail "missing blocked PR count"
if grep -q '/cancel\|/force-cancel' "${case_dir}/external.log"; then
  fail "closed-PR cleanup attempted to cancel a runner owner"
fi

run_cleanup idle-owners 0 false
[ "$cleanup_status" -eq 0 ] || fail "idle closed PRs should clean successfully"
for pr_number in 41 42 43; do assert_resources "$pr_number" absent; done
assert_resources 44 present
grep -qx 'Cleaned: 3' "${case_dir}/output.log" || fail "missing successful PR count"
grep -qx 'Failures: 0' "${case_dir}/output.log" || fail "idle PR cleanup reported a failure"

run_cleanup dry-run 42 true
[ "$cleanup_status" -eq 0 ] || fail "dry-run should not wait for runner owners"
for pr_number in 41 42 43 44; do assert_resources "$pr_number" present; done
[ ! -s "${case_dir}/external.log" ] || fail "dry-run reached an external cleanup operation"

echo "PASS: stale runner cleanup preserves blocked namespaces and cleans subsequent PRs"
