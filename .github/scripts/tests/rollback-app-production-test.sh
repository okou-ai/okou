#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin" "$work_dir/source"
# Real Git history: incompatible release -> reader preparation -> compatible
# releases -> later policy marker. The marker's own commit must not be the floor.
git -C "$work_dir/source" init -q -b main
git -C "$work_dir/source" config user.email fixture@example.test
git -C "$work_dir/source" config user.name fixture
mkdir -p "$work_dir/source/turbo/apps/platform/src/signals" \
  "$work_dir/source/turbo/packages/core/src" "$work_dir/source/turbo/apps/api/src/lib" \
  "$work_dir/source/.github/scripts/release" "$work_dir/source/.github/rollback-floors"
cp "$repo_root/.github/scripts/release/resolve-app-rollback-target.sh" \
  "$repo_root/.github/scripts/release/rollback-app-production.sh" "$work_dir/source/.github/scripts/release/"
printf '{"version":"0.1025.0"}\n' > "$work_dir/source/turbo/apps/platform/package.json"
printf '{"minimumSupportedVersion":"0.1018.0"}\n' > "$work_dir/source/turbo/apps/api/src/lib/web-client-compatibility.json"
git -C "$work_dir/source" add .
git -C "$work_dir/source" commit -qm 'fixture incompatible release'
old_sha=$(git -C "$work_dir/source" rev-parse HEAD)
git -C "$work_dir/source" tag app-v0.1025.0
# These are target-source inputs, not copies of the validation implementation.
cat > "$work_dir/source/turbo/apps/platform/src/signals/bootstrap.ts" <<'TS'
const routes = [
  { path: ROUTES.settingsTelegram, setup: setupAuthPageWrapper(setupTelegramConnectPage$) },
  { path: ROUTES.telegramConnect, setup: setupAuthPageWrapper(setupTelegramConnectPage$) },
];
TS
cat > "$work_dir/source/turbo/apps/platform/src/signals/route-paths.ts" <<'TS'
const ROUTES = { settingsTelegram: INTEGRATION_SETTINGS_PATHS.telegram, telegramConnect: "/telegram/connect" };
TS
printf 'const paths = { telegram: "/settings/telegram" };\n' > "$work_dir/source/turbo/packages/core/src/integration-routes.ts"
printf '{"version":"0.1027.1"}\n' > "$work_dir/source/turbo/apps/platform/package.json"
git -C "$work_dir/source" add .
git -C "$work_dir/source" commit -qm 'fixture signed reader preparation'
reader_sha=$(git -C "$work_dir/source" rev-parse HEAD)
git -C "$work_dir/source" tag app-v0.1027.1
printf '{"version":"0.1029.0"}\n' > "$work_dir/source/turbo/apps/platform/package.json"
git -C "$work_dir/source" commit -qam 'fixture release'
target_sha=$(git -C "$work_dir/source" rev-parse HEAD)
git -C "$work_dir/source" tag app-v0.1029.0
printf '%s\n' "$reader_sha" > "$work_dir/source/.github/rollback-floors/telegram-settings-app"
printf '{"minimumSupportedVersion":"0.1028.0"}\n' > "$work_dir/source/turbo/apps/api/src/lib/web-client-compatibility.json"
git -C "$work_dir/source" add .
git -C "$work_dir/source" commit -qm 'fixture later main policy and unreleased API floor'
policy_sha=$(git -C "$work_dir/source" rev-parse HEAD)
git -C "$work_dir/source" checkout -qb other "$target_sha"
printf 'branch only\n' > "$work_dir/source/branch-only"
git -C "$work_dir/source" add .
git -C "$work_dir/source" commit -qm 'fixture non-main release'
branch_sha=$(git -C "$work_dir/source" rev-parse HEAD)
git -C "$work_dir/source" checkout -q main
git clone -q "$work_dir/source" "$work_dir/checkout"

# Isolate the actual provider commands; no production credentials or network.
# Unhandled operations fail. Observe HTTP mutations at the provider boundary.
cat > "$work_dir/bin/provider" <<'PY'
#!/usr/bin/env python3
import json
import os
from pathlib import Path
import subprocess
import sys

args = sys.argv[1:]
kind = Path(sys.argv[0]).name
case = os.environ.get("CASE", "accepted")
root = Path(os.environ["FIXTURE_ROOT"])
sha = os.environ["TARGET_COMMIT"]
version = os.environ["APP_VERSION_ID"]
policy = os.environ["POLICY_SHA"]
api_sha = os.environ["API_SHA"]
mutation = root / "mutations.jsonl"
counts_path = root / "counts.json"
counts = json.loads(counts_path.read_text()) if counts_path.exists() else {}
def answer(data):
    print(json.dumps(data))
    sys.exit(0)
def reject():
    print("fixture provider lookup failed", file=sys.stderr)
    sys.exit(22)

deployment = {"id":"22222222-2222-2222-2222-222222222222", "annotations":{"workers/message":"app artifact " + sha}, "versions":[{"version_id":version,"percentage":100}]}
if kind == "gh":
    assert args[0] == "api", args
    path = args[1]
    if case == "github-lookup-failure": reject()
    if "/releases/tags/" in path:
        if case == "unknown-release": reject()
        answer({"tag_name":path.split("/tags/")[1], "target_commitish":policy if case == "release-mismatch" else sha, "draft":False, "prerelease":False, "published_at":"2026-10-15T08:32:24Z"})
    if "/statuses?" in path:
        answer([{"state":"failure" if case == "failed-only" else "success", "environment":"app/production", "log_url":"https://github.com/okou-ai/okou/commit/" + (policy if case == "moving-main-only" else sha) + "/checks"}])
    if "/deployments?" in path:
        # The deployment object's moving-main SHA must NOT supply identity.
        answer([{"id":123,"sha":policy,"environment":"app/production"}])
    raise AssertionError(args)

assert kind == "curl", kind
assert not any("fixture-secret" in arg for arg in args), "credential exposed in arguments"
for i, arg in enumerate(args):
    if arg == "-H" and args[i+1].startswith("@"):
        header = Path(args[i+1][1:])
        assert header.stat().st_mode & 0o077 == 0, "credential file is not private"
url = next(arg for arg in args if arg.startswith("https://"))
if "/workers/scripts/okou-app-production/" in url:
    if "--request" in args:
        assert args[args.index("--request")+1] == "POST"
        assert url.endswith("/deployments"), url
        body = json.loads(Path(args[args.index("--data-binary")+1][1:]).read_text())
        assert body["strategy"] == "percentage"
        assert body["versions"] == [{"version_id":version,"percentage":100}]
        with mutation.open("a") as out: out.write(json.dumps(body)+"\n")
        if case == "mutation-failure": reject()
        answer({"success":case != "mutation-envelope-failure", "result":{"id":deployment["id"]}})
    if "/versions/" in url:
        if case == "cf-lookup-failure": reject()
        counts["version"] = counts.get("version", 0) + 1
        counts_path.write_text(json.dumps(counts))
        if case == "version-disappeared" and counts["version"] > 1: reject()
        annotation = "app artifact " + (policy if case == "annotation-mismatch" else sha)
        if case == "bad-annotation": annotation += " extra"
        answer({"success":True,"result":{"id":version,"annotations":{} if case == "missing-annotation" else {"workers/message":annotation}}})
    if "/deployments" in url:
        if mutation.exists():
            if case == "readback-failure": reject()
            if case == "wrong-readback": deployment["versions"][0]["version_id"] = "33333333-3333-3333-3333-333333333333"
            if case == "split-readback":
                deployment["versions"][0]["percentage"] = 50
                deployment["versions"].append({"version_id":"33333333-3333-3333-3333-333333333333","percentage":50})
        answer({"success":True,"result":{"deployments":[] if case == "no-cf-deployment" else [deployment]}})
    raise AssertionError(url)
if "api.vercel.com" in url:
    if case == "api-lookup-failure": reject()
    if "/aliases/api.okou.ai?" in url:
        counts["alias"] = counts.get("alias",0)+1
        counts_path.write_text(json.dumps(counts))
        if case == "policy-changed" and counts["alias"] == 1:
            source = root / "source"
            (source / ".github/rollback-floors/telegram-settings-app").write_text(policy+"\n")
            subprocess.run(["git","-C",str(source),"commit","-qam","fixture policy changes during validation"],check=True,stdout=subprocess.DEVNULL)
        answer({"alias":"api.okou.ai","projectId":"prj_fixture","deploymentId":"dpl_changed" if case == "api-changed" and counts["alias"] > 1 else "dpl_fixture"})
    if "/deployments/dpl_fixture?" in url:
        answer({"id":"dpl_fixture","projectId":"prj_other" if case == "wrong-api-project" else "prj_fixture", "readyState":"READY", "target":"production", "meta":{"githubCommitOrg":"okou-ai","githubCommitRepo":"okou","githubCommitSha":policy if case == "api-floor-mismatch" else api_sha}})
    raise AssertionError(url)
raise AssertionError(args)
PY
chmod +x "$work_dir/bin/provider"
ln -s provider "$work_dir/bin/curl"
ln -s provider "$work_dir/bin/gh"
export PATH="$work_dir/bin:$PATH" FIXTURE_ROOT="$work_dir" POLICY_SHA="$policy_sha"
export TARGET_COMMIT="$target_sha" APP_VERSION_ID=11111111-1111-1111-1111-111111111111
export CONFIRMED_COMPATIBLE=yes GITHUB_REPOSITORY=okou-ai/okou GH_TOKEN=fixture-secret-gh
export CLOUDFLARE_ACCOUNT_ID=11111111111111111111111111111111 CLOUDFLARE_API_TOKEN=fixture-secret-cf
export VERCEL_ORG_ID=team_fixture VERCEL_PROJECT_ID=prj_fixture VERCEL_TOKEN=fixture-secret-vercel API_SHA="$target_sha"

run_case() {
  local name=$1 expected=$2 expected_mutations=$3
  rm -f "$work_dir/mutations.jsonl" "$work_dir/counts.json"
  local status=0
  (cd "$work_dir/checkout" && CASE="$name" bash .github/scripts/release/rollback-app-production.sh) > "$work_dir/output" 2>&1 || status=$?
  if [[ "$expected" == pass && "$status" != 0 ]] || [[ "$expected" == fail && "$status" == 0 ]]; then
    cat "$work_dir/output" >&2
    echo "Unexpected result: $name ($status)" >&2; exit 1
  fi
  local mutations=0
  if [[ -f "$work_dir/mutations.jsonl" ]]; then mutations=$(wc -l < "$work_dir/mutations.jsonl"); fi
  [[ "$mutations" == "$expected_mutations" ]] || { echo "Unexpected mutations for $name: $mutations" >&2; exit 1; }
  if grep -q fixture-secret "$work_dir/output"; then echo 'Credential leaked' >&2; exit 1; fi
  echo "$name: $expected, mutations=$mutations"
}
run_case accepted pass 1
# 0.1027.1 remains eligible against SERVING 0.1018, despite main's 0.1028.
TARGET_COMMIT="$reader_sha" run_case older-compatible pass 1
TARGET_COMMIT="$reader_sha" run_case api-floor-mismatch fail 0
TARGET_COMMIT="$old_sha" run_case incompatible-0.1025 fail 0
TARGET_COMMIT="$branch_sha" run_case non-main-release fail 0
for scenario in missing-annotation bad-annotation annotation-mismatch unknown-release release-mismatch \
  moving-main-only failed-only no-cf-deployment cf-lookup-failure github-lookup-failure \
  api-lookup-failure wrong-api-project api-changed version-disappeared; do
  run_case "$scenario" fail 0
done
CONFIRMED_COMPATIBLE=no run_case unconfirmed fail 0
for scenario in mutation-failure mutation-envelope-failure wrong-readback split-readback readback-failure; do
  run_case "$scenario" fail 1
done
run_case policy-changed fail 0
# Missing current-main policy must reject even when the checkout still has it.
git -C "$work_dir/source" rm -q .github/rollback-floors/telegram-settings-app
git -C "$work_dir/source" commit -qm 'fixture missing policy'
run_case missing-policy fail 0
# A descendant of the floor still cannot retire the legacy signed reader.
git -C "$work_dir/source" reset -q --hard "$policy_sha"
printf 'const routes = [];\n' > "$work_dir/source/turbo/apps/platform/src/signals/bootstrap.ts"
git -C "$work_dir/source" commit -qam 'fixture removed signed routes'
removed_reader_sha=$(git -C "$work_dir/source" rev-parse HEAD)
TARGET_COMMIT="$removed_reader_sha" run_case removed-reader fail 0
# A valid release record cannot override a mismatched immutable release tag.
git -C "$work_dir/source" reset -q --hard "$policy_sha"
git -C "$work_dir/source" tag -f app-v0.1029.0 "$reader_sha" >/dev/null
run_case mismatched-tag fail 0

echo 'App rollback command tests passed'
