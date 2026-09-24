# Google Cloud LLM identity, voice, and Maps Grounding routing

Gemini-backed voice operations and the built-in Maps search use native Google
`generateContent`, authenticated with the API deployment's Vercel workload
identity. Voice covers partial/final audio transcription, text finalization,
and `/api/voice-io/polish`. Maps exposes only `POST /api/maps/search` /
`okou maps search`, using Gemini 2.5 Flash with native Google Maps Grounding.
Generic chat/image/LLM consumers retain their routing.

## Configuration

Voice input and Google Cloud routing are fully rolled out. Both voice API routes
and Maps search require a signed-in user with an active organization; their
existing quota, credit, and request limits continue to apply. All Gemini voice
steps, including independent text polish, use Google Cloud without a routing
override. Voice input always uses Gemini 3.1 Flash-Lite and has no member model
selection. Maps search likewise has no provider fallback. Failures never switch
to another model or provider.

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
incomplete configuration returns `NOT_CONFIGURED` before a voice operation or
Maps calls Google.

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
provider resource; it differs from the Vercel token audience. The shared IAM, STS, IAM Credentials, and Vertex AI prerequisites and billing are
enabled. Maps additionally requires the Maps Grounding API and project access;
that entitlement must be verified with the bounded preview smoke test before
rollout.

The old `gemini-voice-prod/dev` accounts have been deleted. Preserve the unrelated
`gemini-image-prod` account and historical `vercel/vercel` federation resources.
No service-account key, Owner/Editor role, or broad Token Creator grant is needed.

## Global Maps Grounding requests

Maps sends one bounded `v1beta1` request to the global Vertex endpoint for
`gemini-2.5-flash`, with native `googleMaps` place and routing grounding enabled.
It never uses a user Google account, a static Maps key, the independent Google
Maps OAuth connector, or the retired direct Geocoding, Directions, Places, and
Routes APIs. OpenStreetMap download and rendering are also retired rather than
used as a hidden fallback.

The request includes only the caller's bounded query, an optional explicit
latitude/longitude pair, and an optional language code. No server-IP or proxy
header supplies location. The model is instructed to refuse high-risk Maps uses
and never treat retrieved place or review text as instructions. Provider safety
blocks, non-STOP candidates, malformed output, invalid source domains, and
invalid UTF-8 byte citation ranges fail closed without returning partial grounded
content.

The response is Gemini's display-ready answer. Google Maps source titles and
HTTPS links remain in provider order, with `Google Maps` attribution and the
provider's citation ranges expressed as UTF-8 byte offsets. Human-readable CLI
output places those sources immediately after the answer. Responses use
`Cache-Control: private, no-store`; the route does not create a run, chat event,
memory, snapshot, embedding, search-index row, or other retained copy. Agent
guidance requires the answer to be reproduced without another model rewriting
it. The separate user-managed Google Maps OAuth connector remains unchanged and
is never a fallback.

Billing combines the published $25 per 1,000 grounded-prompt list rate with
Gemini 2.5 Flash's $0.30 per million original-input tokens and $2.50 per million
output tokens. `toolUsePromptTokenCount` is excluded because Maps-provided input
is uncharged. The components become one `provider_cost_usd_micros` quantity;
usage pricing converts that quantity once at 1,250 credits/USD, applying the 25%
managed-service markup exactly once. Vertex does not identify whether a request
used the shared no-charge allowance, so Okou consistently uses published list
cost. Historical Maps price rows remain only for old ledger interpretation and
rolling-deploy compatibility.

The Google prohibition is on distributing or marketing the Customer Application
in a Prohibited Territory, not on asking about a destination there. Enforce that
at the trusted product-distribution edge; do not guess end-user geography from
the query, destination coordinates, server IP, or untrusted forwarded headers.
Production rollout remains blocked until that external distribution control and
the project's live Maps Grounding entitlement are verified.

## Oregon preference and request settings

| Use                                | Native model            | Location / hostname                       | Thinking | Output tokens |
| ---------------------------------- | ----------------------- | ----------------------------------------- | -------- | ------------- |
| Voice input segments               | `gemini-3.1-flash-lite` | `us` / `aiplatform.us.rep.googleapis.com` | MINIMAL  | 65,536        |
| Independent `/api/voice-io/polish` | `gemini-3.8-flash`      | `us` / `aiplatform.us.rep.googleapis.com` | LOW      | 65,536        |

Both model cards currently list US/EU multi-region and global, with no Oregon
region. US multi-region is an explicit exception and does not guarantee Oregon
processing. Never use `us-aiplatform.googleapis.com`. Voice input retains
temperature 0. 3.8 omits unsupported sampling controls and does not accept
MINIMAL. Independent text polish does not change generic `FAST_PATH_MODEL`
consumers.

STS uses `https://sts.us-west1.rep.googleapis.com/v1/token`. WIF pool/provider
resources remain `locations/global`, their only supported location. Project,
service accounts, and IAM policies have no region field. Impersonation uses
`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{email}:generateAccessToken`.
No Oregon IAM Credentials endpoint is documented.

Audio stays inline WAV; prompts, references, strict local Zod
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
remaining cancellation deadline, including credential refresh. Auth is not
retried, and a 401/403 never triggers automatic refresh/replay or another
provider. Native Google responses use Google's own response contract.

Capacity exhaustion, transient auth unavailability, and recognized Google
fetch/body network or timeout failures use public 503 / `PROVIDER_UNAVAILABLE`.
Transport failures do not add automatic replay: an interrupted response may
follow a billable generation. Unknown errors, invalid output, and denied auth
still use 502. A received non-2xx status remains authoritative even if its body
is unreadable. Caller cancellation retains its original outcome.

App quota 402/429, no-speech 204, and successful usage accounting retain their
existing route contracts. Terminal native errors retain sanitized
model/location/operation/status and a fixed reason, including truncation,
blocking, empty output, invalid response/schema, and oversized responses.
Native errors from segment operations are owned by the segment diagnostic
described below; independent text polish keeps the `VertexVoice` provider
owner. Auth diagnostics include the failing stage and fixed reason. Diagnostics
may include the bounded provider metadata listed below, but neither diagnostics
nor public errors include audio, transcripts, generated text, raw provider
responses, or unbounded provider-supplied strings. Auth, native
validation/transport, and exhausted HTTP recovery retain one explicit
diagnostic owner; successful recovery and caller cancellation do not produce
terminal-error warnings.

## Segment failure diagnostics

The segment service emits `VoiceSegment` / `voice_transcription_failure` for
terminal failures that it owns. Vertex calls through the segment completion
path explicitly select this owner, while standalone `/api/voice-io/polish`
retains `VertexVoice`. Existing Google authentication and exhausted recovery
retain their diagnostic owners. Each
failure has one owner and one terminal record. Accepted no-speech and caller
cancellation do not add a failure record.

`stage` identifies audio reading, transcription, combined finalization,
standalone polish of a saved prefix, or output validation. `reason` is a fixed
category: transport failure, HTTP rejection, blocked output,
malformed/oversized response, truncated or non-stop output, empty/invalid
output, missing configuration, excessive transcription/polish rate, discarded
speech, or `unknown`. The unknown category never serializes the thrown value.

Records include `model`/`provider` when the failed stage called Vertex,
final/audio flags, audio/recording durations, and available
saved/transcribed/polished character counts. Audio-reading failures do not
include a provider attribution.
Available correlation is limited to a valid active trace ID, a UUID-shaped
`x_client_request_id`, and a 40-hex `deployment_commit_sha`. Raw request headers,
credentials, audio, transcripts, reference context, and provider bodies are
excluded. Diagnostic sink failures cannot replace the handled HTTP result.

When a Vertex response was parsed far enough to expose metadata, the same
record may include `location`, `operation`, `prompt_tokens`,
`candidate_tokens`, `thought_tokens`, `tool_use_prompt_tokens`,
`cached_content_tokens`, `total_tokens`, `candidate_chars`, `thought_chars`,
and `provider_model_version`. Token fields accept only nonnegative finite safe
integers. Character counts are derived inside the bounded response parser and
do not retain part text. Model versions are limited to 128 characters from a
narrow identifier allowlist. Every field is optional: missing or malformed
provider telemetry is omitted independently and never changes response
validity, retry behavior, or the public result.

For an `output_truncated` investigation, replace the three literals below with
the exact deployed commit and a UTC interval no wider than 30 minutes, then run
this query against Axiom. Use the deployment's ready time as the initial lower
bound, and never mix commits in one causal sample.

```apl
['vm0-web-logs-prod']
| where ['_time'] >= datetime(2026-09-22T00:00:00Z)
| where ['_time'] < datetime(2026-09-22T00:30:00Z)
| where ['fields.type'] == "voice_transcription_failure"
| where ['fields.reason'] == "output_truncated"
| where ['fields.deployment_commit_sha'] == "0000000000000000000000000000000000000000"
| project ['_time'], ['fields.deployment_commit_sha'], ['fields.model'], ['fields.provider'], ['fields.location'], ['fields.operation'], ['fields.stage'], ['fields.final'], ['fields.has_audio'], ['fields.audio_duration_seconds'], ['fields.total_duration_seconds'], ['fields.previous_transcript_chars'], ['fields.prompt_tokens'], ['fields.candidate_tokens'], ['fields.thought_tokens'], ['fields.tool_use_prompt_tokens'], ['fields.cached_content_tokens'], ['fields.total_tokens'], ['fields.candidate_chars'], ['fields.thought_chars'], ['fields.provider_model_version'], ['fields.trace_id'], ['fields.x_client_request_id']
| order by ['_time'] asc
```

Compare the prompt, candidate, thought, and total counts with audio duration and
the previous-transcript size. A large audio or cumulative transcript is not the
cause unless those dimensions and the provider usage support it. If no
truncation recurs in the first interval, extend the exact-commit window once to
at most 24 hours and report insufficient recurrence rather than a causal
conclusion. Count requests, client sessions, and Sentry users separately.

For [#34193](https://github.com/vm0-ai/vm0/issues/34193), inspect a bounded
metadata-only interval on the deployed commit. Correlate the new categories
with exact segment POSTs, segment-owned Vertex failures, and the retained auth
and exhausted-recovery owners. Count requests, client sessions,
and Sentry events separately; OPTIONS 204 is not evidence of accepted no-speech.
These diagnostics cannot reconstruct the historical provider output or prove
that a saved recording survived or was recovered. Keep the incident open until
production evidence supports its outcome.

## Runtime verification

Follow [issue #33138](https://github.com/vm0-ai/vm0/issues/33138) for the verification
record. Provisioned IAM and configured Variables establish prerequisites, not
successful runtime authentication or model access. HTTP fixtures establish code
behavior, not Google's live project capacity or audio limits.

For routing or identity changes, use the PR preview to verify the actual dev runtime
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

Rollback uses the normal approved API deployment rollback/revert path.
Browser drafts/checkpoints remain compatible; there is no automatic runtime fallback.
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
