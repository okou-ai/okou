#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
export ANSIBLE_CONFIG="$repo_root/ansible/ansible.cfg" ANSIBLE_NOCOLOR=1
source "$repo_root/.github/scripts/runner/runner-image-target.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
bin_dir="$tmp/bin"
mkdir "$bin_dir"
cp /bin/true "$tmp/release-asset"
cp "$tmp/release-asset" "$tmp/wrong-machine"
printf '\000\000' | dd of="$tmp/wrong-machine" bs=1 seek=18 conv=notrunc status=none
printf 'old bytes still open for writing\n' >"$bin_dir/runner"
exec {stale_writer}<>"$bin_dir/runner"
old_inode=$(stat -c '%i' "$bin_dir/runner")

cat >"$tmp/stage.yml" <<'YAML'
- name: Stage release asset
  hosts: localhost
  gather_facts: false
  tasks:
    - name: Stage runner release asset
      include_tasks: "{{ staging_tasks }}"
YAML

runner_target=$(runner_image_target_for_uname_m "$(uname -m)")
expected_machine=$(runner_image_elf_machine_hex "$runner_target")
stage() {
  ansible-playbook -i localhost, -c local "$tmp/stage.yml" \
    -e "staging_tasks=$repo_root/ansible/tasks/stage-runner-release-asset.yml" \
    -e "bin_dir=$bin_dir" \
    -e "runner_asset_url=file://$1" \
    -e "runner_asset_checksum=sha256:$2" \
    -e "derived_expected_runner_elf_machine=$expected_machine" >"$tmp/ansible.log" 2>&1
}

expect_rejected() {
  if stage "$1" "$2"; then
    echo "expected staging to reject the asset" >&2
    exit 1
  fi
  grep -q "$3" "$tmp/ansible.log"
  [[ $(stat -c '%i' "$bin_dir/runner") == "$old_inode" ]]
  [[ -z $(find "$bin_dir" -name '.runner-stage-*' -print -quit) ]]
}

digest=$(sha256sum "$tmp/release-asset" | cut -d ' ' -f 1)
wrong_machine_digest=$(sha256sum "$tmp/wrong-machine" | cut -d ' ' -f 1)
expect_rejected "$tmp/release-asset" "" 'requires a release asset URL and its published SHA-256'
expect_rejected "$tmp/wrong-machine" "$digest" 'did not match'
expect_rejected "$tmp/wrong-machine" "$wrong_machine_digest" 'Runner ELF mismatch'

stage "$tmp/release-asset" "$digest" || { cat "$tmp/ansible.log"; exit 1; }
new_inode=$(stat -c '%i' "$bin_dir/runner")
[[ "$new_inode" != "$old_inode" ]]
cmp "$tmp/release-asset" "$bin_dir/runner"
"$bin_dir/runner"
exec {stale_writer}>&-

rm "$tmp/release-asset"
chmod 0644 "$bin_dir/runner"
stage "$tmp/release-asset" "$digest" || { cat "$tmp/ansible.log"; exit 1; }
[[ $(stat -c '%i' "$bin_dir/runner") == "$new_inode" ]]
[[ -z $(find "$bin_dir" -name '.runner-stage-*' -print -quit) ]]
"$bin_dir/runner"

rollback_stage() {
  ansible-playbook -i localhost, -c local "$repo_root/ansible/playbooks/rollback-runner.yml" \
    --tags runner-rollback-asset \
    -e "bin_dir=$bin_dir" \
    -e "runner_asset_url=file://$1" \
    -e "runner_asset_checksum=$2" \
    -e "derived_expected_runner_elf_machine=$expected_machine" \
    -e "{\"skip_install\":$3}" >"$tmp/ansible.log" 2>&1
}

# A retained executable needs neither the asset nor its digest.
rollback_stage "$tmp/release-asset" "" false || { cat "$tmp/ansible.log"; exit 1; }
[[ $(stat -c '%i' "$bin_dir/runner") == "$new_inode" ]]

mv "$bin_dir/runner" "$tmp/release-asset"
# Active targets skip artifact preparation altogether.
rollback_stage "$tmp/release-asset" "" true || { cat "$tmp/ansible.log"; exit 1; }
[[ ! -e "$bin_dir/runner" ]]
if rollback_stage "$tmp/release-asset" "" false; then
  echo "expected cold rollback without a digest to fail" >&2
  exit 1
fi
grep -q 'requires a release asset URL and its published SHA-256' "$tmp/ansible.log"
[[ ! -e "$bin_dir/runner" ]]
rollback_stage "$tmp/release-asset" "sha256:$digest" false || { cat "$tmp/ansible.log"; exit 1; }
cmp "$tmp/release-asset" "$bin_dir/runner"
"$bin_dir/runner"
echo "runner release staging Ansible tests passed"
