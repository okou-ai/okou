#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

ruby -ryaml - "${repo_root}/.github/workflows/turbo.yml" <<'RUBY'

turbo = YAML.load_file(ARGV.fetch(0))
jobs = turbo.fetch("jobs")
deploy_app = jobs.fetch("deploy-app")
steps = deploy_app.fetch("steps")

# Artifact selection and release/main scheduling are exercised by
# native-only-gates-test.sh against the actual workflow predicates.

find_step = lambda do |name|
  steps.find { |step| step["name"] == name } || raise("missing step: #{name}")
end

expected_concurrency_group = "deploy-app-${{ github.sha }}"
unless deploy_app.fetch("concurrency").fetch("group") == expected_concurrency_group
  raise "deploy-app concurrency must use the checked merge candidate"
end

build_step = find_step.call("Build canonical app artifact")
expected_axiom_token = "${{ github.event_name != 'pull_request' && vars.AXIOM_CLIENT_TELEMETRY_TOKEN || '' }}"
unless build_step.dig("env", "VITE_AXIOM_CLIENT_TELEMETRY_TOKEN") == expected_axiom_token
  raise "pull request preview builds must not receive the Axiom client telemetry token"
end

expected_deployment_url = "${{ steps.worker-deploy.outputs.url }}"
unless deploy_app.fetch("outputs").fetch("preview-url") == expected_deployment_url
  raise "deploy-app preview-url must expose the verified public gateway URL"
end

deploy_step = find_step.call("Deploy standalone app Worker preview")
if deploy_step.key?("if")
  raise "Worker version deployment must remain unconditional within deploy-app"
end
unless deploy_step.dig("env", "CLOUDFLARE_API_TOKEN") == "${{ secrets.CF_API_WORKER_DEPLOY_API_TOKEN }}"
  raise "Worker preview deployment must use the isolated Worker deploy token"
end
unless deploy_step.dig("env", "CLERK_PUBLISHABLE_KEY") == "${{ github.event_name == 'pull_request' && vars.CLERK_PUBLISHABLE_KEY_PREVIEW || '' }}" &&
    deploy_step.dig("env", "CLERK_SECRET_KEY") == "${{ github.event_name == 'pull_request' && secrets.CLERK_SECRET_KEY || '' }}"
  raise "Only PR Worker previews may receive the Clerk test instance bindings"
end
deploy_source = deploy_step.fetch("run")
unless deploy_source.include?("wrangler versions upload") &&
    deploy_source.include?('--preview-alias "$WORKER_PREVIEW_ALIAS"') &&
    deploy_source.include?("--env preview")
  raise "Worker preview deployment must upload an aliased preview environment version"
end
unless deploy_source.include?("/workers/scripts/okou-app-preview/deployments") &&
    deploy_source.include?(".result.deployments | length == 0") &&
    deploy_source.include?("wrangler deploy")
  raise "Worker preview deployment must bootstrap a fresh Worker service"
end
bootstrap_index = deploy_source.index("wrangler deploy")
preview_enable_index = deploy_source.index('/workers/scripts/okou-app-preview/subdomain')
preview_upload_index = deploy_source.index("wrangler versions upload")
unless preview_enable_index && bootstrap_index && preview_upload_index &&
    preview_enable_index < bootstrap_index && bootstrap_index < preview_upload_index
  raise "Worker preview URLs must be enabled before uploading the aliased version"
end
unless deploy_source.include?("Cloudflare-Workers-Script-Api-Date: 2025-08-01")
  raise "Worker preview configuration must use Cloudflare's current script API"
end
unless deploy_source.include?('case "$CLERK_PUBLISHABLE_KEY" in') &&
    deploy_source.include?("pk_test_*") &&
    deploy_source.include?('case "$CLERK_SECRET_KEY" in') &&
    deploy_source.include?("sk_test_*")
  raise "Worker preview deployment must reject non-test Clerk keys"
end
unless deploy_source.include?('worker_secrets="$(mktemp)"') &&
    deploy_source.include?("umask 077") &&
    deploy_source.include?('if [[ "$EVENT_NAME" == "pull_request" ]]') &&
    deploy_source.include?('CLERK_EDGE_AUTHORIZED_PARTY: env.EXPECTED_PREVIEW_URL') &&
    deploy_source.include?('unset CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY')
  raise "Worker preview deployment must create an ephemeral exact-origin secrets file"
end
bootstrap_source = deploy_source[bootstrap_index...preview_upload_index]
version_source = deploy_source[preview_upload_index..]
unless deploy_source.include?('worker_secret_args=(--secrets-file "$worker_secrets")') &&
    version_source.include?('"${worker_secret_args[@]}"') &&
    deploy_source.scan('"${worker_secret_args[@]}"').length == 1
  raise "Only the PR version upload may use encrypted Clerk bindings"
end
if bootstrap_source.include?("worker_secret_args")
  raise "The shared preview bootstrap must not receive PR Clerk bindings"
end
if deploy_source.include?("--var CLERK_SECRET_KEY")
  raise "Worker preview deployment must not expose the Clerk secret on the command line"
end

preview_step = find_step.call("Resolve public and upstream app preview URLs")
raise "app preview step id changed" unless preview_step["id"] == "app-preview"
if preview_step.key?("if")
  raise "public and upstream preview URLs must be resolved on every deploy-app run"
end
unless preview_step.fetch("run").include?('"$APP_PREVIEW_DOMAIN"') &&
    preview_step.fetch("run").include?("resolve-app-preview-url.sh") &&
    preview_step.fetch("run").include?("resolve-app-worker-preview-url.sh") &&
    preview_step.fetch("run").include?('"$CF_WORKERS_SUBDOMAIN"')
  raise "public preview must use the gateway domain and retain the Worker upstream for diagnostics"
end
unless deploy_app.dig("env", "APP_PREVIEW_DOMAIN") == "${{ vars.CF_PAGES_PREVIEW_DOMAIN }}"
  raise "public preview must retain the existing gateway domain variable"
end
unless version_source.include?('--var "APP_PREVIEW_ORIGIN:$EXPECTED_PREVIEW_URL"')
  raise "each Worker version must bind its exact public preview origin"
end
verify_step = find_step.call("Verify public app preview ingress")
unless verify_step.dig("env", "APP_PREVIEW_URL") == expected_deployment_url &&
    verify_step.dig("env", "ARTIFACT_SHA") == "${{ steps.artifact.outputs.sha }}" &&
    verify_step.fetch("run").include?("verify-app-preview-ingress.sh") &&
    steps.index(verify_step) > steps.index(deploy_step)
  raise "deploy-app must gate the public gateway on the uploaded artifact identity"
end
prepare_urls = jobs.fetch("prepare").fetch("steps").find { |step| step["id"] == "preview-urls" }
unless prepare_urls.fetch("run").include?('APP_PREVIEW_DOMAIN="${{ vars.CF_PAGES_PREVIEW_DOMAIN }}"') &&
    prepare_urls.fetch("run").include?('"$APP_PREVIEW_DOMAIN"')
  raise "prepare and deployed app previews must resolve the same public gateway origin"
end

browser_e2e = jobs.fetch("cli-e2e-02-browser")
playwright_e2e = jobs.fetch("cli-e2e-02-playwright")
[browser_e2e, playwright_e2e].each do |job|
  unless Array(job["needs"]).include?("deploy-app")
    raise "deployed E2E must depend on deploy-app"
  end
  unless job.fetch("if").include?("needs.deploy-app.result == 'success'")
    raise "deployed E2E must wait for deploy-app success"
  end
end

browser_run = browser_e2e.fetch("steps").find do |step|
  step["name"] == "Run browser E2E tests"
end
raise "missing browser E2E run step" unless browser_run
browser_env = browser_run.fetch("env")
expected_downstream_preview = "${{ needs.deploy-app.outputs.preview-url }}"
unless browser_env.fetch("OKOU_AUTH_URL") == expected_downstream_preview
  raise "browser E2E must use the deployed app Worker preview"
end
unless browser_env.fetch("OKOU_AUTH_REDIRECT_URL") == "#{expected_downstream_preview}/_/skeleton"
  raise "browser E2E redirect must stay on the app Worker preview"
end
expected_auth_domain = "${{ needs.prepare.outputs.api-preview-url != '' && format('{0}-api.{1}', needs.prepare.outputs.job-ref, vars.PREVIEW_DOMAIN || 'vm6.ai') || '' }}"
unless browser_env.fetch("OKOU_AUTH_DOMAIN") == expected_auth_domain
  raise "browser E2E auth domain must stay on the API preview"
end

playwright_run = playwright_e2e.fetch("steps").find do |step|
  step["name"] == "Run Playwright E2E tests"
end
raise "missing Playwright E2E run step" unless playwright_run
unless playwright_run.fetch("env").fetch("OKOU_APP_URL") == expected_downstream_preview
  raise "Playwright E2E must emit the app preview URL"
end

RUBY

echo "app-preview-ingress-workflow tests passed"
