#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT
systemctl_binary=$(command -v systemctl)

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

ruby -ryaml - "${repo_root}/ansible/playbooks/cleanup-pr-runner.yml" \
  >"${tmp_dir}/installed-services.sh" <<'RUBY'
play = YAML.load_file(ARGV.fetch(0)).fetch(0)
task = play.fetch("tasks").find { |candidate| candidate["name"] == "Find installed PR runner services" }
puts task.fetch("shell").gsub("{{ job_ref }}", "pr-42")
RUBY

mkdir -p "${tmp_dir}/bin" "${tmp_dir}/root/etc/systemd/system"
cat >"${tmp_dir}/bin/systemctl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [ "${RUNNER_TEST_FAIL_INVENTORY:-false}" = true ]; then
  echo "unit inventory unavailable" >&2
  exit 1
fi
# Query a real, isolated systemd unit inventory without contacting the host bus.
exec "$RUNNER_TEST_SYSTEMCTL" --root="$RUNNER_TEST_SYSTEMD_ROOT" "$@"
SH
chmod +x "${tmp_dir}/bin/systemctl"

cat >"${tmp_dir}/test.service" <<'UNIT'
[Unit]
Description=Runner cleanup inventory test
[Service]
ExecStart=/bin/true
[Install]
WantedBy=multi-user.target
UNIT

for name in unrelated vm0-runner-pr-420-api vm0-runner-pr-43-api; do
  cp "${tmp_dir}/test.service" "${tmp_dir}/root/etc/systemd/system/${name}.service"
done

list_services() {
  PATH="${tmp_dir}/bin:$PATH" \
    RUNNER_TEST_SYSTEMCTL="$systemctl_binary" \
    RUNNER_TEST_SYSTEMD_ROOT="${tmp_dir}/root" \
    RUNNER_TEST_FAIL_INVENTORY="${1:-false}" \
    bash "${tmp_dir}/installed-services.sh"
}

# A directory-only namespace has no installed unit. Its empty inventory must
# allow the playbook to proceed to directory deletion.
if ! services=$(list_services); then
  fail "an empty PR service inventory must allow directory cleanup"
fi
[ -z "$services" ] || fail "empty PR inventory included another namespace"

for lane in api crates; do
  cp "${tmp_dir}/test.service" "${tmp_dir}/root/etc/systemd/system/vm0-runner-pr-42-${lane}.service"
done
services=$(list_services) || fail "failed to list installed PR services"
[ "$services" = $'vm0-runner-pr-42-api.service\nvm0-runner-pr-42-crates.service' ] ||
  fail "service inventory did not select the exact PR namespace: ${services}"

if list_services true >"${tmp_dir}/failure.out" 2>"${tmp_dir}/failure.err"; then
  fail "an unavailable service inventory must prevent cleanup"
fi
grep -q 'unit inventory unavailable' "${tmp_dir}/failure.err" ||
  fail "inventory failures must retain their diagnostic output"

echo "PASS: runner cleanup accepts an empty service inventory and preserves real failures"
