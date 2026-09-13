# Google Cloud LLM identity and voice routing

When the `voiceGoogleCloud` feature switch is enabled, Gemini-backed voice
operations use native Google `generateContent`, authenticated
with the API deployment's Vercel workload identity. The identities and
`GCP_LLM_*` configuration are reusable for future Google Cloud LLM operations;
this migration changes voice only. It covers partial/final audio transcription,
ASR overlap reconciliation, text finalization, and `/api/voice-io/polish`.
GPT Audio recognition stays on OpenRouter, dedicated ASR stays on its selected
OpenRouter/fal provider, and generic chat/image/LLM consumers retain their routing.

## Configuration

The public `voiceGoogleCloud` switch is **on by default in staff organizations**
and off by default elsewhere. Manage it in **Lab → Beta** using the existing
per-user feature-switch override. An explicit off override still disables it
for staff; resetting the override restores the organization default. The existing
`voiceInputV2` access switch must also be enabled. Both voice API routes resolve
the authenticated user's override on every request; no browser/API contract or
additional environment variable is needed. Off preserves the existing OpenRouter
Gemini path and does not require Google credentials. On selects Google for all
Gemini voice steps, including independent text polish. Failures never change the
selected provider.

The active billed project is `vm0-ai-488909` (number `662642595011`). The separate
project `vm0-ai` is deprecated. These values are GitHub Actions **Variables**:

| Scope                    | Name                                 | Value                                                                                          |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Repository               | `GCP_LLM_PROJECT_ID`                 | `vm0-ai-488909`                                                                                |
| Repository               | `GCP_LLM_WORKLOAD_IDENTITY_PROVIDER` | `projects/662642595011/locations/global/workloadIdentityPools/vercel-vm0-api/providers/vercel` |
| Repository               | `GCP_LLM_SERVICE_ACCOUNT_EMAIL`      | `llm-dev@vm0-ai-488909.iam.gserviceaccount.com`                                                |
| Environment `production` | `GCP_LLM_SERVICE_ACCOUNT_EMAIL`      | `llm-prod@vm0-ai-488909.iam.gserviceaccount.com`                                               |

The production API job declares `environment: production`. GitHub resolves the
same-named account override before `toJSON(vars)` reaches `web-api-env`. Preview
jobs use the repository's dev account. The action forwards the three values only
to API deployments through the existing Vercel build/runtime environment path.
There are no `_DEV`/`_PROD` source keys or new GCP Secrets. Do not supply static
Google credentials, a Gemini API key, or a Vercel OIDC token through this action.
All three settings are validated together when a Google LLM operation is needed;
with the switch on, incomplete configuration returns `NOT_CONFIGURED` before
starting an ASR step whose finalization needs Gemini.

Vercel project `vm0-api` (`prj_6mw0CgYjECVrJV57VJ47VN03B4UR`) belongs to team
`okou` (`team_WRqI0kCoX5KcRInRWgZ1nBF0`), with OIDC enabled and team issuer mode.
Vercel supplies the runtime token in its request context. The API reads it with
the supported `@vercel/oidc` synchronous getter inside the request, avoiding the
SDK's local CLI refresh path. Local tests use synthetic HTTP credentials; an
ordinary local API process does not acquire this workload identity automatically.

## GCP trust and permissions

Both shared accounts have project `roles/aiplatform.user`. Each account's
`roles/iam.workloadIdentityUser` binding trusts only its matching subject in pool
`vercel-vm0-api`:

| App  | Vercel target | Subject                                             |
| ---- | ------------- | --------------------------------------------------- |
| dev  | preview       | `owner:okou:project:vm0-api:environment:preview`    |
| prod | production    | `owner:okou:project:vm0-api:environment:production` |

Provider `vercel` uses issuer `https://oidc.vercel.com/okou`, allowed token
audience `https://vercel.com/okou`, and `google.subject=assertion.sub`. Its
condition checks the exact immutable Vercel team/project IDs above and the two
subjects. The STS audience is `//iam.googleapis.com/` followed by the full
provider resource; it differs from the Vercel token audience. The required IAM,
STS, IAM Credentials, and Vertex AI APIs and billing are enabled.

The old `gemini-voice-prod/dev` accounts have been deleted. Preserve the unrelated
`gemini-image-prod` account and historical `vercel/vercel` federation resources.
No service-account key, Owner/Editor role, or broad Token Creator grant is needed.

## Oregon preference and request settings

| Public model                   | Native model            | Location / hostname                               | Thinking | Output tokens |
| ------------------------------ | ----------------------- | ------------------------------------------------- | -------- | ------------- |
| `google/gemini-2.5-flash-lite` | `gemini-2.5-flash-lite` | `us-west1` / `us-west1-aiplatform.googleapis.com` | budget 0 | 65,535        |
| `google/gemini-3.1-flash-lite` | `gemini-3.1-flash-lite` | `us` / `aiplatform.us.rep.googleapis.com`         | MINIMAL  | 65,536        |
| `google/gemini-3.6-flash`      | `gemini-3.6-flash`      | `us` / `aiplatform.us.rep.googleapis.com`         | MINIMAL  | 65,536        |
| `google/gemini-3.8-flash`      | `gemini-3.8-flash`      | `us` / `aiplatform.us.rep.googleapis.com`         | LOW      | 65,536        |

The three newer model cards currently list US/EU multi-region and global, with
no Oregon region. US multi-region is an explicit exception and does not guarantee
Oregon processing. Never use `us-aiplatform.googleapis.com`. 2.5 and 3.1 retain
temperature 0; 3.6 and 3.8 omit unsupported sampling controls. 3.8 does not accept
MINIMAL. Independent text polish uses 3.8 LOW without changing generic
`FAST_PATH_MODEL` consumers.

STS uses `https://sts.us-west1.rep.googleapis.com/v1/token`. WIF pool/provider
resources remain `locations/global`, their only supported location. Project,
service accounts, and IAM policies have no region field. Impersonation uses
`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{email}:generateAccessToken`.
No Oregon IAM Credentials endpoint is documented.

Audio stays inline WAV; prompts, references, model selections, strict local Zod
validation, no-speech handling, and quality safeguards are preserved. Structured
operations send the supported Google schema fields; local validation still owns
strict fields and length bounds. Only normal STOP candidates with usable text
are accepted; thought text is excluded. Structured response bodies are bounded
at 1 MiB and independent plain-text polish at 2 MiB.

## Lifetime, cancellation, and errors

The auth helper exchanges the runtime JWT with STS, then impersonates the chosen
account with cloud-platform scope and at most a one-hour lifetime. Token responses
are limited to 64 KiB and validated before use. Absolute IAM expiry validation
allows up to five minutes of forward clock skew. Local credential reuse stays
capped at the requested hour, with refresh five minutes before that bound or
the provider expiry, whichever is earlier. In-memory credentials are scoped
to project/provider/account/app environment. Concurrent requests share a refresh.
Every waiter retains its own cancellation; the last departing waiter cancels
exchange. A ten-second deadline
bounds auth, and late abandoned work cannot publish credentials into a newer
refresh. Tokens are never persisted or logged.

Inference reuses the existing voice recovery helper: HTTP 429/500/502/503/504,
three attempts maximum, 1s/2s backoff respecting Retry-After, and a 15-second
recovery budget starting after the first failed response. Healthy initial
inference has no new 15-second limit. Retries retain their model/location and
remaining cancellation deadline, including credential refresh. Successful ASR
is not replayed when its later Gemini step retries. Auth is not retried, and a
401/403 never triggers automatic refresh/replay or another provider.
The retained GPT Audio route also preserves OpenRouter's classified completion-body
capacity recovery from #33403 within the same attempt/time budget. Native Google
responses use Google's own response contract; OpenRouter error shapes are not
interpreted as successful Google output.

Capacity exhaustion, transient auth unavailability, and recognized Google
fetch/body network or timeout failures use public 503 / `PROVIDER_UNAVAILABLE`.
Transport failures do not add automatic replay: an interrupted response may
follow a billable generation. Unknown errors, invalid output, and denied auth
still use 502. A received non-2xx status remains authoritative even if its body
is unreadable. Caller cancellation retains its original outcome.

App quota 402/429, no-speech 204, and successful usage accounting retain their
existing route contracts. Terminal native errors log sanitized
model/location/operation/status and a fixed reason, including truncation,
blocking, empty output, invalid response/schema, and oversized responses. Auth
diagnostics include the failing stage and fixed reason. Neither diagnostics nor
public errors include tokens, audio, transcripts, raw provider responses, or
unbounded provider-supplied reason strings. Auth, native validation/transport,
and exhausted HTTP recovery retain separate diagnostic owners; successful
recovery and caller cancellation do not produce terminal-error warnings.

## Verification and rollout gates

Follow [issue #33138](https://github.com/vm0-ai/vm0/issues/33138) for the verification
record. Provisioned IAM and configured Variables establish prerequisites, not
successful runtime authentication or model access. HTTP fixtures establish code
behavior, not Google's live project capacity or audio limits. Enabling the staff
default does not establish these live acceptance criteria.

Before expanding beyond staff, use the PR preview to verify the actual dev runtime
identity and each model/location with non-sensitive audio, all three structured
output schemas, plain-text polish, normal 75s browser PCM, and the existing valid
WAV boundary up to 25 MiB including base64 expansion. Bound functional generation
probes to 32 calls total across models/environments; these are not throughput
proof. Do not silently reduce accepted input size or introduce GCS/conversion,
provider fallback, or model substitution if a probe fails; revise the plan.

Verify production identity during the separately authorized rollout. Obtain the
organization's effective per-model Standard PayGo tier/restrictions, a recent
voice count/concurrency/latency baseline, and a bounded concurrency probe with an
explicit call/cost ceiling before claiming adequate capacity. Validate a saved
browser draft/checkpoint, manual retry, quota and cancellation against the dev
API. No browser/API contract or storage migration is required.

After authorized production deployment, record the exact commit and inspect a
30-minute metadata-only window against representative prior-day traffic. Count
success, recovery, persistent failures and latency by model/location/operation;
separate upstream capacity from application quota. Below 30 operations, record
insufficient evidence or use one bounded follow-up of at most 24 hours. Keep the
issue open until the live acceptance criteria are satisfied. Neither merge nor
one successful model call proves reduced capacity failures.

Disable `voiceGoogleCloud` for the affected user to route subsequent Gemini
voice requests back through OpenRouter. An in-flight request retains its selected
provider. Broader rollback uses the normal approved API deployment rollback/revert path.
Retain OpenRouter credentials for unchanged providers and rollback. Browser
drafts/checkpoints remain compatible; there is no automatic runtime fallback.
Keep the shared identities/configuration until an explicit cleanup is reviewed.

## Focused validation

From `turbo/`, run the three voice route test files with `--maxWorkers=1`, API
lint/type checks, and formatting for changed files. Run
`bash .github/scripts/tests/web-api-env-action-test.sh` from repository root.
Broad API/Platform tests belong to the PR pipeline. No local dev server is needed.

Official contracts refreshed for this implementation:
[Vercel GCP OIDC](https://vercel.com/docs/oidc/gcp),
[thinking controls](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking),
[model locations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations),
[STS](https://docs.cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token),
[impersonation](https://docs.cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken).
