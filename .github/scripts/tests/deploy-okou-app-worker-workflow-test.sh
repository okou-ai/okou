#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

bash -n "${repo_root}/.github/scripts/verify-okou-production-domains.sh"

python3 - \
  "${repo_root}/.github/workflows/release-please.yml" \
  "${repo_root}/.github/workflows/rollback-production.yml" \
  "${repo_root}/.github/scripts/verify-okou-production-domains.sh" \
  "${repo_root}/turbo/apps/app-worker/wrangler.jsonc" \
  "${repo_root}/.github/workflows/turbo.yml" << 'PY'
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile

import yaml


def load_workflow(path: str) -> tuple[dict[str, object], str]:
    source = Path(path).read_text()
    return yaml.safe_load(source), source


def find_step(job: dict[str, object], name: str) -> dict[str, object]:
    steps = job["steps"]
    if not isinstance(steps, list):
        raise RuntimeError(f"job steps are not a list: {name}")
    for step in steps:
        if isinstance(step, dict) and step.get("name") == name:
            return step
    raise RuntimeError(f"missing workflow step: {name}")


def require_fragments(step: dict[str, object], fragments: list[str]) -> str:
    source = step.get("run")
    if not isinstance(source, str):
        raise RuntimeError(f"step has no run source: {step.get('name')}")
    for fragment in fragments:
        if fragment not in source:
            raise RuntimeError(
                f"step {step.get('name')} is missing deployment input: {fragment}"
            )
    return source


release, _release_source = load_workflow(sys.argv[1])
rollback, _rollback_source = load_workflow(sys.argv[2])
production_verifier_source = Path(sys.argv[3]).read_text()
worker_config_source = Path(sys.argv[4]).read_text()
turbo, _turbo_source = load_workflow(sys.argv[5])

# The public static origin needs public same-zone fetch compatibility.
if '"global_fetch_strictly_public"' not in worker_config_source:
    raise RuntimeError("app Worker must allow public same-zone fetches")
# The shell is embedded in the Worker, not served by the Workers Assets service.
if '"assets"' in worker_config_source:
    raise RuntimeError("app Worker shell must not depend on the Workers Assets service")

release_jobs = release["jobs"]
rollback_jobs = rollback["jobs"]
release_controller_job = release_jobs["release-please"]
worker_release_job = release_jobs["promote-app-worker-production"]
host_worker_release_job = release_jobs["deploy-host-worker-production"]
if "promote-app-worker-production" not in host_worker_release_job["needs"]:
    raise RuntimeError("Host Worker recovery routes must wait for the App deployment")
for fragment in (
    "needs.release-please.outputs.app_deploy_required != 'true'",
    "needs.promote-app-worker-production.result == 'success'",
):
    if fragment not in host_worker_release_job["if"]:
        raise RuntimeError(f"Host Worker App dependency is missing: {fragment}")
release_dashboard_job = release_jobs["update-rollback-dashboard"]
rollback_verification_job = rollback_jobs["verify-production-domains"]

# App rollback has a distinct queue-dependent branch. API/Runner jobs retain
# their normal dependencies, so a skipped resolver cannot reach SSH/mutations.
inputs = rollback[True]["workflow_dispatch"]["inputs"]
assert inputs["component"]["default"] == "api-runner"
assert inputs["component"]["options"] == ["api-runner", "app"]
assert inputs["confirmed_compatible"]["default"] == "no"
assert rollback_jobs["resolve-target"]["if"] == "inputs.component != 'app'"
assert rollback_jobs["rollback-app"]["if"] == "inputs.component == 'app'"
for job_id in ("rollback-app", "resolve-target"):
    assert rollback_jobs[job_id]["needs"] == "queue-production-deploy"
    assert rollback_jobs[job_id]["environment"] == "production"
for job_id in ("rollback-api", "rollback-runner"):
    assert rollback_jobs[job_id]["needs"] == "resolve-target"
    assert "if" not in rollback_jobs[job_id]  # retain success() dependency gating
app_rollback = rollback_jobs["rollback-app"]
assert len(app_rollback["steps"]) == 2
checkout, execute = app_rollback["steps"]
assert checkout["with"] == {"fetch-depth": 0, "ref": "main"}
assert execute["run"] == "bash .github/scripts/release/rollback-app-production.sh"
assert execute["env"]["CONFIRMED_COMPATIBLE"] == "${{ inputs.confirmed_compatible }}"
assert execute["env"]["APP_VERSION_ID"] == "${{ inputs.app_version_id }}"
assert execute["env"]["TARGET_COMMIT"] == "${{ inputs.target_commit }}"
assert not any("SSH" in key or "RUNNER" in key for key in execute["env"])
assert not any("continue-on-error" in step for step in app_rollback["steps"])

expected_needs = ["release-please", "builds-complete", "promote-api-production"]
if worker_release_job.get("needs") != expected_needs:
    raise RuntimeError("the production Worker must wait for App builds and API production")
worker_condition = str(worker_release_job.get("if", ""))
for fragment in (
    "needs.release-please.outputs.app_deploy_required == 'true'",
    "needs.builds-complete.result == 'success'",
    "needs.promote-api-production.result == 'success'",
):
    if fragment not in worker_condition:
        raise RuntimeError(f"production Worker condition is missing: {fragment}")
if "continue-on-error" in worker_release_job:
    raise RuntimeError("production Worker promotion must fail closed")
if worker_release_job.get("timeout-minutes") != 45:
    raise RuntimeError("production Worker promotion must have a bounded runtime")
if worker_release_job.get("environment") != "production":
    raise RuntimeError("production Worker promotion must use production credentials")

prepare_step = find_step(
    worker_release_job, "Prepare standalone App Worker production deployment"
)
sentry_step = find_step(worker_release_job, "Upload App source maps to Sentry")
deploy_step = find_step(worker_release_job, "Deploy App Worker production")
start_step = find_step(worker_release_job, "Start GitHub Deployment")
finish_step = find_step(worker_release_job, "Finish GitHub Deployment")

preview_job = turbo["jobs"]["deploy-app"]
preview_prepare_step = find_step(
    preview_job, "Prepare standalone app Worker preview"
)
build_step = find_step(preview_job, "Build canonical app artifact")
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    (root / "turbo").mkdir()
    command_log = root / "commands.log"
    subprocess.run(
        [
            "bash",
            "-euo",
            "pipefail",
            "-c",
            'pnpm() { printf "%s\\n" "$*" >> "$COMMAND_LOG"; }\n'
            + build_step["run"],
        ],
        cwd=root,
        env={**os.environ, "COMMAND_LOG": str(command_log)},
        check=True,
    )
    if command_log.read_text().splitlines() != [
        "--filter @okouai/app exec vite build --sourcemap",
        "--filter @okouai/app exec sentry-cli sourcemaps inject dist",
    ]:
        raise RuntimeError("App deployment must build once and retain source map injection")
for shell_prepare_step in (prepare_step, preview_prepare_step):
    require_fragments(
        shell_prepare_step, ["bash .github/scripts/prepare-okou-app-worker-shell.sh"]
    )
require_fragments(
    prepare_step,
    [
        "bash .github/scripts/artifacts/fetch-okou-app-artifact.sh",
        "bash .github/scripts/artifacts/verify-okou-app-artifact.sh",
        "bash .github/scripts/prepare-okou-app-worker-shell.sh",
        'echo "canonical-dist=$canonical_dist"',
    ],
)
expected_canonical_dist = "${{ steps.worker-production.outputs.canonical-dist }}"
if sentry_step.get("env", {}).get("CANONICAL_DIST") != expected_canonical_dist:
    raise RuntimeError("source map upload must use the Worker canonical artifact")
assert sentry_step["env"]["APP_RELEASE"] == (
    "${{ needs.release-please.outputs.app_version }}"
)
# Execute the production step; only the external Sentry command is controlled.
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    canonical_dist = root / "canonical dist"
    canonical_dist.mkdir()
    command_log = root / "commands.log"
    command_boundary = '''pnpm() {
      python3 - "$@" <<'COMMAND'
import json
import os
import sys
from pathlib import Path
with Path(os.environ["COMMAND_LOG"]).open("a") as stream:
    stream.write(json.dumps({"args": sys.argv[1:], "release": os.environ.get("SENTRY_RELEASE")}) + "\\n")
COMMAND
      if [[ "$*" == *"sourcemaps upload"* ]]; then
        return "$UPLOAD_STATUS"
      fi
    }
    '''

    for app_release, upload_status in (("0.1034.0", 0), ("", 0), ("0.1034.0", 23)):
        command_log.unlink(missing_ok=True)
        result = subprocess.run(
            ["bash", "-euo", "pipefail", "-c", command_boundary + sentry_step["run"]],
            cwd=root,
            env={
                **os.environ,
                "APP_RELEASE": app_release,
                "CANONICAL_DIST": str(canonical_dist),
                "COMMAND_LOG": str(command_log),
                "UPLOAD_STATUS": str(upload_status),
            },
            capture_output=True,
            text=True,
        )
        assert result.returncode == upload_status, result.stderr
        commands = (
            [json.loads(line) for line in command_log.read_text().splitlines()]
            if command_log.exists()
            else []
        )
        if app_release:
            prefix = ["--filter", "@okouai/app", "exec", "sentry-cli"]
            assert commands == [
                {
                    "args": prefix + ["releases", "new", app_release, "--finalize"],
                    "release": app_release,
                },
                {
                    "args": prefix + ["sourcemaps", "upload", "--release", app_release, str(canonical_dist)],
                    "release": app_release,
                },
            ], commands
        else:
            assert commands == [], commands
            assert "::warning::" in result.stdout, result.stdout

deploy_source = require_fragments(
    deploy_step,
    [
        "wrangler deploy",
        "--env production",
        '--secrets-file "$worker_secrets"',
        '--message "app artifact ${ARTIFACT_SHA}"',
        ': "${CLERK_PUBLISHABLE_KEY:?production Clerk publishable key is required}"',
        ': "${CLERK_SECRET_KEY:?production Clerk secret key is required}"',
        'case "$CLERK_PUBLISHABLE_KEY" in',
        "pk_live_*",
        'case "$CLERK_SECRET_KEY" in',
        "sk_live_*",
        "umask 077",
        'worker_secrets="$(mktemp)"',
        'trap \'rm -f "$worker_secrets"\' EXIT',
        "CLERK_PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY",
        "CLERK_SECRET_KEY: env.CLERK_SECRET_KEY",
        "unset CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY",
        'app_origin="https://app.okou.ai"',
        'api_origin="https://api.okou.ai"',
        "Access-Control-Request-Method: GET",
        "%header{access-control-allow-origin}",
        "%header{access-control-allow-credentials}",
    ],
)
if deploy_source.count("wrangler deploy") != 1:
    raise RuntimeError("production Worker must deploy exactly once")
if deploy_source.count('--secrets-file "$worker_secrets"') != 1:
    raise RuntimeError("production Worker must bind Clerk keys exactly once")
if "--var CLERK_SECRET_KEY" in deploy_source:
    raise RuntimeError("production Worker must not expose the Clerk secret on the command line")
secrets_file_index = deploy_source.index('worker_secrets="$(mktemp)"')
unset_index = deploy_source.index("unset CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY")
deploy_index = deploy_source.index("wrangler deploy")
if not secrets_file_index < unset_index < deploy_index:
    raise RuntimeError("production Clerk keys must be captured and unset before deployment")
if deploy_step.get("env", {}).get("CLOUDFLARE_API_TOKEN") != (
    "${{ secrets.CF_API_WORKER_DEPLOY_API_TOKEN }}"
):
    raise RuntimeError("production Worker deployment must use the Worker token")
if deploy_step.get("env", {}).get("CLERK_PUBLISHABLE_KEY") != (
    "${{ vars.CLERK_PUBLISHABLE_KEY }}"
):
    raise RuntimeError("production Worker deployment must use the production Clerk key")
if deploy_step.get("env", {}).get("CLERK_SECRET_KEY") != (
    "${{ secrets.CLERK_SECRET_KEY }}"
):
    raise RuntimeError("production Worker deployment must use the production Clerk secret")
if start_step.get("with", {}).get("env") != "app/production":
    raise RuntimeError("production Worker must own the canonical App deployment")
if finish_step.get("with", {}).get("status") != "${{ job.status }}":
    raise RuntimeError("production Worker deployment must report its final job status")
if finish_step.get("with", {}).get("env_url") != "https://app.okou.ai":
    raise RuntimeError("production Worker deployment must report the Okou App URL")

steps = worker_release_job["steps"]
if not (
    steps.index(prepare_step)
    < steps.index(sentry_step)
    < steps.index(deploy_step)
    < steps.index(finish_step)
):
    raise RuntimeError("Worker artifact preparation must precede deployment reporting")
if "publish-okou-app-assets.sh" in str(worker_release_job):
    raise RuntimeError("production promotion must not republish immutable app assets")

dashboard_needs = release_dashboard_job.get("needs", [])
if "promote-app-worker-production" not in dashboard_needs:
    raise RuntimeError("production Worker must gate the rollback dashboard")
dashboard_condition = str(release_dashboard_job.get("if", ""))
for fragment in (
    "needs.release-please.outputs.app_deploy_required != 'true'",
    "needs.promote-app-worker-production.result == 'success'",
):
    if fragment not in dashboard_condition:
        raise RuntimeError(f"rollback dashboard condition is missing: {fragment}")

if rollback_verification_job.get("needs") != "rollback-api":
    raise RuntimeError("domain verification must follow the API rollback")
rollback_verification_step = find_step(
    rollback_verification_job, "Verify production App and API domains"
)
if rollback_verification_step.get("run") != (
    "bash .github/scripts/verify-okou-production-domains.sh"
):
    raise RuntimeError("rollback must verify the unchanged App and rolled-back API")

for fragment in (
    '"pattern": "app.okou.ai/*"',
    '"zone_name": "okou.ai"',
):
    if fragment not in worker_config_source:
        raise RuntimeError(f"production Worker config is missing: {fragment}")

for fragment in (
    "https://app.okou.ai",
    "https://api.okou.ai",
    "sign-in",
    "sign-up",
    "%{redirect_url}",
    "Access-Control-Request-Method: GET",
    "%header{access-control-allow-origin}",
    "%header{access-control-allow-credentials}",
    "/api/__brand-smoke__",
):
    if fragment not in production_verifier_source:
        raise RuntimeError(f"production verifier is missing: {fragment}")

for api_origin, app_origin in (("https://api.okou.ai", "https://app.okou.ai"),):
    for invocation in (
        f'verify_auth_redirect "{api_origin}" "{app_origin}"',
        f'verify_api_cors "{api_origin}" "{app_origin}"',
    ):
        if invocation not in production_verifier_source:
            raise RuntimeError(f"production verifier is missing mapping: {invocation}")

release_outputs = release_controller_job["outputs"]
expected_release_outputs = {
    "app_worker_release_created": "${{ steps.release.outputs['turbo/apps/app-worker--release_created'] }}",
    "app_worker_version": "${{ steps.release.outputs['turbo/apps/app-worker--version'] }}",
    "app_deploy_required": "${{ steps.app-release.outputs.required }}",
    "app_deploy_tag": "${{ steps.app-release.outputs.tag }}",
    "app_deploy_version": "${{ steps.app-release.outputs.version }}",
}
for output_name, expression in expected_release_outputs.items():
    if release_outputs.get(output_name) != expression:
        raise RuntimeError(f"Release Please output {output_name} must be {expression}")

print("deploy okou app Worker workflow tests passed")
PY
