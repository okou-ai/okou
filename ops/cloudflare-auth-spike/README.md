# Disposable Cloudflare GCP / KMS preview verification

**Do not merge this spike.** It creates a dedicated, short-lived Cloudflare
Worker from the PR head, exercises real providers when dedicated credentials
are configured, and deletes only the Worker it owns. It does not migrate the API,
modify production, extract existing preview bindings, or reuse `PREVIEW_KMS_*`.
The API's no-op marker requests the normal PR preview as well; that API remains
on its existing deployment/authentication path and is not Cloudflare proof.

## Scope

- Official AWS SDK, explicit Worker region/credentials, default fetch transport.
- Unmodified `crypto.utils.ts` on both Node and Worker. Node uses the original
  `secret-kms-client.ts`. Worker uses a real AWS SDK deployment adapter because
  browser-target SDK credential resolution cannot consume Node defaults.
- Node-generated envelope -> Worker read; Worker write/read -> Node read.
- Legacy direct-KMS canary -> Worker read when `kms:Encrypt` is authorized.
- Wrong KMS context and modified GCM tag must fail with the expected integrity
  failure, not merely any network error.
- Official `google-auth-library` JWT service-account-key flow -> Google OAuth
  token -> minimal Vertex request, with a fixed Google endpoint/model.
- Missing/wrong bearer requests rejected before provider operations.
- Missing credentials produce **BLOCKED**, never a positive integration pass.
  The workflow intentionally fails while any required check is blocked/fails.

`run.mjs --build-only` performs offline builds only (not integration proof).
Dependencies come from the existing frozen pnpm lockfile. No SDK upgrade is
included. The Worker is bundled through the repository's Wrangler version with
`nodejs_compat` and compatibility date `2026-08-06`.

## Dedicated nonproduction credentials

An administrator must provision these through GitHub repository Secrets/Variables,
not chat or a committed file. Do not copy existing production/preview credentials.

| Kind     | Name                                 | Requirement                                   |
| -------- | ------------------------------------ | --------------------------------------------- |
| Secret   | `CF_SPIKE_AWS_ACCESS_KEY_ID`         | Dedicated non-root nonproduction principal    |
| Secret   | `CF_SPIKE_AWS_SECRET_ACCESS_KEY`     | Its secret key                                |
| Secret   | `CF_SPIKE_KMS_KEY_ID`                | Exact dedicated KMS key ARN, not an alias     |
| Variable | `CF_SPIKE_KMS_KEY_ARN`               | Explicit allowlisted ARN, matching the secret |
| Variable | `CF_SPIKE_AWS_REGION`                | ARN's region                                  |
| Secret   | `CF_SPIKE_GCP_SERVICE_ACCOUNT_JSON`  | Dedicated nonproduction service-account key   |
| Variable | `CF_SPIKE_GCP_PROJECT`               | Exact key project ID                          |
| Variable | `CF_SPIKE_GCP_SERVICE_ACCOUNT_EMAIL` | Exact key client email                        |

The AWS principal needs `kms:GenerateDataKey` / `kms:Decrypt` on only this key;
`kms:Encrypt` is additionally needed to create a legacy-format canary. IAM/key
policies must deny production keys. The runner verifies non-root identity,
account, region and exact key ARN; it does **not** audit every IAM policy or prove
cross-environment denial. Google needs Vertex access in the dedicated project.
No IAM/key creation, policy modification, API enablement or self-grant occurs.

The existing `CF_API_WORKER_DEPLOY_API_TOKEN` is used only by the CI control plane
for deployment, never bound into the Worker. Its account permissions may be
broader than this spike; this change does not claim to reduce its privileges.
Only dedicated AWS/GCP secrets and the random request gate are encrypted Worker
bindings. Tokens, plaintext keys, ciphertext and canary plaintext are excluded
from uploaded results. The public health response exposes only PR SHA.

## Execution, evidence and cleanup

The same-repository, Ethan-owned `spike/gcp-kms-preview*` PR triggers
`Cloudflare Auth Preview Spike`. It deploys
`okou-auth-pr-<pr>-<run>-<attempt>`, refuses an existing name, and enables only
that Worker's workers.dev route. Observability and version preview URLs are off.
Readiness polling is GET-only; the authorized POST is submitted once, never
blindly retried. Sanitized results include the source SHA, Worker version,
individual assertions, blocked requirements and cleanup status in the Actions
summary and seven-day artifact. Provider error bodies are not published.

Cleanup runs in `finally` and an independent `always()` step. A local ownership
receipt is written before upload; deletion verifies the exact account/name and
random ownership binding, then confirms absence. Hard runner loss can prevent
both cleanup paths: use the exact name from that run's summary/step and verify
its `SPIKE_OWNER` binding before deleting it. Never delete by prefix/wildcard.
No shared Worker, domain, resource policy or real stored-secret record is changed.

A successful smoke test still does **not** close migration P0: token refresh,
credential rotation, cross-environment denial, concurrent request ownership,
abort behavior and full API operation on Workers need separate verification.
The normal Vercel API preview and this isolated Worker are distinct boundaries.
