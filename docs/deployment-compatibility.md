# Deployment Compatibility

## CI build and test source (2026-10-09)

Ordinary PR previews build and test the event's captured merge commit
(`github.sha`), not the isolated PR head or a merge ref resolved later. API,
public CLI, App, Runner, and CLI E2E lifecycle sources use that same revision.
API seed/deploy `CLI_PKG_URL` and public CLI publication concurrency identify
that source's commit-addressed archive. Archive/ready-marker schemas, integrity
checks, publication order, release skips, and PR namespace ownership do not
change. A new merge commit can require a new public CLI artifact even when the
PR head is unchanged; Runner content-based caches remain reusable.

Build source is not Actions producer/run identity: Runner `PRODUCER_HEAD_SHA`
and consumer `LOOKUP_SHA` retain the PR head for provenance and API run lookup.
GitHub deployment-record attribution is unchanged and is not proof of the
exact build source. The shared Vercel action and Release Please workflow are
unchanged; this repair only aligns ordinary preview build/test sources and
CLI artifact addresses.

No API/Runner wire format, persisted data, runtime protocol, or artifact
migration is required. New previews publish and capture merge-addressed CLI
URLs; already captured contexts retain their existing URLs, and their archives
must stay available. Rolling the workflows back restores previous source
selection without rewriting historical deployment records or deleting captured
artifacts. Production artifact selection, deployment records, and
serving-promotion behavior remain unchanged.

## Free memory preset routing (2026-10-09)

New Stage 1 extraction and Phase 2 consolidation use the platform OpenRouter key
with `@preset/memory` over Chat Completions. They do not select personal accounts
or depend on foreground Auto/organization preset overrides. The internal model
identity is `okou-memory`, not a user-selectable catalog model or a priced route.

Both stages send `x-session-id: MEMORY-${userId}-${orgId}` and Auto-style ephemeral
cache breakpoints. Client reasoning, service tier, sampling, output ceilings and
response-format overrides are omitted, including SDK defaults. Model, messages,
tools, stream and stream usage options remain protocol inputs. Stage 1 retains
local evidence budgets and validates the returned JSON; the preset must support
those budgets and the Phase 2 tool contract. Configuring the remote preset is an
operator prerequisite, not an action performed by this code change.

Preset memory is free. Stage 1 observes token usage without creating charge
rows. Phase 2 captures an empty billable-firewall list and no pricing provider;
no credit admission or allowance activation is performed. Feature, source-owner,
storage/lease, credential, cancellation and publication fences are unchanged.
Captured older contexts retain their original model, billable firewalls and
pricing. Historical usage and model identities are not rewritten or removed.

Publish the new commit-addressed CLI with the API rollout before admitting new
maintenance jobs. The new CLI reads the API-owned `OKOU_MEMORY_SESSION_ID` from
platform environment and materializes `okou-memory` / `@preset/memory` on Gen5.
The updated session-construction digest prevents an older installed CLI from
being selected for new contexts; the guest uses the captured `CLI_PKG_URL` when
installed parity does not match. Old API contexts keep their Luna/Codex binding
and captured CLI package. Runner wire schemas and the captured payload
generations do not change. Rollback
must keep the new CLI available for already queued preset contexts; old captured
Luna/Codex contexts remain supported by the new CLI and their original accounting.

## Automatic OAuth contract hash retirement (migration 1354)

Builtin Automatic OAuth no longer computes, writes, reads or compares a local
configuration fingerprint. Migration `1354_retire_oauth_contract_hash` physically
removes `contract_hash` from account bindings and DCR registrations and removes
`contractHash` only from builtin Automatic authorization contexts. Existing
accounts, encrypted credentials, DCR client IDs and exact registration references
are unchanged; migration does not mark accounts for reconnect. Registrations
formerly distinguished by hash are retained rather than deduplicated. Issuer
lookup uses the newest issuance with an ID tie-breaker, without a hash-dependent
unique key; provider rejection and expiration retain their recovery paths.

Trusted catalog configuration supplies the current builtin method and MCP
endpoint. A callback does not reject consent because catalog storage or endpoint
configuration changed. Credential resolution does not compare the current
configuration against the account's historical endpoint or storage version.
Automatic refresh/reauthorization uses current discovery metadata, without
requiring issuer, resource or token endpoint to equal a historical binding.
Verified refresh identity updates account labels and identity, including a
changed principal, for both builtin and custom OAuth; absent or unusable optional
identity preserves the previous labels. No replacement configuration hash is
introduced.

Discovery still requires the metadata issuer to match the requested issuer
(RFC 8414 section 3.3). Authorization callbacks still verify the response issuer
against the issuer captured for that specific authorization request (RFC 9207 /
RFC 9700 section 4.4.2). State ownership, expiry and single use, PKCE S256,
provider protocol validation, safe outbound URL handling, account ownership,
credential encryption and real invalid-client/invalid-grant recovery remain.

**Intentional breaking contraction; old API compatibility is not supported.**
The owner explicitly accepted removing backward compatibility for this change.
Old APIs reference the removed columns and require the old context fingerprint;
old API requests that overlap the migration or consume new authorization contexts
may fail. That interruption is accepted; do not retain the fingerprint, add dual
writers/readers or require a preparation release solely for outgoing API support.
Apply migrations before promoting the new API through the existing deployment
pipeline. This does not authorize manual production mutations or deployment
approval in the PR-review workflow.

The new reader accepts pending old authorization contexts through ordinary
unknown-field stripping, whether or not the migration already removed the
fingerprint. New API writes require the contracted schema; new API plus old DB
can read accounts but cannot insert hash-free bindings or registrations into old
NOT NULL columns. New API plus new DB supports existing and new accounts. App,
CLI and Runner wire shapes are unchanged. After contraction, rollback must retain
hash-independent API readers and writers; restoring an older API alone is not
supported. PR merge and local validation do not establish production cutover or
migration completion.

## Platform realtime token exchange (#37143)

`POST /api/realtime/token` now always returns a fresh signed Ably `TokenRequest`.
The browser SDK exchanges it for the connection token. The API no longer
pre-exchanges tokens or waits for a one-second exchange budget. Subscribe-only
user/active-organization capabilities, the one-hour TTL, authentication and
server-side signing-key ownership are unchanged.

- **Old Platform → new API:** the existing response union and Ably SDK already
  support signed token requests, previously returned by the fallback path.
- **New Platform → old API:** the unchanged Ably auth callback passes the response
  to the SDK, which accepts both token details and signed requests. The production
  realtime client uses the default API client without response-schema validation;
  narrowing the new producer's contract does not reject old token details there.
- **New Platform → new API:** initial connection and renewal each obtain a fresh
  single-use signed request. The API response contract and test fixtures now use
  only that shape; do not cache or replay a request for renewal.

No database migration, client version floor, feature switch or deployment-order
fallback is required. This change does not deploy or verify production recovery.

## Video poster extraction retired (2026-10-08)

Video uploads stop scheduling server-side poster extraction. The API removes
both the public Cloudflare Media Transformations call and the private-video
capability producer. The host Worker removes the private poster endpoint and
its `MEDIA` binding. Hosted-page screenshots and image thumbnails keep their
existing renderers.

- **Old App or CLI → new API:** upload, playback, download and artifact response
  contracts are unchanged. Videos without a stored poster use the existing
  playable-video preview; previously stored poster references remain readable.
- **New API → old Worker:** the API makes no poster requests; the unused Worker
  endpoint does not affect file delivery.
- **Old API → new Worker:** a remaining private poster POST receives `405` from
  the Worker's existing method guard. The old API handles this in its optional
  background-preview failure path and cleans up its temporary grant. The video
  and catalog entry are already committed, so upload success and source access
  are unaffected. In-flight renders may finish during API drain.

No database migration, stored-preview deletion or client-version floor is
needed. Rolling the API back can resume public poster generation; restoring
private poster generation also requires the old Worker and `MEDIA` binding.

## Pi memory Luna routing (2026-10-08)

New Stage 1 extractions and Phase 2 maintenance runs use `gpt-6-luna`.
Both select the memory owner's current active, connected Codex account that
does not require reconnect; otherwise they use the managed OpenRouter key and
`openai/gpt-6-luna`. Source Runs remain evidence and ownership references,
without selecting the current credential or payer. Once selected, refresh,
quota, provider and validation failures retain the existing error/retry paths;
an attempt does not switch to another credential route after failure.

Migration `1347_pi_memory_luna_route` restores the internal OpenRouter Luna
catalog route removed by 1326, with the existing Luna pricing identity,
272001-token long-context threshold and xhigh catalog ceiling. Deploy it before
the new API. Maintenance explicitly requests low for Stage 1 and medium for
Phase 2, independently of foreground defaults. The existing OpenRouter
Responses/Chat Completions firewall, credentials and Runner accounting apply.
This change does not activate the Chat Completions feature switch or change
foreground Auto selection.

The Luna API with a compatible existing Runner dispatches the existing Pi launch
shape with Luna and preserves the claim capability gates. Both old and new
supported CLI artifacts resolve personal/OpenRouter Luna.
API/CLI deployment order does not rewrite captured Runs or queued launch
contexts. In-flight Stage 1 API invocations keep their resolved request.
Historical DeepSeek and GPT-5.6 Luna maintenance models remain recognizable to
cleanup and accounting. No stored Run, candidate, session, checkpoint or usage
row is rewritten.

## DeepSeek memory execution retirement (2026-10-08)

Migration `1353_retire_deepseek_memory_route` deletes only the
`deepseek-v4.1-flash` execution routes. The runtime removes its hand-pinned
model, limit correction and historical consolidation-effort branch. Historical
model recognition, catalog labels, replacement chains and all prices remain
required for retained usage.

The Luna API (`1.715.0`, release commit
`a17b5e424a8944d832875c8097c0a4330d172bc9`) completed
[production promotion](https://github.com/okou-ai/okou/actions/runs/37794041015/job/113376087119)
at 2026-10-08 14:56:47 UTC. A read-only production census on 2026-10-08 found
no nonterminal DeepSeek Runs, no raw DeepSeek usage awaiting settlement, no
active Stage 1/Phase 2 leases or retries, and no pending Phase 2 callbacks.
The latest retained DeepSeek Run ended at 2026-10-02 23:01:18.992 UTC, beyond
the two-hour runtime plus two-minute finalization bound. Terminal failures
remain historical outcomes, not unfinished attempts. DeepSeek usage is retained
in hourly rollups, so retirement must not delete its billing identities.

The production rollback resolver explicitly requires Luna routing commit
`77357abdb29ce96b2caf9ee679299602757844dc` (#38129). The existing connector
catalog floor already excludes earlier APIs; the explicit memory floor keeps
that requirement independent of connector cleanup.

- **Luna API after route deletion:** both memory stages resolve their Luna
  binding; foreground Auto and personal subscription routes are unchanged.
- **Retirement API before migration:** the extra DeepSeek row grants no new
  admission; both memory stages already select Luna.
- **Existing Runner/CLI and rollback:** supported artifacts resolve Luna and
  retain captured launch/accounting contracts. No captured DeepSeek execution
  remains, and APIs that could admit it are rejected as rollback targets.

This is retirement readiness evidence, not a receipt for deploying migration 1353. The normal production release applies the migration before promoting the
retirement API.

## Maps oversized-response error (issue #36791)

`POST /api/maps/search` continues to return HTTP 502 when the Google Maps
provider response exceeds Okou's 512 KiB response limit. Its error code is now
`MAPS_RESPONSE_TOO_LARGE` rather than `MAPS_GROUNDING_ERROR`; the message explains
that the provider response exceeded Okou's size limit and recommends narrowing
the search area, requesting fewer places, or splitting the query before retrying.
The error includes no query or provider response content. The size protection,
failed-query billing behavior, success envelope, and other failure codes are
unchanged.

- **Old CLI → new API:** the existing string error code/message envelope is
  compatible; the CLI displays the actionable server message and exits 1.
- **New CLI → old API:** the old generic error remains visible and exits 1; the
  CLI does not infer an oversized response from an undifferentiated 502.
- **New CLI → new API:** the actionable server message is displayed for normal
  and `--json` invocations. Errors continue to use stderr rather than success JSON.

No database, Runner protocol, version floor, or rollout fallback is required.
This change does not deploy or activate production changes.

## PWA foreground push suppression

Web Push delivery checks Ably Presence on
`user-org-foreground:<userId>:<orgId>` for the notification owner's user and
organization. Each SharedWorker aggregates tab visibility and enters this
channel while any of its registered tabs is visible. Push subscriptions remain
user-scoped; foreground activity in another organization does not suppress the
notification. Successful and failed Run notifications share the check.

Deploy the API before the Platform: platform realtime tokens now grant
`presence` only on the authenticated user's active-org foreground channel.
Old Platform clients do not enter it, so the new API continues sending their
notifications. A new Platform against an old API cannot enter the channel;
this mixed version is not the supported rollout order. API rollback therefore
requires rolling back the Platform as well. No permission-denial fallback or
new feature switch is added for this fix to existing notifications.

Tab visibility messages stay within the page/SharedWorker protocol. Worker
asset URLs are versioned, so old pages keep their old Worker protocol while new
pages connect to the new Worker. The ServiceWorker Push protocol, subscription
storage, and database schema are unchanged.

Presence query errors propagate to the existing terminal side-effect boundary;
they do not fall back to sending Push. There is no application-level query
budget or message-ACK delay. Normal hidden/pagehide/disconnect events clear
foreground state, but this change adds no tab-expiry timer: a crashed visible
tab can remain recorded while other tabs keep its Worker alive. Ably owns
cleanup of a failed Worker connection and reconnect restoration; abnormal
connection cleanup is not instantaneous.

## Pi OpenRouter Chat Completions route (generation 5, default off)

Pi model configuration gains generation 5 (`dialect: "openai-completions"`,
`provider: "openrouter"`, exactly one `api-key` binding, no `serviceTier`). It
moves Pi OpenRouter routes from OpenAI Responses to OpenRouter Chat
Completions: the Auto `okou-1.0` Preset route, Pi memory maintenance and the
API-side Stage 1 extraction. Generation 4 was the retired native carrier;
Runners built before its removal can still advertise 4, so the new route
skips to 5 and 4 stays unsupported everywhere.

**Readers ship first.** Runners advertise `[1, 2, 3, 5]` on claim and
validate the generation 5 shape. The API claim gate, the CLI launch reader,
the Pi runtime and the guest-agent request diagnostics accept it. Writers are
gated by the `piOpenRouterChatCompletions` feature switch, off by default;
with it off every captured route is unchanged. (The switch was later removed; see
[switch removal](#switch-removed-2026-10-08).)

**Activation.** Enable the switch only after every serving Runner advertises
generation 5. The claim gate never hands a generation 5 job to an older
Runner; such a job stays queued until a capable Runner claims it. The switch
is evaluated
when a Run's launch context is captured; already captured Runs keep their
route. Pi memory maintenance and Stage 1 read the same switch from the owner's
feature-switch context.

**Request policy.** The Preset owns reasoning and routing: requests carry no
reasoning parameters for Preset models. The client sends Anthropic-style
cache breakpoints, which OpenRouter translates for other upstreams, replays
`reasoning_details`, and sets `x-session-id` to the owning chat thread
(`OKOU_CHAT_THREAD_ID`) so every Run of a thread keeps one upstream sticky
route. The firewall already authorizes `/chat/completions` for
`openrouter-codex`.

**Context window.** Pi now uses a 1,000,000-token window for `okou-1.0`, the
smallest window among the Preset's candidate backends (GPT-6 Luna, Claude
Haiku 5.5, DeepSeek V4.1 Flash). The Codex projection is unchanged.

**Rollback.** Disabling the switch returns new launches to Responses. Rolling
the Runner back below this release while the switch is on leaves generation 5
jobs queued; disable the switch first.

### Switch removed (2026-10-08)

The `piOpenRouterChatCompletions` switch is gone and its enabled behavior is
permanent: every new Pi OpenRouter launch (Auto `okou-1.0`, Pi memory
maintenance and API-side Stage 1) captures the generation 5 Chat Completions
route. The API no longer writes generation 1 Responses configs for OpenRouter.

**Runner prerequisite.** Production Runners already advertise generation 5:
`runner-rs-v0.220.22` (built from a `main` commit that contains #37987) was
promoted to production on 2026-10-08 07:59 UTC. A Runner without generation 5
still never claims these jobs; they stay queued until a capable Runner claims
them, so a Runner rollback below that release stalls Pi OpenRouter launches.

**Readers stay.** Already captured Runs keep their route. Generation 1/2/3
readers in the API claim gate, CLI, Pi runtime and Runner remain until those
stored contexts can no longer be pending.

**API rollback.** Rolling the API back to a release that still has the switch
(off by default) returns new launches to Responses. A release before #37987
cannot read generation 5 and leaves those jobs unclaimable.

## Official Workflow canonical queue contexts (#29908)

Official `input.prompt` events from both Web and Agent callers now use the
normal Web context ID. Their `context_type` remains `web` or `agent_run`, and
the server-private `required_official_workflow_ids` claim is unchanged. Ordinary
Agent inputs still point to their source Run. Official Agent inputs recover
their source Run and inherited autonomy budget from the server-owned document
annotation, as before. Final Official admission and exact artifact mounts are
unchanged; the private claim stays out of public event and snapshot payloads.

- **Canonical writer with either reader:** #38049 switched both origins to the
  normal Web ID. The prepared reader from #32533, the cutover reader, and the
  marker-free reader all accept that encoding with the same strict claim rules.
- **Marker writer with marker-free reader:** unsupported. Marker-writing APIs
  are excluded from serving and supported rollback before decoder retirement.
  The current rollback resolver loads from `main` and requires the introduction
  of migration `1345_outstanding_the_hood.sql`, commit
  `5080d026e68f10f41285570f52a9b655fb562052`. That commit contains the canonical
  writer `76c17bcc4048d9aff4907477012172c364a66e5c`; no additional floor is needed.
- **Retained history:** raw events, snapshots and archives keep opaque context
  IDs. Removing launch decoding does not rewrite or delete history. Both the
  current and VM0-era normal Web IDs remain recognized; only the two reserved
  Official launch markers retire.

Read-only retirement evidence refreshed on 2026-10-09:

- The last marker-writing API deployment was marked inactive on 2026-10-08 at
  11:15:19 UTC. The canonical writer's production promotion completed at
  11:15:44 UTC in [release #38074](https://github.com/okou-ai/okou/pull/38074).
  Subsequent releases retain that writer; the observed production API is
  `1.718.0`, commit `c86a5342c2d8f7869aecb3fe8568c746db675035`. The outgoing
  marker writer is past the API's 300-second invocation bound.
- MaskDB schema/index discovery and a complete aggregate over `chat_events`
  found zero `input.prompt` rows with `run_id IS NULL` for either marker
  (`3f713f81-d611-47ec-a427-5a4844078890` or
  `d4f079af-190a-4a32-bf49-73175aa2d727`). There was no time cutoff or FIFO-head
  restriction. The query includes revoked rows, so the unrevoked subset is also
  empty; grouped results fit in one page.
- The positive control found 2,465 normal-context Web inputs since the writer
  promotion, including 1,221 inputs bound to Runs. These are input-row counts,
  not distinct Run counts or proof of Official traffic. MaskDB does not expose
  the private claim or exact Official provenance; Agent-origin production
  samples remain unverified.

This cleanup needs no migration or historical event rewrite. Strict claim
validation, source annotations, autonomy budgets, final admission and queue
recovery remain on their existing paths. Refresh serving/rollback and pending
marker evidence before promotion if that state changes. #29908 remains open
until decoder retirement is released and final production acceptance is recorded.

## Model identity PR2: new writer cutover (2026-10-09)

[PR2's writer, billing, mixed-version and deployment contract](model-identity-pr2.md)
switches new resolved selections to `auto` by deployed code version, retaining
PR1 null/legacy readers and captured executions. Serving/rollback readiness,
actual installed runtime/client readers and mixed native-history restoration
remain explicit pre-promotion gates. New canonical Auto captures the
100001-token billing boundary; legacy captures retain 272001. There is no
database switch or schema tightening. Release 3 and compatibility retirement
remain owned by #38114.

## Model identity PR1: compatibility preparation (2026-10-08)

This is **release 1 of three**, not the final model-identity cutover. The
[final target](https://model-identity-target-state.okou.app) predates this
three-release agreement. This model-identity rollout has no database switch,
phase row, write-version marker, trigger, or activation mechanism.

**Unchanged writers and public output.** PR1 still writes nullable Auto to
thread/member preferences, `okou-1.0` to newly captured input/Run selections,
and the legacy `okou-1.0` model billing provider. The public Auto catalog ID,
replacement lineage, and nullable `/api/run-models` choice are unchanged.
An incoming `auto` intent is translated to these predecessor-compatible
representations; omitted PATCH/send fields retain their existing no-change
semantics. A SQL NULL input selection remains an uncaptured decision, not a
captured `auto`. Personal-subscription models/effort preferences and non-model
billing identities remain separate. Auto offers neither explicit effort nor
Fast. Existing selected/runtime/price rows are not backfilled or deleted.

**Additive database and protocol preparation.** Migration
`1355_expand_runtime_billing_identity` widens the provider fields in
`usage_event`, `usage_event_hourly_rollup`, `usage_pricing`, and the route's
`pricing_provider` to text without rewriting identities, rates, or settled
amounts. The usage webhook now accepts providers through 255 characters,
matching the immutable Run runtime-model column. Executable Auto presets must
fit that column; no truncation is permitted. No selected NOT NULL or
conditional lifecycle constraints are introduced. Migrations run before the
API. Both predecessor and PR1 writes remain valid after this migration; the
migration does not roll back with the API.

**Prepared readers/runtime.** PR1 understands old nullable selections, captured
`okou-1.0`, and future explicit `auto` decisions. Queued captured decisions keep
their identity rather than being treated as personal-subscription model IDs.
CLI and Web consume nullable or explicit Auto choices while retaining
predecessor-compatible request intent; iOS normalizes saved Auto before new
thread creation. Event replay/snapshot schemas retain nonempty model annotations
and optional model fields on unrelated events.

Pi accepts old catalog metadata, selected `auto`, and preset-only configuration
on the existing platform-owned OpenRouter Auto capability class. Captured
Responses configurations remain readable; current main permanently uses
generation 5 Chat Completions for new OpenRouter launches after #38096. There
is no independently gated transport switch to activate or restore.
The captured runtime model, dialect, transport, credential bindings, and key
remain authoritative; catalog selection metadata does not reroute a captured
job. This does not declare arbitrary presets to have different capabilities or
approved prices. A future route outside the existing Auto capability class
requires its own verified captured capability contract before admission.
Runner JSON transports and the addon already preserve string identities;
fixtures exercise future preset payloads and verify usage reports keep the
captured billing provider, not the upstream response's underlying model name.

Future captured `auto` decisions use their captured runtime preset as the
billing provider. Pricing preflight requires every billable token category,
including long-context categories, under that provider. It does not borrow the
legacy price key or a later organization preset. Existing captured legacy jobs
keep legacy billing. Reporting recognizes preset-key observations before the
selected-model display projection, so `auto` cannot merge different presets
into one billing group, even after a Run is deleted. Legacy observations retain
the existing reporting projection. No new price rows or speculative rates are
included.

**Supported combinations and rollout gates.**

| Combination                                             | Support / requirement                                                                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Predecessor API/clients/Runner ↔ PR1 API/clients/Runner | Supported: normal output, writes and captured jobs remain in the predecessor format. New clients continue to send nullable Auto to the predecessor.                                    |
| PR1 API ↔ planned PR2 API during rolling deployment     | PR1 reads future `auto` and runtime-key observations; PR2 must continue accepting PR1 nullable/legacy writers. There must be no pre-API selected NOT NULL migration.                   |
| Old captured jobs ↔ PR1 runtime/API                     | Keep old config, legacy price rows, observation acceptance and reporting until queued/active executions and late reporting have drained.                                               |
| PR2 new jobs ↔ pre-PR1 installed CLI/Pi                 | Not assumed supported. Capture upgraded CLI/runtime packages or gate admission against the installed package's actual capabilities; Runner promotion alone is not a drain proof.       |
| PR2 public Auto catalog ↔ unupgraded clients            | Do not emit only a new Auto choice until the supported CLI/iOS/Web consumers are upgraded or an explicit compatible response window is retained. Web middleware does not gate CLI/iOS. |

No first-release Web version floor points to an unavailable App build. A later
Web floor can be raised only after the corresponding App build is live. Once
PR2 emits new records/observations, API rollback below PR1 is unsupported unless
a separately reviewed forward recovery restores compatibility; additive DDL
alone cannot make the predecessor understand those records.

**Follow-up releases.** PR2 switches _new writes by deployed code version_ to
selected `auto` and captured-runtime billing. Before doing so, verify
provider-specific authoritative rates for every enabled preset and every
billable category, client/runtime availability, immutable runtime/key/account
capture, and the PR1/PR2 mixed-writer matrix. Do not copy one preset's economics
to another. PR1 is not authorization to execute this switch or deploy anything.
PR3 follows proven old-writer, queued execution, installed rootfs/Pi, reporting
and rollback drains: complete justified history/online/R2 snapshot conversion,
apply selected NOT NULL and relevant conditional runtime constraints, and
remove expired protocol/catalog/pricing compatibility. Historical billing
conversion requires captured evidence, never today's org preset, and must not
change settled amounts; unrecoverable identities remain auditable. These
compatibility readers are tracked in [#38114](https://github.com/okou-ai/okou/issues/38114),
not by elapsed time or a green Runner promotion.

**Compatibility inventory / cleanup ownership.** #38114 owns the release-3
removal gates for these concrete surfaces:

- `core/auto-run-model.ts`: `isAutoSelectedModel`, `sameSelectedModel`,
  `autoRunBillingProvider`; API `model-selection.service.ts`:
  `resolveModelSelectionPin$`, `resolveQueuedModelSelectionPinFromSnapshot`;
  preference/send normalization and `session-compatibility.ts:modelFamily`.
- Web `availableRunModels$`, `createModelCatalog`,
  `create-chat-thread.ts:createModelSelection,createModelSelectionForSend`,
  default selection, picker and historical/upcoming Run notices; CLI catalog,
  model/chat-model and automation display helpers; iOS
  `resolveThreadModelSelection`.
- Pi `model.ts:capturedAutoCatalogIdentity`; API catalog capability lookup,
  captured built-in runtime routes and `pi-sandbox-config.ts`.
- API `built-in-route-pricing.ts:builtInRouteForContext`; DB
  `model-usage-reporting.ts:modelUsageDisplayProviderSql`, with legacy price
  rows retained until old executions and late observations drain.

**Native session evidence and future trigger.** A read-only MaskDB census of
current retained production tables, bounded by
`created_at < 2026-10-08T09:52:40.625254Z`, found no selected `auto` in Runs,
threads or member preferences. It found 3,566 legacy Auto Runs and 922 session
references to completed legacy Pi conversations with nonempty native-history
hashes. Reads were paginated and repeated, not one transaction snapshot; archived
history, R2 readability, user activity and current thread binding were not
verified. This is not evidence of an already occurring production reset.

After PR2 writes `auto`, a still-serving or supported rollback PR1 can read that
captured input or session and compare it with `okou-1.0`. Completed Run identity
is used for continuity; Runner drain does not remove these retained references.
`modelFamily` therefore treats only the two selected Auto aliases as the same
existing family, retaining harness/family/null incompatibility checks. Deferring
that reader change to PR2 would require proving PR1 is absent from serving and
rollback, contrary to the agreed overlap. Mixed-record deployed/R2 resume remains
a PR2 verification gate, not a claim that source checks prove blob restoration.

**Public request contract.** Nullable Auto and `auto` are accepted selection
intents and normalize to legacy writes in PR1. The internal `okou-1.0` capture
ID remains readable history/captured metadata, not a public selectable request
ID; preference updates, thread selection and normal sends reject that explicit
public selection. Merely echoing an existing stored preference for an unrelated
media change retains the existing no-new-admission path.

## SEO partial SERP results (issue #36799)

`POST /api/seo/serp` returns HTTP 200 for DataForSEO task status `40106`
when the successful single-task envelope contains non-empty SERP items.
The response includes optional `partialResults: true` and retains the full raw
provider response in `result`, including the task status and completeness
message. Billing uses the provider-reported cost, not the requested depth, and
completed partial results are not retried. HTTP/provider/envelope failures,
invalid partial results, and `40106` outside SERP remain failures. Full success
and `40102` no-search-results responses are unchanged and omit the new field.

- **Old CLI → new API:** the additive property does not invalidate the old
  response schema. Raw task status/message and available items are still
  returned; the old human formatter does not add a dedicated partial-result
  warning.
- **New CLI → old API:** ordinary responses without the optional property
  render as before. An old API still returns 502 for `40106`, which the CLI
  continues to surface as an error; the CLI does not invent partial data.
- **New CLI → new API:** human output explicitly warns about incomplete
  results; `--json` preserves the marker, raw provider metadata, and billing.

No database or Runner protocol changes, rollout fallback, or version floor are
required. This change does not deploy or activate production changes.

## Desktop Computer Use plugins retired (2026-10-08)

The Native Desktop replacement in #37889 removed the filesystem and MCP plugin
runtimes and advertises only native Computer Use commands. The remaining
`computerUseDesktopPlugins` switch, filesystem/MCP CLI commands, `plugin.call`
contracts, plugin command/content endpoints, capability routing, result offload
and plugin audit branches are now removed together.

This feature was never generally released: its registry was default-off and
staff-enabled, and the owner confirmed it is unused. Per [fallback policy](fallback.md#2-features-behind-a-feature-switch-need-no-fallback),
no old-plugin-client compatibility branch or data migration is required. Old
CLI plugin requests against the new API receive an unavailable endpoint; the new
CLI exposes no plugin commands and makes no plugin requests to an older API.
Command and screenshot reads select only supported native command kinds; audit
lists do the same, so retired records cannot invalidate native responses.
Historical staff plugin command IDs are unavailable after the cutover.

This retirement leaves Native Desktop and older native-command hosts' command,
permission, claim, completion, audit and screenshot contracts unchanged. The
separate session-authentication rollout follows its own compatibility gates below.
The existing capability-empty host behavior is preserved. Shared Computer Use tables
and screenshot retention remain intact; this change performs no historical
command or object-storage deletion. Retired switch overrides already pass through
the general registry-key filtering.

## Generic Run checkpoint retirement: release 1 (#38124)

Run completion now saves native CLI history in Conversation, writeback outputs
in `agent_runs.result.storageOutputs`, and the terminal transition together.
Only writeback names, mount paths, versions and missing-root policies are added
to the existing result JSON. They provide exact retry evidence for successful,
failed and cancelled recovery reports, including two mounts with the same name.
Read-only versions remain owned by immutable Run launch mounts; there is no new
recovery snapshot or checkpoint entity. Historical result `checkpointId` values
remain readable and opaque. No historical results or blobs are rewritten.

Pi memory publication remains owned by the generic Storage commit transaction
and its validated, lease/revision/base/selection-bound publication receipt
(`pi_memory_phase2_checkpoints`, whose physical name is retained). The observer
uses that receipt alone, including no-diff publications; a successful CLI exit
without a receipt cannot advance watermarks. Already settled callbacks are
idempotent without generic checkpoint ID backfill. Runtime code no longer reads
or writes `lastMaintenanceCheckpointId` or the generic `checkpoints` table.
The physical table, ID columns and indexes remain for release 2. Migration
`1352_detach_memory_history_from_run_checkpoints` removes only the old ID's
participation in the memory job history CHECK constraint. Existing IDs remain
untouched; outgoing writers continue to satisfy the relaxed constraint, while
new failure updates no longer need to clear an obsolete ID. Publication version,
revision, lease and selection constraints remain enforced. Apply this migration
before promoting the table-independent API.

### Serving combinations and activation

- **Current old Guest -> new API:** the combined `/complete.checkpoint` payload
  is normalized into the same Run completion path. The old
  `/api/webhooks/agent/checkpoints/prepare-history` upload URL remains an adapter.
  Neither adapter accesses the generic checkpoint table or returns a fake ID.
- **New Guest -> new API:** native uploads use
  `/api/webhooks/agent/session-history/prepare`; `/complete.completion` carries
  native identity and writeback outputs. Both metadata fields together are
  rejected. Failed/cancelled recovery and metadata-free Runner fallback retain
  their terminal-state rules; Pi history promotes its Session only on success.
- **New Guest -> pre-transition API:** unsupported. The new presign URL is absent
  and the old API cannot commit checkpoint-free output results. Deploy and verify
  the prepared API on every serving instance before promoting new Guest images.
- **Pre-transition API -> new persisted results:** unsupported because clean
  completion still queries the generic table. Exclude those instances from
  serving and supported rollback before enabling new writes. Rollback must stay
  at this table-independent API generation or a descendant.

The current Guest has no standalone checkpoint-create caller: finalization sends
only the combined completion request. Repository callers outside tests do not
use `/api/webhooks/agent/checkpoints`. Its API handler is retired in this release;
legacy contract declarations remain for the release 2 protocol cleanup. Verify
that the deployed producer inventory matches before promotion; any external
standalone producer must upgrade or drain, not receive a synthetic checkpoint ID.
Drain pre-transition in-flight completion/recovery reports before API cutover:
old terminal Runs may have Conversation + checkpoint rows but no Run-owned exact
output evidence. Metadata-free terminal acknowledgements and historical reads
remain supported; conflicting or unverifiable included outputs are rejected.

Record serving/rollback inventory and outgoing API drain, then verify completion,
exact retries, failed/cancelled recovery, next-run native resume, file HEADs and
memory publication/no-diff/lost-or-repeated acknowledgement with old and new
Guest producers. A merge or green CI does not establish production acceptance.
After acceptance, drain old Guest images, uploads and queued callbacks before
release 2 removes adapters and drops the generic table and obsolete ID columns.
The outgoing release 1 API is already independent of the dropped table, matching
the repository's migration-before-API-promotion deployment order.

## Dynamic Run inputs without Agent execution configuration

The first delivery of [#37970](https://github.com/okou-ai/okou/issues/37970)
combines removal of the synthetic Agent execution configuration and baseline
observation with current-input selection. The Agent remains the authorized
identity for instructions, workflows, and connector selection. Framework comes
from the current model provider, while Runner group and profile come from runtime
routing policy. These values no longer pass through an Agent configuration.

Each newly prepared Run resolves current instructions and skill resources.
Environment precedence remains organization variables, user variables, then
explicit current-Run overrides. A continuation no longer implicitly inherits
the preceding Run's variables or configurable volume versions. Provider and
connector credentials, permission checks, encryption, and the trusted platform
environment overlay retain their existing owners. Teams status preserves its
environment response fields, whose Agent-declared requirement lists are empty.

Foreground Pi continuations resolve the current user-memory HEAD and its current
summary projection on every Run. A disabled, missing, or pending projection keeps
the existing no-content behavior for that Run; a later Run performs a fresh
selection. Memory-maintenance producer pins and publication fences are unchanged.

`storageMounts[].baselineCandidate` was optional observation metadata. New API
with old Runner is compatible because the field is absent; old API with new
Runner is compatible because the decoder ignores unknown fields. Removing the
observer does not change immutable-version cache identity or cache application.
The CLI and Guest launch contracts otherwise remain unchanged.

This delivery requires no database migration. Native-history continuation still
uses the existing Session, Conversation, and Checkpoint protocol. Non-memory
writeback artifacts still use existing Session storage. Previously admitted Runs
retain their captured launch inputs; the new selection policy applies to newly
prepared Runs. Rolling back the API restores the previous selection policy.
Thread-owned network storage and retirement of those persisted entities are
later deliveries in the Epic.

## Dynamic storage preparation fails before CLI launch

The next delivery of [#37970](https://github.com/okou-ai/okou/issues/37970)
makes required stale-input cleanup and instruction normalization part of storage
preparation success. Unreadable cleanup mount information, unsafe cleanup paths,
failed removals, missing instruction sources, invalid filenames, and failed
instruction writes now return failure. Later preparation phases stop, and
`guest-storage-apply` exits with code 1. The existing Runner failure path then
rejects preparation before starting the CLI.

Missing stale paths remain successful cleanup. Atomic instruction replacement,
cached-child preservation, and symlink protections remain in place. Permission
failures for the `lost+found` directory directly at a mountpoint root may leave
that filesystem metadata intact; other removal failures are fatal. Temporary
staging cleanup remains best effort. Completed filesystem changes are not rolled
back, and already running parallel downloads still finish before aggregate
failure is returned.

The storage manifest, decoded-file framing, and process exit-code contracts are
unchanged. Old API with new Runner/Guest works with existing valid inputs. New
API with old Runner/Guest retains the old best-effort cleanup behavior until the
Runner image is upgraded; deploying the API alone does not enforce this policy.
Runner and Guest are shipped together, and both stdin and fallback-file callers
already reject nonzero helper exits. This change requires no database migration.

## Pi turn-end stdout boundaries (2026-10-08)

The CLI's Pi JSON/RPC serializer omits `turn_end.message` and
`turn_end.toolResults`, following the existing `agent_end.messages` contract.
Every message remains authoritative in its individual `message_end` record and
the persisted session. Native extension callbacks retain the full turn event;
`agent_settled` still owns the terminal result.

New CLI with old Guest is compatible: old Guest already ignores `turn_end`,
and the marker no longer aggregates messages into a potentially oversized line.
New Guest with old CLI recognizes `turn_end` and drains an over-limit duplicate
boundary without dropping the next record. Run-captured CLI packages and Guest
images can coexist across versions. The oversized `turn_end` guard can be
removed only after pre-change installed CLI images, captured queued/active runs
and supported rollback packages have drained; track that verification in
[#37930](https://github.com/okou-ai/okou/issues/37930). Unknown and consumed records
such as `message_end` remain fatal above the 16 MiB line limit. Rolling back
both components restores the previous oversized-turn failure. No stored data
migration or API change is required.

## Desktop compatibility policy is source controlled

The API's `src/lib/desktop-compatibility.json` owns the global minimum Desktop
version. `null` keeps enforcement disabled; a stable version at least `0.51.0`
requires a reviewed PR and API release to activate. Public policy responses,
host registration/claim admission, and Sparkle metadata use that same value.
Desktop clients and HTTP contracts are unchanged by the configuration-source
change. Old environment-based APIs and new code-configured APIs both remain
disabled during this release; the previously unset environment variable is
removed without a second configuration reader.

Activation is separate. Verify the policy embedded in every serving and intended
rollback API before enabling it; an API rollback restores that release's floor
as well as its code. Preserve authenticated completion/stop for draining hosts,
and retain the Electron update feed and ShipIt relaunch bridge. See
[Desktop version policy](desktop-version-policy.md) and activation issue
[#38098](https://github.com/okou-ai/okou/issues/38098).

## Native Desktop session authentication (expand release)

Native Desktop uses additive session-authenticated host routes. Migration
`1344_computer_use_session_auth` adds session binding, provider-validation time,
connection generation, and command-claim generation; `token_hash` becomes nullable
for new Native hosts. Legacy writes remain valid. Deploy the expanded API fully
before releasing the Native client. Old installed clients retain their host-token
protocol during the upgrade window; new Native against an old API stays offline
and never acquires a host token. Existing installation and chat host identities
are preserved. Legacy contraction requires the Desktop version floor and API
serving/rollback drain. See [the full contract](desktop-session-auth.md).

## Organization Usage Allowance retired

Organization Usage Allowance is retired from the App, API contracts, run and
managed-operation admission, pending launch, Pi memory reserves, settlement,
billing status, billing reconciliation and Stripe entitlement publication. New
usage consumes member credit grants and shared credits, retaining the existing
launch fence, pending-event claim, attribution, atomic debit/expiry writes, Social
publication and idempotency. A partial pending-event claim still rolls back and
defers the batch; a missing financial row remains an error. No processed event is
repriced or charged again.

**Owner decision and destructive scope.** Linghan confirmed on 2026-10-08 that
Allowance was issued only to the Okou team, not external users, and explicitly
requested deletion of its historical data rather than archive compatibility.
Migration `1356_drop_organization_usage_allowance` drops the entitlement, window
and allocation tables plus the hourly `allowance_units`, `short_window_id` and
`weekly_window_id` columns and their dependent constraints/indexes. It does not
convert discarded rights into credits, alter wallets, delete ordinary usage or
reprice/replay processed events. This is an owner-supplied usage boundary, not a
new production census. Shipped migrations and snapshots remain immutable.

**Owner-accepted single-release cutover.** On 2026-10-08, Linghan separately
accepted production errors from the outgoing API during the deployment window
and selected this single-PR contraction instead of a preparatory release.
This acceptance is not limited to organizations that received Allowance:
outgoing billing-status and finalized-usage queries reference the dropped
tables even for external organizations with no Allowance rows. Shared usage,
settlement/compaction and other old readers/writers of the retired shape can
also fail. Errors can include PostgreSQL `42P01` for a missing table.

Stop vm0-atom Allowance issuance before the cutover; its merged retirement PR
alone does not prove serving deployment or stopped issuance. The existing
production release runs migrations before updating/promoting the API and does
not establish an API/cron serving drain. Applying 1356 while the outgoing API
still serves is therefore an explicitly accepted interruption, not a safe
rolling deployment. The exposure starts when the contracted schema becomes
visible and ends only when the matching API is fully serving and incompatible
API/cron work has drained. A failed or delayed promotion extends it until
forward recovery completes; there is no guaranteed duration based on nominal
pipeline timing.

Reversing that order is not supported: the new API's credit-only hourly INSERT
omits the old required `allowance_units` column, so the new compactor must not
run before 1356. The rollback floor below only protects later rollback choices;
it does not prevent the outgoing API's migration-to-promotion errors. This
recorded risk acceptance permits retaining the single-PR design and merge
review. It does not authorize immediate production deployment, migration,
issuance operations or Stripe writes, and is not evidence of their execution.

**Rollback floor.** The production rollback resolver requires the first-parent
`main` commit that adds 1356. No earlier API is a supported rollback target
against the contracted DB. Recovery below that floor needs a reviewed forward
migration; restoring declarations alone cannot recover discarded data.

**App/API.** The old billing schema used a plain Zod object with nullable optional
`usageAllowance`, so omission by the new API is valid. Old App code conditionally
renders its card only when the field exists. The new App ignores the old API's
extra field; response validation strips unknown fields when enabled. Production
Platform transport does not normally validate responses, but the new view never
reads that extra field. The new billing response never emits `usageAllowance`.
Credit balances and personal Claude/Codex subscription limits/Fast semantics
are unchanged. Usage reports now sum only recorded `creditsCharged`, not the
discarded team Allowance portion. Runner usage protocols and billing attribution
are unchanged; no Runner deployment is needed. The authenticated staff
compaction response also removes `allowanceUnits`, `affectedShortWindows` and
`affectedWeeklyWindows`; no App or Runner consumes these fields.

**Stripe.** Retired `purpose = usage_allowance` subscriptions/invoices remain
excluded from ordinary Plan, Atom and purchased-credit grants, even when a price
ID overlaps a configured grant/Plan price. The existing independently identified
concurrency add-on on an archive-root subscription still reconciles without
reactivating Allowance. This does not normalize away the archival root marker or
invent a live Plan/usage-pack grant under it. Allowance lines mixed into a normal
main subscription are not a Plan, usage-pack or concurrency line. Surviving line
processing retains its existing scope and shared subscription operations preserve
unrelated items/discounts/schedules.
The API no longer renews, projects, schedules or cancels an Allowance entitlement.
This code removal does not cancel any existing Stripe subscription, refund a
payment or convert unused rights to credits. Those are separate owner/operator
decisions; no production or Stripe writes are part of this PR.

**Credit-only accounting and cleanup.** Finalized usage no longer joins
Allowance allocations or exposes window IDs/units. Member, organization and
chat-run totals use only the originally recorded credits. Compaction retains
bounded raw consumption, billing identity fences, attribution capture,
quantity/credit conservation and transactional rollback; all Allowance window
reconciliation is removed. Organization/user privacy deletion still erases
ordinary raw/hourly usage in its existing order, but has no Allowance archive
cleanup. Historical engineering records document previous behavior, not a
serving compatibility contract. The retained Stripe classification above is
external financial isolation, not a local archive reader or grant fallback.

## Connector catalog payload contraction (not yet production accepted)

Migration `1351_drop_connector_catalog_payload` physically drops only
`connector_catalog_entries.payload`. The canonical schema and runtime now share
one payload-free table declaration with the same `(hash, slug)` primary key and
required projections; the existing runtime export path remains supported.
No retained generation, projection, pointer, Run/permission capture, preparation
receipt or skill registration is rewritten or deleted. Publisher hashing and
permission-summary derivation are unchanged; an existing-hash retry still does
not update stored summaries.

**Release gate.** Do not merge or release this contraction until a separate
successful production release contains preparation migration 1348 and its
payload-independent API, and the outgoing dual-writing API has demonstrably
exited. Do not ship preparation and DROP in the same production workflow run:
migrations execute before API promotion, so DROP would break the serving dual
writer. A merged PR, green CI or a historical payload-only drain confirmation
is not evidence that this new boundary has passed. The official rollback
resolver must continue requiring the canonical first-parent main introduction
commit for preparation migration 1348; do not remove or lower that floor.

Preparation [#38099](https://github.com/okou-ai/okou/pull/38099), merged at
`9d3a1b406f1f44b224c33046162df01a77e035f8`, shipped independently in API 1.715.0
(release [#38145](https://github.com/okou-ai/okou/pull/38145)) at
`a17b5e424a8944d832875c8097c0a4330d172bc9`. The successful
[production API promotion job](https://github.com/okou-ai/okou/actions/runs/37794041015/job/113376087119)
completed production migrations before API promotion and finished at
2026-10-08 14:56:47 UTC. Git ancestry confirms it contains the canonical
preparation commit. Ethan subsequently confirmed that the old serving API had
exited and authorized review/merge of the contraction. This is the operator's
drain confirmation, not an independently measured invocation inventory.
The separate preparation-release boundary is satisfied; physical contraction
is not yet production accepted.
This change does not execute production migrations, approve a release or close
[#37899](https://github.com/okou-ai/okou/issues/37899); acceptance follows a
successful contraction production release and verification.

## Connector catalog payload-independent API (preparatory release)

Migration `1348_connector_catalog_payload_independent_api` keeps the physical
`connector_catalog_entries.payload` column but drops its NOT NULL constraint.
The ten required projections become NOT NULL; `mcp` remains nullable for
non-MCP connectors. The migration performs no backfill, summary recomputation,
hash/slug rewrite, pointer move or deletion. An incomplete retained projection
fails the transactional migration rather than silently fabricating data.

The API writer now inserts only projections, and all readers use direct narrow
column selections without payload fallback. The runtime ORM uses the shared
column factory without payload, including implicit SELECT/RETURNING. The
physical schema alone retains nullable payload for migration generation and
schema equivalence; it must not be imported by API queries.

**Mixed versions.** Migrations still run before API promotion. The immediately
outgoing #37900-or-later dual writer supplies every required projection, so it
can continue reading and writing while the column is retained. A payload-only
writer cannot insert after the constraint change and must already be excluded
from serving. The new API needs migration 1348 before writing without payload;
its readers accept projected rows regardless of whether payload is populated.
App/CLI/Runner responses and current/captured generation lookup are unchanged.
Entry preparation receipts, same-hash retries, skill registration and
complete-generation pointer publication retain their existing ownership/order.
Permission-summary derivation is unchanged.

**Rollback floor.** The resolver loaded from main resolves the first-parent
commit introducing migration 1348 and requires every target to contain it,
failing closed on missing/invalid history before artifact or host access. This
excludes payload-dependent API versions without pinning a branch-only SHA.
Merging this preparation advances the official rollback floor; until a release
containing it succeeds, there is no earlier supported rollback target. That
restriction does not itself prove a successful deployment or serving drain.

**Next stage (#37899).** First publish this API and verify the outgoing dual
writer has exited. Only then may a separate PR physically DROP payload. Do not
combine the two migrations in one production release: applying DROP before API
promotion would break the still-serving dual writer. Keep the preparation
migration in the rollback resolver's history through that contraction. This PR
neither publishes nor executes any production migration and does not close
[#37899](https://github.com/okou-ai/okou/issues/37899).

## Connector catalog column reads (expand release)

Migrations `1339_expand_connector_catalog_entry_columns` and
`1340_backfill_connector_catalog_entry_columns` prepare removal of the large
`connector_catalog_entries.payload`. The entry identity remains `(hash, slug)`
and the catalog pointer remains `(schema_version, hash)`. No publication,
Runner, App or API response schema changes.

Independent columns hold `label`, `description`, `category`, `icon`, `tags`,
`generation`, `auth_methods`, `mcp`, `skill`, `firewall` and
`permission_summary`. The API computes the summary during immutable entry
preparation using the existing permission and compact-default-policy semantics.
It is application-derived, not part of the publisher artifact or its hash.
Any later change to that derivation must explicitly backfill retained hashes;
same-hash writer retries do not refresh immutable entries.

The first migration only adds nullable columns. The second backfills every
retained generation, separately from the DDL transaction so the data rewrite
does not retain the column-addition lock. `mcp` stays SQL NULL for connectors
without an MCP descriptor. New writers atomically insert every column together
with `payload`; skill registration and complete-generation pointer publication
keep their existing order and interruption behavior.

**Reads.** List, search, discovery, status, connected briefs, one-click connect
items and onboarding catalog reads select display/authentication columns and
the stored permission summary. Account-status projections select only slug,
auth methods and MCP metadata, reusing the existing executable-method rules.
The display catalog cache contains no firewall or skill objects. Permission details select runtime fields only for the named
slug. Runtime captures, sync, Pi recapture and staff diagnostics use independent
column selections instead of returning the complete payload. (Staff
diagnostics were later removed; see
[diagnostics removal](#connector-catalog-diagnostics-removed-2026-10-07). Pi
recapture was retired with the
[stable-context tables](#pi-stable-context-tables-retired-2026-10-07).) Runtime consumers
that materialize full executable connectors still load auth, skill and firewall
fields; this change does not claim a new minimal runtime projection or measured
S1–S3 latency improvement.

**Mixed versions and bounded fallback.** Migrations must run before promotion
of the new API. The previous API keeps reading and writing `payload`, including
inserts after the backfill. Therefore the new columns are temporarily nullable,
and `connector-catalog-columns.ts` uses SQL `COALESCE` per field for those rows.
Permission-summary fallback computes the same summary inside PostgreSQL; no
whole payload crosses the database boundary. MCP absence is distinguished from
an old writer using the required `auth_methods` projection, so normal non-MCP
reads do not consult payload. Both old and new writers can publish during this
window. A new API against a pre-expansion database is unsupported. Rollback to
the previous API remains supported because payload is preserved and dual-written.

**Contraction gate.** [Follow-up #37899](https://github.com/okou-ai/okou/issues/37899)
must verify that payload-only writers and
rollback targets have drained, reconcile any remaining unprojected retained
rows, remove the field-level fallbacks, and make required projections NOT NULL
(`mcp` remains optional). Physically dropping payload additionally requires that
no serving or rollback API still declares/writes it. Migrations precede API
promotion, so this release's dual writer cannot serve while payload is dropped.
Ship a payload-independent writer before the destructive migration unless an
explicit deployment boundary guarantees the dual writer has drained. Do not
combine these stages merely because reads no longer return payload.

This PR prepares that contraction; it neither drops payload nor activates or
releases production changes.

## Pi stable-context tables retired (2026-10-07)

The Pi stable-context cache never had a production reader and is removed from
the API: run launch builds the stable prompt directly, and the API no longer
invalidates, records demand for, materializes, garbage-collects or drains
stable-context heads, artifacts or Pi resource snapshots. The materialize cron
response no longer has a `stableContext` field (only Vercel cron calls it).

Migration `1343_retire_pi_stable_context` drops `pi_stable_context_heads`,
`pi_stable_context_artifacts`, `pi_stable_context_artifact_resources` and
`pi_resource_snapshots` with their indexes, checks and foreign keys. It keeps
the reserve-before-IO publication fence for Agent instructions and Workflow
volumes, which still rejects an older, slower upload with `409` once a newer
reservation exists. Its tables are renamed: `pi_stable_context_generations` to
`storage_publication_generations` and `pi_stable_context_publications` to
`storage_publication_tokens`. Their primary keys, generation checks and the
token index are renamed to the matching `storage_publication_*` names. The
generation table drops `publication_state` and its state check, which only the
stable-context reader consumed.

Dropping the three tables with foreign keys briefly takes exclusive locks on
`agents`, `storages` and `storage_versions`. The default 1s `lock_timeout`
bounds the wait, so a busy moment can fail the migration; a retry resolves it.

Database ordering: migrations run before API promotion. Every API built before
1343 writes the dropped tables and the old generation and publication table
names on Agent update, instructions, Workflow create/update/delete/visibility,
Storage HEAD publication, connector, permission, feature-switch and catalog
writes, Clerk and Agent deletion, and its crons. It fails on those paths
(`42P01`/`42703`) until it drains. This is not rolling-compatible; the
interruption while the previous API drains is accepted by explicit owner
decision (2026-10-07). No preparatory release or compatibility branch is
required. Acceptance of that risk is not an instruction to deploy.

Rollback floor: the rollback resolver resolves the first-parent `main` commit
that added `1343_retire_pi_stable_context.sql` and rejects earlier targets
before artifact or host access. Recovering below it requires a reviewed forward
migration that recreates the old tables before an older API serves.

## Connector catalog diagnostics removed (2026-10-07)

Staff diagnose connector catalog state with masked database queries against
`connector_catalog` and `connector_catalog_entries`. The API no longer computes
catalog diagnostics anywhere.

**Staff endpoint.** The staff-only, OkouDebug-gated `diagnostics` route of
`connectorCatalogContract` (`GET` under `/api/connector-catalog`), its handler,
and the Settings debug "Connector catalog" block with its translations are
removed. An old Platform build that opens Settings debug as staff already
accepted `403` and `404` from this endpoint as "no diagnostics"
(`accept(..., [200, 403, 404])`) and rendered nothing. Against a new API the
path falls through to the `:connectorSlug` detail route, which returns `404`
for the non-existent `diagnostics` connector (or `403` without
`connector:read`), so the old block still renders nothing. Only a catalog
outage (`503`) would surface as an error, inside that staff-only block. No CLI
command or user flow reads this endpoint. A new Platform against an old API
makes no request.

**Cron sync response.** `/api/cron/sync-connector-catalog` now returns only
the writer's report of the attempt it just made: `{ outcome, failureCode }`.
`schemaVersion`, `state`, `active`, `pointer`, `filtering` and
`credentialStorage` are removed, together with the API diagnostics service,
the connector credential storage readiness counts and their schemas. The
remaining sync schemas (failure code and attempt report) now live in
`contracts/connector-catalog-sync`. Sync behavior (accept, unchanged, reject,
and keeping the serving pointer after a rejection) is unchanged.

The release workflow no longer calls the production catalog synchronizer after
API deployment. The hourly Vercel cron owns scheduled publication and ignores
the response body. Query the masked database for the serving generation and
entry count; there is no release-time catalog readiness check.

There are no schema, data or writer behavior changes.

## Frozen model provider state dropped (2026-10-07)

Owner decision (Ethan, 2026-10-07): data no live reader uses is removed.
Custom migration `1337_retire_unused_model_route_data` clears
`run_model_catalog.pi_route_class` values other than `gpt-codex`, resets the
already-rejected `chat_threads.selected_model = 'deepseek/deepseek-v4-pro'`
pins to NULL (unpinned, which resolves to Auto). The retired-vendor
`built_in_model_keys` rows are deleted by main's
`1335_clear_unselectable_thread_models_and_unused_model_keys`; the owner revokes
those keys upstream outside this change.

Generated migration `1338_retire_model_route_state` narrows
`chk_run_model_catalog_pi_route_class` to NULL or `gpt-codex` (the table has a
handful of rows, so the check is added and validated directly), drops
`model_provider_auth_sessions.sandbox_id` with its partial index, and drops the
frozen OAuth copies on `model_providers`: `token_expires_at`,
`needs_reconnect`, `last_refresh_error_code`, `workspace_name`, `plan_type`,
`subscription_reset_period` and `subscription_next_reset_at`. The live values
are on `model_provider_accounts`, which every current reader already uses. The
new API selects explicit `model_providers` columns, and the Pi memory phase 2
credential gate uses the account's `needs_reconnect` only.

Database ordering: migrations run before API promotion. An API built before
1338 selects every `model_providers` column when listing, connecting,
activating or deleting personal subscription accounts, and every
`model_provider_auth_sessions` column in the Claude Code and Codex device
authorization flows, so those paths receive `42703` until it drains. This drop
is **not rolling-compatible**. A new API against the old schema is compatible
because it never names the dropped columns. An API built before 1337 that is
still draining is unaffected by the data changes: the cleared pins were
already rejected.

**Accepted rollout interruption (1338, model provider columns):** Ethan
explicitly accepted (2026-10-07) a brief unavailability during deployment while
the outgoing API drains, so personal subscription account and device
authorization reads from a pre-1338 API may receive `42703` in that window. No
preparatory release or old-column compatibility branch is required. Acceptance
of that risk is not an instruction to deploy.

Rollback floor: the rollback resolver resolves the first-parent `main` commit
that added `1338_retire_model_route_state.sql` and rejects earlier
targets before artifact or host access. Recovering below it requires a reviewed
forward migration that recreates the columns before an older API serves. This
does not claim production activation.

## Ultrafast service tier retired (2026-10-07)

Ultrafast is retired across the App, API, contracts, runner and proxy pricing.
Migration `1336_retire_ultrafast_data` clears stored Ultrafast selections:
`chat_threads.codex_service_tier`, `org_members_metadata.service_tier`, and the
`model_routes.service_tiers` / `default_service_tier` values. Migration
`1338_retire_model_route_state` then limits route tiers to `priority`
and adds `chk_chat_threads_codex_service_tier` (NULL or `fast`) and
`chk_org_members_metadata_service_tier` (NULL or `priority`). The two new checks
are added `NOT VALID` and validated in a separate statement after 1338 repeats
the Ultrafast cleanup, so a value written by a draining pre-1338 API cannot fail
validation. 1338 runs in one transaction, so the lock taken by `ADD CONSTRAINT`
is held through the `VALIDATE` scan, bounded by the migration statement
timeout.

New requests that send `ultrafast` are rejected with 400. Immutable history
(thread events, snapshots, client caches and queued chat input model
selections) still reads a stored Ultrafast value as Standard (null) instead of
failing; `agent_runs.codex_service_tier` and usage `.ultrafast` categories stay
readable for historical runs and billing. An API built before 1338 that is
still draining can only fail when it writes `ultrafast`, which the current
catalog no longer offers. Rolling back below this change restores no Ultrafast
offering because 1336 removed it from the catalog data.

## Built-in model candidate cooldown removed (2026-10-07)

Owner decision (Ethan, 2026-10-07): Auto has one platform route, so a provider
failure fails that run and the next request tries the route again. The API no
longer reads or writes a route cooldown when resolving Auto for new runs, queued
claims or Pi memory maintenance. The staff cooldown diagnostics endpoints
(`GET`/`DELETE /api/model-providers/cooldown-diagnostics`), their Settings
debug block, and the test-runtime cooldown actions are removed. Generated
migration `1338_retire_model_route_state` drops
`built_in_model_candidate_cooldown`; its rows were transient deadlines with no
history value, so nothing is converted or archived.

Runner: the mitm addon no longer observes or reports model provider failures,
and the Runner no longer passes `OKOU_MITM_RUNNER_TOKEN` to mitmdump. Runners
released before this change still `POST
/api/runners/runs/:runId/model-provider-failures` best-effort; the API
authenticated those reports and returned `{ "outcome": "ignored" }` until they
drained. The endpoint, its contract, its runtime API schema entry and the
generated Rust bindings were removed on 2026-10-09 once production Runners
(0.220.18 and later, inside the rollback floor) had stopped sending reports.
A Runner older than that now receives `404` for its best-effort report.

App: a stale App build that opens Settings debug as staff receives `404` from
the removed diagnostics endpoint inside that debug-only block; no user flow
depends on it.

Database ordering: migrations run before API promotion. Every API built before
1338 queries the table while resolving the Auto route for run claims and Pi
memory maintenance, and writes it from runner failure reports, so it receives
`42P01` on those paths until it drains. This drop is not rolling-compatible.
A new API against the old schema is compatible because it never names the
table.

**Accepted rollout interruption (1338, cooldown table):** Ethan explicitly accepted
(2026-10-07) a brief unavailability during deployment while the outgoing API
drains, so Auto run claims, Pi memory maintenance and runner failure reports
handled by a pre-1338 API may receive `42P01` in that window. No preparatory
release or old-table compatibility branch is required. Prefer the same rollout
as 1332/1333 or low traffic. Acceptance of that risk is not an instruction to
deploy.

Rollback floor: the rollback resolver resolves the first-parent `main` commit
that added `1338_retire_model_route_state.sql` and rejects earlier
targets before artifact or host access. Recovering below it requires a reviewed
forward migration that recreates the table before an older API serves. This
does not claim production activation.

## OpenRouter US routing removed (2026-10-07)

Platform OpenRouter traffic always uses the global `https://openrouter.ai/api/v1`
endpoint. The US model allowlist, the `https://us.openrouter.ai` origin, the
routing context on `getModelProviderPiEndpoint` / `getModelProviderFirewall`,
and the inline per-run model-provider firewall that carried a US base URL are
deleted. Managed Auto and Pi memory runs now use the built-in
`openrouter-codex` firewall by name, as member-owned and non-allowlisted
built-in runs already did.

Readers of captured US endpoints are removed too. A queued or active Pi run
whose captured `OPENAI_BASE_URL` is the US endpoint would no longer match the
global Pi endpoint and would fail Pi model configuration. Production showed no
Built-in US-routed run since 2026-10-04 and no in-flight run carrying a US
endpoint, so no drain gate or migration is required. Runner, guest, and mitm
code never special-cased the US origin; old Runners receive the same built-in
firewall name they already resolve. No persisted schema changes.

## Unselectable chat thread models and unused built-in keys cleared

Data-only migration `1335_clear_unselectable_thread_models_and_unused_model_keys`
has two parts.

It deletes the `built_in_model_keys` rows for `zai`, `anthropic`, `openai`,
`deepseek`, `minimax` and `moonshot`. Built-in runs read only the
`openrouter` key (`AUTO_RUN_KEY_VENDOR`). Every API at or above the 1332
rollback floor selects or resolves only that vendor, so no deployable API
reads the deleted rows. MaskDB (2026-10-07) showed exactly these seven
vendors. The deleted keys still need to be revoked at each vendor; that is a
separate operator action.

It also returns chat threads to Auto when the API cannot resolve their stored
`selected_model`. A selection is resolvable when it is a `run_model_catalog`
model (active or replaced) or the upstream id of a `model_routes` row. These
are the two lookups of `catalogModelForSelectedId`, evaluated against the
database catalog at migration time. MaskDB (2026-10-07) showed 252 such rows
across 43 users. They are leftovers of retired providers, for example
`claude-sonnet-4.6` (213), `vm0-model` (11), `kimi-k2.5`, `claude-opus-4.6`,
`deepseek/deepseek-v4-pro`, MiniMax ids, `deepseek-chat`, `gpt-5.3*` and
`codex`. On production these rows, and the 65k threads pinned to active
catalog models without a route, were already remapped by an operator SQL on
2026-10-07 (unrouted models to their subscription successors or `okou-1.0`,
unknown ids to `okou-1.0`, each with its `model_selection_updated` event), so
this part is expected to change no production row; it still cleans other
environments. Each thread is changed the same way as picking Auto in the model
selection route, in one transaction:

- `selected_model` and `codex_service_tier` become NULL and `updated_at` is
  set; `model_settings` is kept.
- One `model_selection_updated` event with a NULL model is appended to the
  owner's `(user_id, org_id)` stream. A `service_tier_updated` event with a
  NULL tier follows it when a tier was cleared. Sequence positions are
  reserved per stream in key order, as in 1213 and 1299.
- Threads without an agent have no event stream and get no event.
- The update re-checks the selection under its row lock, so a selection an API
  changes concurrently is kept and gets no event.

Clients apply the appended events after their snapshot position. No snapshot
or cache needs a rewrite.

Old and new APIs both treat NULL as Auto, so either order of migration and API
deploy is compatible. The migration adds no schema and does not move the
rollback floor. Rolling back does not restore the deleted keys or selections;
nothing at or above the floor reads them.
`scripts/test-unselectable-thread-model-cleanup.ts` covers the snapshot
change, the appended events and their sequence, retained selections, the
remaining OpenRouter key and an idempotent rerun.

## Connector catalog Release 2 follow-up

Release 1 and Release 2 are deployed (production API 1.712.5, `82cab4d`, with
migration 1334 applied). This follow-up removes the remaining compatibility
surface and records the final behavior; it has no schema migration.

**Diagnostics `catalogVersion` alias removed.** Staff diagnostics and the cron
sync response now report `active: { catalogDigest }` only. The
`active.catalogVersion` hash alias is gone from the contract, the API, the
Platform debug panel (which shows the digest instead of an "active version")
and its translations. Ethan confirmed (2026-10-07) that the old clients have
exited; a staff debug panel loaded before the deploy shows the field as "None"
until it reloads. A new App against an older API ignores the extra field; the
release workflow only checks `active != null`. (Superseded: staff diagnostics
and the Platform debug panel were later removed, the cron sync response no
longer carries `active`, and the release workflow checks only `outcome`; see
[diagnostics removal](#connector-catalog-diagnostics-removed-2026-10-07).)
Other `catalogVersion` fields are not this alias and stay:

- The persisted connector permission baseline and Runner execution context
  `catalogIdentity.catalogVersion` (`storedConnectorPermissionBaselineSchema`,
  `catalogIdentityFromCapture`). It is a required field of a strict, persisted
  v1 shape that stored rows and Runner payloads still carry; removing it would
  need a baseline schema version change and a Runner-side rollout.
- The Runner builtin firewall catalog `catalogVersion`
  (`/api/runners/builtin-firewalls` response, `RunnerRuntimeFirewallCatalog`).
  It is a short digest label the Rust Runner and the mitm addon validate as
  non-empty and store in their caches; it is a Runner protocol field.
- The publication label `catalogVersion` of the v4 pointer and artifact, which
  validation uses to bind the canonical release key, and which the preview
  seed response, writer logs and dev seed report. It is not stored.

**`invalid-compression` removed.** The failure code had no producer after the
gzip snapshot codec was deleted in Release 2. It is removed from
`CONNECTOR_CATALOG_VALIDATION_FAILURE_CODES` and therefore from the cron
`failureCode` enum. No persisted state carries failure codes any more.

**Required and optional entries.** The current reader contract (after #37893)
is described under
[business readers](#connector-catalog-business-readers-on-pointer-and-immutable-entries):
every reader omits an agent-enabled connector that is missing from the
captured generation, as if the user had never authorized it, and Runner
runtime sync reports the target `absent`. Run launch omits it while the
connector stays enabled.

**Publication cadence and concurrent callers.** The hourly cron is the only
scheduled production publisher. API releases no longer invoke the synchronizer;
a new official publication may wait until the next hourly attempt. Preview
initialization remains separate and does not target production.

The authenticated sync endpoint remains available for operator calls. Overlapping
attempts still read `connectors/v4/active.json` independently and last writer wins;
removing the release caller does not serialize all possible calls. If an older
publication commits last, the pointer can briefly return to the previous complete
generation until the next hourly sync. Readers always see a complete generation,
and runtime wakeups follow actual pointer switches. No compare-and-swap or
monotonic guard is introduced.

**Final catalog architecture.** The former staged v4 rollout guide is removed;
its still-current content is:

- The pointer must name `connectors/v4/releases/<catalogVersion>/catalog.json`;
  only artifact schema version 4 is accepted.
- An explicit `mcp` descriptor, never the `-mcp` naming convention, makes a
  connector MCP. MCP descriptors declare `skill: { kind: "none" }` and register
  no skill resources. Methods filtered by capability are expected and do not
  reject an otherwise valid catalog.
- An accepted change to a connector's runtime-bearing `mcp`, `authMethods` or
  `firewall` wakes affected builtin HTTP and MCP Runs so the Runner resolves the
  current endpoint, credentials and firewall policy. Removing a builtin
  connector from the catalog wakes active Runs too, and runtime sync reports
  the registered target `absent`, as if it were never authorized: the Runner
  drops its policy and credential injection, and new launches omit the
  connector. If a later generation restores the connector, the next wakeup
  reports it `available` again. Builtin MCP execution and Automatic
  authentication are described under
  [Builtin MCP execution](#builtin-mcp-execution).

## Connector catalog Release 2 contraction (migration 1334)

Release 2 removes the legacy connector catalog storage and writer state that
Release 1 (#37820, #37861) stopped reading. Migration
`1334_connector_catalog_release_2_contraction` drops
`connector_catalog_runtime_projections`,
`connector_catalog_runtime_projection_sets`,
`connector_catalog_compatibility_evaluation`,
`connector_catalog_active_snapshot` and `connector_catalog_sync_state`
(dependents first, without `CASCADE`; the only foreign keys are among these
tables). It also drops `connector_catalog.activated_at`, `catalog_version`,
`catalog_header` and `entry_slugs`, and the redundant
`connector_catalog_entries` projections `label`, `description`, `category`,
`auth_methods`, `firewall`, `storage_name`, `version_id` and `mcp_endpoint`.
No reader selected those projections; every consumer reads `payload`. The
final schema is the pointer `connector_catalog(schema_version PK, hash)` and
immutable entries `connector_catalog_entries(hash, slug, payload)` with
`PK(hash, slug)`. There is no data conversion or backfill: existing entry rows
and payloads, including generations captured by Runs, Pi contexts and
permission baselines, are kept unchanged and stay readable by hash.

**Writer.** `/api/cron/sync-connector-catalog` (hourly; no production release
workflow call) downloads `connectors/v4/active.json` with a plain GET. A
pointer whose digest equals the serving hash is `unchanged` without downloading
the catalog, because only complete, validated generations are ever published.
Otherwise it downloads the referenced release and keeps every existing
validation boundary: pointer schema and canonical release key, size limits,
byte digest, artifact schema, public-leakage and relationship checks, and the
bundled skill storage/version identity checks at registration. It then
prepares the complete generation (reusing entries already present at that
hash, registering missing skills, and inserting the rest with batched
`INSERT ... ON CONFLICT DO NOTHING` of at most 100 rows) before one
transaction upserts the pointer. The upsert is conditional, so exactly one
concurrent writer observes a given switch, including the very first
publication; runtime wakeups follow that commit. A failure or interruption
before the pointer commit leaves the previous generation serving and at most an
unreferenced partial generation that a retry at the same hash completes.
Entries of earlier hashes are never rewritten or deleted, and unreferenced
generations are not garbage-collected.

One scheduled writer is assumed and last writer wins; there is no sync state,
compare-and-swap, revision, ETag reuse or rejection cache. A rejected
publication is not persisted: each attempt logs a warning with the failure
code and is revalidated by the next attempt, while the current pointer keeps
serving. Compatibility is evaluated on demand from captured entries and the
current executable capability; the persisted evaluation and its cron
reconciler are removed. Existing hash, schema, source, capability-digest and
validator-identity fences (including the permission-baseline validation
authority fast path) are unchanged, and there is no legacy gzip or R2 read
fallback. The connectors package drops its now-unused gzip snapshot codec.

**Response contracts.** The cron sync response is the staff diagnostics body
(`schemaVersion`, `state`, `active`, `pointer`, `filtering`,
`credentialStorage`) plus `outcome` and `failureCode` for the attempt just
made. `state` is `stale` when that attempt was rejected while a pointer
serves. `lastAttempt`, `lastSuccessAt`, `rejectedCandidate` and
`active.activatedAt` are removed. (`active.catalogVersion`, then a hash
alias, was removed by the [Release 2 follow-up](#connector-catalog-release-2-follow-up).) The cron sync response was later reduced to
`outcome` and `failureCode`; see
[diagnostics removal](#connector-catalog-diagnostics-removed-2026-10-07).
The production release workflow no longer calls the synchronizer or consumes
its report. The preview seed response keeps
`catalogVersion` (the validated publication label, which is not stored),
`catalogDigest` and the sorted `connectorSlugs` of the validated publication,
so the CI preview workflow is unchanged.

**Compatibility and drain.** Migrations run before the API is promoted, so the
previous production API serves while 1334 is applied.

- A Release 1 API (descending from `e664957caa2056a336595e55f475001b81247fd0`,
  #37861) reads only `connector_catalog(schema_version, hash)` and
  `connector_catalog_entries(hash, slug, payload)` in business, runtime, App
  and staff paths, so those keep working against the contracted schema. Its
  catalog writer (cron sync, compatibility reconcile, preview and dev seed)
  still names the dropped tables and columns and fails with `42P01`/`42703`
  before it can change the pointer; the next scheduled sync from the new API
  publishes normally. No user-facing read depends on that writer.
- An API without #37861 (production served API 1.712.3,
  `e1e0a3851dcdb35c6b7f8ddb41bc21cd746f50f7`, when this change was written)
  still reads the legacy stores in business paths. It must never serve after
  1334: connector lists, runs and diagnostics would fail.
- A new API against a database without 1334 is unsupported: its pointer insert
  omits the old `NOT NULL` columns.

**Required order.** Merging to `main` is not a deployment, but the next
release applies 1334 automatically before promoting its API. Therefore:

1. A release containing #37861 must first be deployed to production through
   the normal release path, and production `/api/build-info` must report a
   commit descending from `e664957caa2056a336595e55f475001b81247fd0`.
2. Every API instance and background task built before #37861 must have
   drained, so the only API that can serve while 1334 runs is a Release 1 API.
3. Only then may this change merge, so that its release is the one that runs 1334. If it merges earlier, Release 1 and Release 2 would ship in one
   release and 1334 would run while a pre-Release-1 API serves.

This document does not record that those preconditions are met, nor any
production deployment, migration or query plan.

**Rollback floor.** The rollback resolver resolves the first-parent `main`
commit that adds `1334_connector_catalog_release_2_contraction.sql` and rejects
earlier targets before artifact or host access. It descends from the 1333
floor. After 1334 no earlier API is a rollback target: Release 1 APIs lose
their catalog writer and older APIs lose their catalog readers.

## Legacy chat thread provider pin columns dropped

Follow-up to the run model schema contraction below (#37856). Chat threads
persist only `selected_model`; every run resolves it to platform Auto or the
caller's personal subscription. The legacy `chat_threads.model_provider_id`,
`model_provider_type` and `model_provider_credential_scope` columns had no
reader that used them: every writer stored NULL, and the only reader
(`ownedChatThread`) parsed and discarded the values. No response, event,
snapshot, CLI or iOS payload carries them. MaskDB (2026-10-07) showed 1479
legacy rows with a type set, all with `model_provider_id` NULL and only
`built-in`, `codex-oauth-token` or `claude-code-oauth-token` types; nothing
reads those values. Generated migration
`1332_drop_chat_thread_provider_pin_columns` drops the three columns. There is
no data conversion or backfill.

Migrations run before API promotion. An API built before 1332 still declares
the columns, so its chat thread inserts, its `ownedChatThread` select and any
bare `select()`/`returning()` on `chat_threads` receive `42703` until it
drains. `chat_threads` is a hot table, so this is not a rolling-compatible
contraction. A new API against the old schema is compatible: it never names
the three nullable columns, so its inserts leave them NULL and its selects
ignore them.

**Accepted rollout interruption:** Ethan explicitly accepted (2026-10-07) a
brief unavailability of roughly ten-odd seconds during deployment while the
outgoing API drains, so chat thread reads and writes may receive `42703` in
that window. This bounded interruption is accepted for this contraction; no
preparatory release or old-column compatibility branch is required. Prefer the
same rollout as 1330 or low traffic. Acceptance of that risk is not an
instruction to merge or deploy this PR.

Rollback floor: the rollback resolver resolves the first-parent `main` commit
that added `1332_drop_chat_thread_provider_pin_columns.sql` and rejects earlier
targets before artifact or host access. That commit descends from the 1330
floor. Recovering below it requires a reviewed forward migration that restores
the columns before an older API serves. This does not claim production
activation.

## Additive immutable connector entry columns

> Superseded by the [Release 2 contraction](#connector-catalog-release-2-contraction-migration-1334):
> legacy tables, pointer metadata and entry projection columns described
> below no longer exist.

Migrations `1328_connector_catalog_entry_columns` and
`1329_backfill_connector_catalog_entry_columns` add and backfill `label`,
`description`, `category`, `auth_methods`, `firewall`, `storage_name`,
`version_id` and `mcp_endpoint` on immutable entries. The complete `payload`, `(hash, slug)`
identity, publication bytes and all reader contracts remain unchanged.
Apply these migrations before deploying the new API; new API/old database is
unsupported because full sync and preview initialization write the new columns.

Old API/new database continues to read and write payload-only entries. The
additive columns remain nullable for that overlap; old writers can leave them
empty after the backfill. Existing `(hash, slug)` entries are trusted preparation
receipts and are never rewritten on retry. Neither full preparation nor the
unchanged-catalog shortcut is a reconciliation pass. Do not switch readers to these columns
until old writers have drained and any remaining payload-only rows have been
reconciled in a separately authorized change. This PR does not switch readers
or establish a query-performance improvement.

Bundled skills project `storageName` and `versionId`; absent skills store NULL
in both columns. The storage prefix is derivable as
`__system__/volume/${storageName}/${versionId}` and is not an additional column.
The original skill descriptor and its validation remain in `payload`. Rollback
to the old API is supported without dropping columns or changing payloads.
Catalog skill registration reuses the metadata owned by an already registered
storage/version rather than comparing size, archive size, file count, message
or creator against another catalog copy. New versions still receive their
initial metadata from the validated artifact; concurrent registrations are
idempotent and cannot overwrite an existing version. Canonical system owner,
storage name, version and object-path identity remain enforced at the
registration boundary. Other storage writers keep their existing contracts.
The skill object path is derived from storage name and version without another
prefix validation during registration; artifact validation owns that check.
Readers continue using storage/version metadata for mount preparation.

Full preparation first lists existing entries for the candidate hash and reuses
them without revalidating payloads or their storage metadata. It registers all
missing entries' storage versions before publishing those entries via
`INSERT ... ON CONFLICT DO NOTHING`. Only after every entry write completes can
the owning acceptance transaction CAS-update the schema-versioned catalog
pointer. Entry existence is therefore a preparation receipt, and pointer
publication is the completed-generation receipt. The payload readback and
whole-generation manifest comparison are removed from preparation. Downloaded
artifact validation and the existing acceptance CAS/legacy bridge remain.
A losing or interrupted preparer may leave unreferenced storage versions or
partial entries; they are reusable on retry, with no garbage collector added.

Old and new APIs can coexist without changing storage/version or artifact
shapes. The old API may still reject a catalog whose redundant metadata differs
from the stored version; the new API accepts it and retains the storage-owned
metadata. Rolling back restores that stricter catalog acceptance behavior.
No production migration, deployment or storage write is executed by this PR.

## Connector permission baseline retirement

New API writers no longer persist `connectorPermissionBaseline` in Runner job
execution contexts, including memory-maintenance jobs. Claim resolves the
current connector catalog by the queued builtin slugs in one pointer/entry
query, then overlays current user grants. Connector targets, captured credentials,
custom connector policies, model-provider policies and Runner wire fields retain
their existing owners. The immutable catalog entry key remains `(hash, slug)`;
this change does not garbage-collect catalog generations or remove OAuth
`contract_hash` identities.

Stored-context readers strip the retired field, including malformed and future
baseline values, without changing Pi-generation negotiation or invalid-context
failure handling. Migration `1349_retire_connector_permission_baseline` removes
existing queue baselines without changing the rest of each execution context.

- **Old writer / new reader:** an old queued baseline is ignored; claim always
  refreshes permissions against the current catalog and current grants.
- **New writer / old reader:** the field was optional. The old reader takes its
  existing missing-baseline current-catalog path.
- **Old / new Runner:** the baseline was API-only and never part of the claim
  response, so there is no Runner or CLI version floor.

The migration may run before API promotion. Outgoing API writers can still add
baselines after it runs; those rows drain through claim, terminal deletion or
queue expiry (two hours). Therefore absence from every queue row is only true
once outgoing writers and their queued jobs have drained. Rolling back the API
restores baseline writes but can still claim new baseline-free jobs. No release
or production activation is performed by this change.

## Connector catalog business readers on pointer and immutable entries

> Superseded by the [Release 2 contraction](#connector-catalog-release-2-contraction-migration-1334):
> legacy tables, pointer metadata and entry projection columns described
> below no longer exist.

Release 1 moves catalog consumers off legacy storage. It is not the
destructive Release 2. Business/runtime reads (Run capture, Pi
recapture, public lists/search/discovery/connect surfaces, account refresh,
Runner firewall catalog, DCR current-identity checks, and permission-baseline
refresh) use `connector_catalog(schema_version, hash)` and
`connector_catalog_entries(hash, slug, payload)`. They do not read the slug
manifest, compressed active snapshot, or persisted compatibility result.
Full reads capture the hash first and load retained immutable entries at that
hash, in slug order; switching the pointer cannot strand that capture. Selected
reads capture pointer and entries in one statement. Compatibility is calculated
from the captured entries and current code/configuration capability, with the
existing hash/capability-keyed process cache retained for full-catalog reads.
Without a manifest, a missing entry and a slug the generation never had are
indistinguishable. A delisted connector cannot be disconnected or
unauthorized by the user, so no per-slug or selected-entry reader fails on
it; each treats the slug as if it were never authorized. The current contract
is:

- Run capture at launch and the Run MCP connector list omit an agent-enabled
  connector or admitted account whose entry is missing at the captured hash.
  The Run launches without it and the MCP list leaves it out. The agent keeps
  its enabled-connector setting, and the connector returns once a later
  generation contains it again.
- Runner runtime sync reports that registered builtin target as `absent`
  (`connector-unavailable`). The Runner removes its firewall policy, and a
  later `available` result after the connector returns restores it.
  `unresolved` remains for credential and refresh problems on a connector that
  is still in the catalog.
- Optional reads (search, discovery, connect items, connected briefs,
  single-item status/permission and account GETs, stored-connection lists,
  account lifecycle refresh, display filters, and metadata-only custom
  permission-bundle dependencies) omit the slug or return not-found.

This contract does not probe all slugs or restore a manifest, and a
missing slug in one reader is never a global catalog failure. Runners
already handle builtin `absent`, so no Runner protocol change is required.
A missing pointer or an empty
whole-catalog generation fails unavailable; there is no legacy or R2 read
fallback. The pointer read selects only `schema_version` and `hash`; no
business reader reads `connector_catalog.catalog_header`, which writers still
populate until Release 2. Public list, discovery and status responses no longer
return `categoryMetadata`; connectors carry only their `category` id, and
discovery keeps `categoryConnectorCounts`. The App ships in the same change:
it derives categories only from connector `category` ids (existing localized
copy for known ids, id-derived names otherwise, ordered by name, ungrouped) and
no longer reads `categoryMetadata`. App and API deploy independently, in either
order. A new App with an old API ignores the field it still returns. An App
bundle loaded before this change, talking to a new API, receives no category
metadata: it shows id-derived names, loses category grouping and the
Connectors-page category filter, and the chat directory uses id-derived
names, until the page reloads. Browsing, search, connect and runs are unaffected. That
degradation is accepted; the API does not keep a `catalog_header` read for old
bundles. The
Runner firewall projection's own digest uses canonical JSON object-key order,
so loading the same content from JSONB cannot change its identity. The opaque
digest/version can change once relative to the old noncanonical projection;
Runner caches already invalidate by that identity and do not recompute it from
response serialization. No Runner protocol or firewall body shape changes.

There is no schema migration or stored-data rewrite. The writer still validates
and completely prepares entries before publishing the pointer, and atomically
maintains the legacy snapshot, compatibility rows and pointer metadata. The
legacy synchronization CAS/rejection state and compatibility reconciler are
unchanged. Staff diagnostics move off the legacy stores in the same change
(below).

New API/existing DB requires the pointer and entries to have been materialized
by the existing synchronizer; a legacy gzip row alone is not readiness. Old
API/new DB remains supported because no table or field is removed and all
compatibility writes remain. No production activation, backfill, release or
migration is executed by this change.

The persisted permission baseline and stored Pi execution-context schemas are
unchanged. New baseline identity retains the v1 wire fields: `catalogDigest`
contains the hash and `catalogVersion` is a legacy required alias containing
that same hash, not a publication label or comparison key. Old baseline rows
with their original publication version remain readable without rewriting:
currentness compares hash, schema, source and capability (and preserves the
existing validation-authority fast-path fence), not `catalogVersion`. A changed
capability/validator still takes the existing canonical full refresh, now also
from immutable entries. An old API claiming a newly captured baseline can take
its existing version-mismatch full refresh; legacy serving state remains intact.
Pi source-vector fields and Runner payload shapes remain unchanged. Native
route coverage claims old v1 baseline contexts for both Claude Code and Pi,
including their original publication version, after removing legacy serving
rows from the case-owned database. Production performance and deployed
old/new-instance acceptance remain separate verification boundaries.

### Connector catalog staff diagnostics on pointer and immutable entries

Staff diagnostics (the OkouDebug-only `diagnostics` route under
`/api/connector-catalog`, since removed; see
[its removal](#connector-catalog-diagnostics-removed-2026-10-07))
no longer read `connector_catalog_sync_state`,
`connector_catalog_active_snapshot`,
`connector_catalog_compatibility_evaluation` or the runtime projection tables.
Each request reads `connector_catalog(schema_version, hash)` and the
`connector_catalog_entries` at that hash (only the slug, auth methods and MCP
presence that compatibility evaluates), then calls
`evaluateConnectorCatalogCompatibility` against the current executable
capability. Diagnostics do not read `catalog_version`, `activated_at`,
`catalog_header` or `entry_slugs`, so they survive the removal of those
columns, and there is no manifest comparison. Nothing new is persisted or
cached.

Response fields:

- `pointer` (new): `{ schemaVersion, hash, entryCount }`, or `null`
  without a pointer. `entryCount: 0` is an unavailable generation: the API
  logs a warning and reports `filtering` with `stale: true` and
  `evaluatedAt: null`.
- `active`: `{ catalogDigest }`, carrying the hash; `activatedAt` is omitted.
  (The `catalogVersion` hash alias it originally also carried was removed by
  the [Release 2 follow-up](#connector-catalog-release-2-follow-up).)
- `state`: `never-synced` without a pointer, `current` otherwise. `stale`
  stays in the enum for older API responses but is no longer emitted.
- `filtering`: evaluated per request. `evaluatedAt` is the request time.
- `lastAttempt`, `lastSuccessAt` and `rejectedCandidate` are removed. Only the
  writer's sync state records them, so the API omits them instead of
  reporting nulls that would look like "never attempted".

Rolling deploy: the old Platform debug panel already null-guards every
removed field (`lastAttempt ?`, `active?.activatedAt ?? null`,
`formatTimestamp(lastSuccessAt)` on a falsy value, `rejectedCandidate ?`), so
it renders them as "None" against a new API. The panel is behind the
staff-only OkouDebug switch, so the new panel adds no handling for older API
responses: the contract requires `pointer`, and a new panel served by an old
API shows its fields as "None" until that API is replaced. No CLI command reads
this endpoint.

The cron sync response (`/api/cron/sync-connector-catalog`) carries the same
`pointer`, `filtering` and `credentialStorage`, plus the writer's report of
the attempt it just made: `outcome`, `state` (`stale` after a rejected
candidate while an older catalog keeps serving), `active` (publication label
and activation time), `lastAttempt`, `lastSuccessAt` and `rejectedCandidate`.
`syncConnectorCatalog$` returns that report from its own sync state, and it
goes away with that state in Release 2. The release workflow's best-effort
readiness check (`state`, `active`, `filtering.stale`) keeps the same meaning.
With an empty generation, it now warns. (The response's diagnostics fields
and this readiness check were later removed; see
[diagnostics removal](#connector-catalog-diagnostics-removed-2026-10-07).)

The remaining legacy reads in API source are all internal to the writer. They
stay until the Release 2 contraction because old API instances still depend
on the writes they guard:

- `connector-catalog-sync.service.ts` `readSyncState` (sync state joined with
  the active snapshot) provides the sync attempt's CAS baseline, observed
  pointer and rejection cache, and the attempt report described above.
- `connector-catalog-compatibility.service.ts` `reconcileCompatibility` takes
  locking reads (`lockSyncState`, `activeSnapshotForUpdate` and the existing
  evaluation's validation authority) before it rewrites compatibility rows.
- `preview-connector-catalog.service.ts` only writes and deletes the preview
  source's legacy rows, in the same transaction as the pointer; it reads none.

There are no schema, data or writer behavior changes.

## Organization OpenRouter preset override

Migration `1324_org_openrouter_preset` adds nullable
`org_metadata.openrouter_preset`. Apply the migration before deploying the new
API. Old API/new database ignores the additive field and keeps its global
catalog route; new API/old database is unsupported because org context reads
the column. No Runner or Pi payload shape changes are required.

For the Built-in `okou-1.0` OpenRouter route, new execution contexts use
`org_metadata.openrouter_preset ?? model_routes.upstream_model`. The org-owned
catalog projection never mutates the shared global catalog. Subscription
routes are unchanged. Pi memory maintenance uses the
same org-specific projection. Already launched Runs keep their captured route;
operator changes apply to subsequent launches.

The field is operator-managed in this change, with no product write endpoint
or UI. Store a full `@preset/<slug>` reference accessible to the managed
OpenRouter account. `NULL` clears the override. Empty or invalid values are not
normalized to the default, and database/provider failures do not silently
switch models. Presets must remain compatible with the `okou-1.0` runtime
capability and token-limit contract; this change does not introduce dynamic
backing-model metadata or different billing prices.

## Run model schema contraction

Migrations 1325–1327 and 1330/1331 leave the model schema with fixed platform
Auto (`okou-1.0` on `openrouter-codex`) and members' personal Codex/Claude
subscriptions; the DeepSeek memory binding is unchanged. 1330 drops
`agents.model_provider_id`, `agents.selected_model`,
`agents.prefer_personal_provider`, `model_providers.secret_id` and
`org_plan_entitlements.support_byok` and narrows the `model_routes` provider
checks; 1331 deletes organization-owned (`__org__`) `model_providers` rows.
There is no data conversion or backfill.

This contraction has no rolling API or old-client compatibility: the API,
App/worker, CLI and iOS use `/api/run-models` together. An API built before
1330 reads the dropped columns, so it must not serve after 1330 is applied;
applying 1330/1331 therefore requires an owner-accepted interruption, which
this document does not record. Stored selections that are neither Auto nor an
available personal subscription model are rejected; they never become Auto.

Rollback floor: the rollback resolver resolves the first-parent `main` commit
that added `1330_drop_retired_model_configuration_columns.sql` and rejects
earlier targets before artifact or host access. That commit descends from, and
so supersedes, the earlier run model schema contraction
(`014fe1867c6d1830fd35b03c3d77491da5aaa36a`). This does not claim production
activation.

Migration 1333 then drops the constant `model_providers.auth_method`,
`model_providers.is_default`, `model_providers.selected_model`,
`model_routes.price_tier` and `run_model_catalog.is_system_default` columns.
Every API built before it still selects them in personal subscription and
model catalog reads, so the same no-rolling-compatibility rule applies: a
pre-1333 API still draining after 1333 is applied fails those reads (accepted
below), and the rollback resolver rejects
targets before the first-parent `main` commit that adds
`1333_drop_dead_model_provider_columns.sql`. On the wire, `/api/model-catalog`
no longer sends `isSystemDefault` or `priceTier`, personal provider responses
no longer send `secretName`, `authMethod`, `secretNames`, `isDefault` or
`selectedModel`, the provider upsert request no longer accepts
`selectedModel`, and `/api/run-models` no longer sends `routeStatusReason` or
the never-produced `unavailable` availability. App, CLI and iOS read none of
the removed fields. `routeStatus` stays on the wire because shipped iOS builds
decode it as a required string; current iOS decodes it as optional.

**Accepted rollout interruption (1333):** Ethan explicitly accepted
(2026-10-07) a brief unavailability during deployment while the outgoing API
drains, so model catalog, run execution and run-model reads from a pre-1333 API
may receive `42703` in that window. This bounded interruption is accepted for
this contraction; no preparatory release or old-column compatibility branch is
required. Prefer the same rollout as 1330/1332 or low traffic. Acceptance of
that risk is not an instruction to deploy.

Operator-only `org_metadata.openrouter_preset` overrides remain, with NULL
using `@preset/okou-1-0`. Actual pricing/credits, historical usage, image
generation and connectors retain their existing storage. See
[current model APIs](model-catalog.md).

## Complete official connector catalog initialization in CI preview

> Superseded by the [Release 2 contraction](#connector-catalog-release-2-contraction-migration-1334):
> legacy tables, pointer metadata and entry projection columns described
> below no longer exist.

`deploy-api` still runs `db:dev-seed --preview-onboarding-catalog` and then
calls `/api/cron/seed-preview-onboarding-catalog`; the flag and path keep their
historical names so the workflow is unchanged. Both now initialize the complete
validated official R2 publication. This replaces the former onboarding/Runner
E2E projection (32 connectors), which left every other official connector
absent once business readers moved to immutable entries. There is no subset,
slug allowlist or legacy gzip/R2 read fallback, and readers are unchanged.

Initialization reuses the production synchronizer's entry preparation. It
lists entries already present at the publication hash, registers bundled skill
storages/versions (and their Pi resource index rows) for the missing entries,
then writes those entries. Only after every entry exists does one transaction
upsert the schema-versioned pointer with the full slug manifest, together with
the legacy compressed snapshot, synchronization state and compatibility row
that older API instances still read. The previous generation keeps serving if
download, byte-digest validation, skill registration or an entry write fails.
Each deploy resets the preview Neon branch from its parent, so dev-seed performs
a cold initialization. The post-deploy call finds the generation complete and
only repeats download, validation and the pointer transaction. Pi invalidation
and runtime wakeups remain production-synchronizer behavior.

Entry preparation, for both production synchronization and preview, writes
missing entries in multi-row `INSERT ... ON CONFLICT DO NOTHING` statements of
at most 100 entries in publication order, instead of one statement per entry.
Entry existence remains the preparation receipt; an interrupted preparer can
leave whole batches, which a retry reuses. Production publication
`2026-10-04.4587` has 4,597 entries and 4,554 bundled skills, 30.6 MB raw
(5.5 MB compressed), and about 55 MiB of entry rows including derived columns.
That is 46 entry statements, the largest about 1.8 MiB. Before the projection,
the per-entry full synchronizer took 3.5 to 8.4 minutes (median about 6) within
`deploy-api`'s 25-minute job, from a GitHub runner to the Neon test project.
With batched writes, that publication initializes cold in about 8 seconds
against local PostgreSQL, including a simulated 20 ms round trip; the repeated
post-deploy call takes about 3 seconds. A CI preview deploy against Neon
installed all 4,597 entries in about 11 seconds (dev-seed about 15 seconds,
post-deploy call about 7 seconds).

The workflow is unchanged, and the endpoint's response shape is unchanged; its
slug list is now the complete manifest. Rolling back to the projection API
reinstalls the projection on the next deploy, because the branch is reset first. Never promote this test database into production. No
schema migration, production configuration, App/Runner protocol or release
action is part of this change.

## Personal subscription CLI and Reset Cards

Subscription controls add a single-account usage GET at
`/api/me/subscriptions/:id`, additive optional `subscriptionResetSupported`
metadata, and `subscription:read` / `subscription:switch` run capabilities.
Existing human list, activation, and Codex reset behavior remain unchanged.
No database migration, stored Run update, Runner protocol change, or account
selection change is required. Reset stays user-confirmed; no agent reset
capability is issued.

New API with old App/CLI preserves the existing routes and response fields;
older readers ignore the new optional metadata. Older token readers already
filter unknown capability names rather than rejecting newer tokens. New CLI
with old API cannot use the new single-account endpoint or subscription agent
capabilities: it reports the API denial or missing endpoint rather than
falling back to a different account. New App with old API renders the Reset
Card unavailable and cannot submit a reset through it. Old App with new API
continues to use the existing Codex controls.

Existing URLs remain exact-account descriptors with one stable idempotency
key, not bearer authorizations. The standalone page and card require an owned
account in the signed-in current organization. Roll out the new API and App
before relying on links in external integrations. Rollback restores the old
interface without modifying active accounts or running Runs; retained new
links may be unavailable until the supporting versions return. This PR does
not enable production overrides, deploy, or update the Web floor.

## File lifetime independent of Run provenance

Migration 1323 drops only `run_uploaded_files.run_id -> agent_runs.id`.
The nullable UUID, its indexes and upsert identity are unchanged. File ownership,
thread `SET NULL`, media/delivery/queue child foreign keys, object URLs and public
response shapes remain unchanged. A short file-table lock serializes the
association precondition with the drop under the normal 1s lock and 10s statement
timeouts. Unreconciled thread/org associations from run-backed chat files reject
the migration atomically; this migration does not perform another backfill.

Run, thread and Agent deletion no longer imply file or artifact deletion.
The new API removes Run-scoped catalog cleanup from all Run/Agent deleters.
Account erasure remains distinct: verified Clerk user/org deletion explicitly
removes files and catalog entries through their own user/org, direct thread,
projection and pending-queue ownership. It works even after the Run and Agent
are gone, and it preserves other owners' files. Files own their media, delivery
and pending-catalog cleanup; Run IDs are not erasure selectors.

Apply 1322, drain writers older than its association-capturing API, reconcile
associations, then apply 1323 before the new API. New API/old database still has
Run cascading file deletion, so it does not provide the new retention contract.
Old API/new database preserves file rows but can still remove their catalog
projections when it deletes a Run/Agent; a retained pending queue can restore
those projections. Its account erasure also cannot remove independently retained
files after their Run is gone. Do not process account erasure during that
DB/API cutover gap, and drain old API requests/jobs before accepting the new
retention and erasure contract. Rollback to the old API does not restore either
contract; re-adding the Run FK is not a safe automatic rollback because retained
provenance may no longer resolve. Keep the new lifecycle API as the rollback
floor once these semantics are in use.

The owning-event reader path remains for cross-thread ownership and nullable
associations. No Run purge, Run-ID column removal, object-storage deletion,
release, production migration or deployment is initiated by this source PR.

## Chat-derived readers without historical Run joins

Migration 1322 backfills existing run-backed files' nullable thread and org
associations in UUID-keyset batches, preserving existing associations, owners,
URLs and run IDs. Apply it before the new API. The migration is atomic and
retains the normal lock timeout, with a bounded 120-second statement timeout
for the complete batched backfill. A timeout rolls back the entire backfill;
production execution and acceptance are separate from this source PR.

New upload writers capture the thread and org in the existing file/queue
transaction. The common writer covers hosted, web, Slack, Telegram, GitHub,
Feishu, Teams and AgentPhone outputs; canonical published assets already save
these associations. Run IDs, foreign keys, upsert identities, public response
shapes and Runner/App/CLI protocols remain unchanged.

New readers use direct file associations or owning chat events, never a live
Run fallback. The event path preserves cross-thread associations and files
written by a draining old API; control.interrupt targets are not ownership.
A direct backfilled association remains readable after its events leave the
hot window. Catalog authorship still resolves the owning thread's user, and
Drive export retains thread/file owner authorization and run-scoped identity.
Artifact-change invalidation likewise resolves the live thread owner from file
associations first, retaining the owning-event fallback and the existing topic.
This includes uploads and preview completion after execution ends; a deleted
thread is not notified and its files remain independently owned.

Titles, notifications, follow-ups and Home evidence derive unfinished runs
from active rows without a terminal chat event; terminal active rows retained
while the Runner stops are not classified as unfinished. Home uses that same
predicate for fresh evidence and cached existing-thread destinations, retaining
the separate pending-input exclusion. Completed Home examples require
run.completed events inside the already authorized thread
set, not a historical Run status. Final terminal publication is the boundary:
a Run status change before its event is committed does not expose a completed
example prematurely.

Old API/new database continues using its historical Run reads and may omit
file associations; the new reader's event path supports those writes. New
API/old database retains the same schema, but historical files whose owning
events were archived need the backfill before switching readers. Rollback
restores the old reader behavior without discarding captured file associations.
Drain old writers and reconcile remaining associations before a later contract
PR removes the Run foreign key or the event compatibility path. No Run record,
column, foreign key or artifact is deleted here; no deployment, release or
production backfill is executed by this PR.

## Claude Code manual usage reset retirement

Retire `claudeCodeUsageReset` and the Claude Code-only grant query and redeem
request introduced in #36165. Ordinary Claude Code profile and usage-window
reads, OAuth connection, and the existing Codex reset contracts remain intact.
No stored credentials, database schema, usage history, or provider grants change.

New App with old API explicitly limits reset controls to Codex, even if an old
API response or cached Claude Code account still carries reset credits. Old App
with new API stops receiving Claude Code reset credits; a stale reset control
receives the existing not-found response from the type-based, account-based,
or failed-run reset endpoint. Those endpoints continue to support Codex with
their existing account ownership and identity checks. No wire shape changes or
Web floor update are needed. An old API can still redeem Claude Code resets
until it drains; source cleanup alone does not disable a serving old revision.
Rollback restores that revision's feature-switch-controlled behavior. This PR
does not change production overrides, merge, deploy, or revoke provider grants.

## MCP input observation query reduction (#37912)

Input observation reads only native Run ID/status with unchanged run/user/org
ownership predicates and the native status schema. The public full-Run MCP tool
and Web/CLI responses are unchanged. Observation and recall may read only the
origin, immediate predecessor and successor chain when one authorized, bounded
recursive statement snapshot proves there is no archive. The #38277 follow-up
removes the targeted reader's explicit repeatable-read transaction and per-edge
round trips. Metadata preflight gates payload transfer; invalid and over-budget
chains fail explicitly rather than returning partial state. The existing pool's
exclusively leased client retains the three-second server SQL timeout/read-only
mode, restores its exact prior settings on success and is discarded on any
unsuccessful path. No new pool or global connection setting is introduced.
Native retention requires archive coverage; live identity/revoke constraints
establish completeness in that case. Missing origins and all archive-backed
conversations retain complete canonical archive-plus-tail authority and its
integrity/resource errors.

An origin newer than an archive watermark is not sufficient: Web caller-owned
IDs can be reused after archived live rows are deleted, so ordering does not
prove archive-wide identity uniqueness. Those conversations remain O(history),
including recent hot inputs, and pay an additional bounded eligibility query.
No persistent projection, schema/migration, archive version, writer/retention,
public wire contract or Run lifecycle changes. Old/new APIs can read the same
facts throughout rollout; rollback changes cost only. No production activation,
latency acceptance, merge or deployment is claimed.

## MCP original-input event identity (#37750)

This is an explicitly authorized breaking MCP tool-schema cutover, not a Web,
CLI, Runner or persisted-data change. MCP sends return
`{threadId,eventId,createdAt}` for the original accepted input, instead of the
ordinary Web null-Run acknowledgement. MCP-generated UUIDs are passed through
the existing internal Web `clientEventId`; callers cannot provide replay keys.
`get_chat_input({threadId,eventId})` reads canonical input metadata and a separate
native consuming-Run observation. `get_run_status({runId})` replaces the previous
Run-only tool name without an alias. MCP recall uses `eventId`, not a physical
replacement selector, and acknowledges only canonical recalled input state.

MCP user history/search references now preserve the original input ID across
replacement; assistant outputs keep their own ID. Physical `seqId` remains the
current revision/order coordinate, so cached references containing both an
origin ID and a stale sequence must be refreshed. Cached tool schemas must be
rediscovered after cutover. All serving APIs must use the same MCP definition
before clients rely on it; an old API cannot provide this correlation contract.
Rollback restores the old MCP tools and requires rediscovery, but does not
rewrite inputs, Runs or snapshots. No compatibility alias or dual task lifecycle
is retained by request.

The bounded archive-plus-tail reader handles retained source identity without
new tables, backfills or archive versions. Unknown/unauthorized inputs,
unreadable history and unobservable consuming Runs are explicit failures,
not fabricated queued work. Read limits and storage cost remain documented in
`docs/mcp-server.md`; recall can use two separately bounded canonical reads.
Existing OAuth/member/thread/organization authority and Web's atomic revoke
edge remain required. Ordinary Web/CLI send responses, Runner protocols,
canonical writers and native Run responses are unchanged. The empty Run field
continues to exist on ordinary Web responses for their existing clients.

This fixes missing correlation in the existing MCP surface; it adds no separate
feature-flagged execution path. It does not introduce reliable MCP Events,
exact-send replay, indexed unlimited lookup, automatic merge or production
activation. A lost send response remains ambiguous and must not be retried
automatically.

## Autonomous delegation budget expansion

Migration 1319 widens the Run and workflow automation autonomy checks from
`0..10` to `0..32` and changes the automation column default to 32. Apply it
before the new API writes budgets above 10. Historical Run and automation
budgets are preserved: this migration does not refill an exhausted chain or
rewrite an explicitly smaller budget. New human inputs and default automation
creation receive 32; delegated Runs and Run-finished watchers still inherit
exactly their source budget minus one, and a zero-budget source is rejected.

Old APIs remain compatible with the expanded database and continue assigning
10 to human inputs. They can consume persisted budgets above 10 using the same
integer decrement rule. An old Official Workflow validator can reject a new
Blueprint budget above 10 until that API drains. No App, CLI or Runner wire
shape changes. Rolling back the API retains the wider constraints and stored
budgets; it must not restore the old database checks while rows above 10 exist.
Existing automations retain their stored budget unless the normal authorized
reconfiguration or reconciliation path changes it. This source PR does not
resume rejected inputs, alter live automations, merge, deploy or release.

## Thread mute (staff organization rollout)

`ChatThreadMuting` is independent of archiving and defaults to disabled with the
same staff organization allowlist. Migration 1318 adds `chat_threads.muted`
(default false, non-null) and a nullable mute payload to `chat_thread_events`.
Apply the expansion before the new API; old writers omit both columns safely.
Do not enable mute while old APIs still serve indicators, terminal callbacks or
push delivery, since those versions do not enforce mute.

Mute changes use the existing `sort_touched` event with an optional `muted`
payload, not a new strict-enum kind. The event captures the thread's existing
`lastMessageAt`; old readers ignore the payload without promoting activity.
New readers change only mute, preserving activity and metadata timestamps.
Snapshot mute fields are optional on the wire and normalize to false for old
snapshots and cached projections. The metadata shortcut response requires
`muted`: every serving and rollback-eligible API emits it, so the App no
longer defaults a missing value. The compactor captures the canonical mute
state. The existing snapshot/event version remains
unchanged and old readers continue to parse the stream.

New App/old API has no mute operation (404); keep the rollout switch disabled
until the serving API understands it. Old App/new API continues to receive
filtered unread indicators and suppressed pushes, though it has no mute menu or
icon. Mute preserves read cursors and active indicators; bulk agent mark-read
excludes muted threads. Terminal success/failure still writes content and
activity, but its UPDATE tests the current mute value before unarchiving.
External channel result deliveries and realtime invalidations remain intact.

Rollback preserves the additive columns and stored mute state, but old APIs do
not honor that state. Rollback therefore requires disabling access and accepting
that enforcement is unavailable until a mute-aware API is restored. This PR does
not activate production overrides, deploy or update the Web floor.

## Firewall auth effective expiry (#37670)

Firewall auth keeps the existing `expiresAt` response shape. For refreshable
sources, the API subtracts its existing OAuth refresh buffer from the earliest
source expiry, then takes the minimum with other authorization deadlines such
as the billable credit lease. Stored provider expiry remains accurate; credit
leases are not reduced by the token buffer. A finite effective deadline needs
positive remaining lifetime (`expiresAt - now > 0`). Sources at that boundary
refresh normally; if the bounded refresh still produces no positive horizon,
auth fails closed while keeping any persisted credential rotation. No expiry
clamp, repeated refresh loop or past-deadline success exception is added.

Existing Runner versions already honor `expiresAt`, so new API/old Runner and
new API/new Runner use the corrected cutoff without a Runner upgrade. Any
Runner resolving auth from old API retains the old timing; an existing cached
entry keeps its old deadline until normal expiry or invalidation. API serving
and retained rollback revisions must be verified separately from source/CI
acceptance. Null still means non-expiring only for non-billable auth; unrelated
custom/automatic/non-refreshable paths keep their existing behavior. No new
protocol field, persisted state, Run snapshot or database migration is involved.

Rollback restores the prior cache timing without changing stored credentials
or authorization. This correction does not invalidate other Runs on arbitrary
forced rotation, serialize concurrent refreshes, replay provider requests, or
change the accepted rare rotating-token reconnect tradeoff. Parent #37668 stays
open for incident request-level attribution and serving-version verification;
synthetic coverage does not establish Notion old-token invalidation or resolve
its reported 401s.

## Runner-local INFO R2 keys

Only existing ordinary Runner INFO events gain `r2_key` or a
`r2_storage_sources` list containing keys and logical name/version/mount
correlation. Event names, levels, counts and conditions are unchanged. These
sources retain the original API identity when cache delivery rewrites URLs to
`file://`; the list does not assert every source downloaded in every batch.
Native R2 URL keys are decoded once and bounded to 1024 bytes, without signing
parameters, fragments or userinfo. Unknown CDN/Worker/custom endpoints and local
paths contribute no inferred key. Template keys use the SDK's key construction.

Runner Start's existing formatter tees INFO to stderr and the local rolling
Runner file, configured for daily rotation and seven-file retention per release
prefix. This does not impose a global seven-day retention limit on earlier-release
files or journal entries; other Runner commands use stderr. These events do not
match the existing Axiom ingest filter. No new key fields
are added to WARN/ERROR, Guest logs, addon network logs, sandbox-operation
telemetry, API logs/contracts, Platform responses or metric labels. Existing URL
and error-text policies are unchanged; this is not universal redaction.

Keys can contain sensitive tenant identifiers or paths. Local file and journal
access and retention remain relevant; omitting credentials does not make keys
public. Missing fields do not imply no R2 download, and existing log-free paths
remain log-free. No API/Guest/addon/Platform rollout, protocol change, migration or
Web floor is needed. A normal Runner rollout is needed to observe these fields;
production activation or deployment is not included in this PR. Runner rollback
removes the local attributes only, without changing download behavior.

## Client-owned voice transcription and independent polish

Microphone input now uses two independent requests. Every audio segment, including
its tail, calls `/api/voice-io/transcribe/segment` with the same transcript-only
model prompt. The client sends `final: false` on every audio request so it also
works against serving/rollback APIs that require the field. Model context is a
spelling/overlap suffix capped at 1,000 characters, not the accumulated recording.
The client waits for all segment checkpoints, then calls the additive
`/api/voice-io/polish/segments` with a nonempty, recording-ordered `segments` array. Its combined text is bounded
at 262,144 characters. Both model stages have an owner-bound 60-second deadline.
Daily request/duration usage remains attached to successful audio transcription;
finite lifetime recording usage is counted only after successful polish. Empty
recordings never request polish or consume recording usage.

The client keeps PCM and segment checkpoints in IndexedDB. A failed/cancelled
polish does not erase those checkpoints; Retry/reload submits only polish once
transcription is complete. VAD runs before each new audio upload and inspects only
the non-overlapping samples. Silent tails do not upload audio; earlier speech
still reaches the independent polish request.

The owner explicitly authorized discarding old voice recordings. Opening version
2 of `okou-voice-drafts` replaces its `drafts` and `chunks` stores atomically,
including old PCM and combined-finalization progress. Other App databases are
untouched. Version 2 checkpoints retain ordinary resume/retry behavior. No old
recording converter, tombstone contract, or cache fallback is provided.

HTTP compatibility is temporary and separate from the approved cache retirement:

- **Old Web/new API:** the original final/full-prefix segment contract and the
  original `/api/voice-io/polish` `text` body remain accepted. A final HTTP request
  adapts to separate transcript-only and text-only model calls, never the former
  combined prompt. A silent/text-only final still edits the saved prefix. Only a
  successful final consumes finite recording usage. The combined legacy request
  has an 80-second owner-bound deadline below the edge's 100-second timeout.
- **New Web/old API:** all audio requests use `final: false`. Only `404` from the
  additive polish route uses the old segment endpoint's existing text-only final
  request, including its quota writer. It sends no audio and preserves completed
  transcription checkpoints on failure. Other failures never trigger another
  generation path.
- **New Web/new API:** the client independently orchestrates transcription and
  ordered-text polish. Successful polish consumes finite recording usage.

Normal API-first/App-second promotion is safe for these HTTP producers. In a
later release, raise the App floor only after the first containing App is live;
then retire old final/full-prefix/text adapters after the old senders are excluded.
The new-App fallback and `final: false` sender remain until older API versions
are outside both serving and supported rollback targets. Every protected surface
must close before removing the shared bridge. Follow-up retirement PR:
`chore(voice): retire split-pipeline rollout bridge`, required after those gates;
this run does not create that later PR or change live floor/deployment settings.

The cache cutover remains destructive by explicit owner decision. Old tabs do
not gain a version-2 cache reader from HTTP compatibility and may need refresh
once that cache upgrades. Rolling the App back to its version-1 cache reader
requires clearing only the voice database, rather than treating a `VersionError`
as an empty recording. Retired cache contents cannot be recovered by rollback.

## File transcription and Seedream 5 retirement

- Remove `okou video transcribe` and `/api/voice-io/stt`; old CLIs receive
  `404` for that intentionally retired operation. Camera and frame extraction
  remain available. Microphone input still uses the Gemini segment endpoint,
  with unchanged authentication, quota policy, and response shape.
- Remove Seedream 5 Pro and Lite from the shared image catalog, aliases, CLI
  guidance, direct-provider execution, pricing seeds, and deployment secrets.
  Seedream 4 continues through fal.ai. Existing member preferences and run
  snapshots that name an unavailable model use the existing catalog
  normalization and default model (`gpt-image-2.5-flare`). No database migration
  or rewrite of usage history is required.
- Old App with new API: a cached picker can still show a retired model; saving
  it fails validation until reload. Reads normalize retired settings to unset.
  New App with old API: the smaller picker never submits a retired selection;
  an old API can continue serving an already-stored selection until it drains.
  No Web floor change is included.
- Direct image jobs accepted by the old API finish in that deployment's own
  finite request lifetime. Completed artifacts, invoices, pricing records, and
  historical usage remain readable; this does not delete provider-side data.
  Rollback to an older API restores its older catalog and requires its original
  deployment configuration. Production release and provider-secret deletion
  are separate operations, not performed by this source change.

## Legacy Free organization tier retirement

The owner confirmed that production no longer writes the legacy Free tier and
approved one PR for code retirement and database contraction. A read-only MaskDB
check found no legacy Free metadata, entitlement plan keys, or pending targets.
The two entitlement-only organizations were already migrated to Limited Free
without creating metadata. These observations do not establish a production
migration-journal receipt or a deployed constraint.

The retirement migration normalizes remaining legacy rows in other environments
and prohibits the old value in `org_metadata.tier`, its pending subscription
target, and `org_plan_entitlements.plan_key`. It preserves credits, grant expiry,
status, configuration and billing provenance. Missing or conflicting companion
entitlements and subscription-linked legacy rows fail the transaction for
operator review; entitlement-only legacy rows are supported. Paid organizations
with a legacy pending target keep their current plan and get a Limited Free target.

All current creation paths, contracts, capability tables, readers and test
fixtures use `limited-free-1`; no legacy-tier adapter remains. The Slack starter
writer is updated in the same PR without changing credit-grant idempotency.
Deployment must not select an API that can write the old tier after contraction;
rollback to such a writer is unsupported. This owner-approved single-PR rollout
does not authorize deployment or production writes.

Historical migrations and external-data migration scripts remain immutable
records. Credit category `free`, localized Free labels and ChatGPT/Codex Free
subscription checks are independent contracts and are unchanged.

## Retired video entitlement contraction

Video generation admission was removed in #37242. The remaining
`video_generation_allowed` column is only propagated through entitlement
snapshots, model bootstrap, pending-credit reads and Billing status; no current
product action consumes it. This cleanup removes that propagation, the Billing
response field and the shared Drizzle declaration. Generated migration
`1315_drop_retired_video_entitlement` drops only that column. Historical usage,
credit records, accepted artifacts and shipped migrations remain unchanged.

**Accepted rollout interruption:** Ethan explicitly accepted brief unavailability
during deployment and requested that #37580 be marked ready for review. Migrations
run before API promotion. The outgoing API still selects and writes this column,
including bare Drizzle INSERT/SELECT/RETURNING, so ordinary overlapping deployment
produces `42703` errors for Billing, model admission and entitlement/reward writes
until it drains. This bounded interruption is accepted for this contraction; no
preparatory release or old-column compatibility branch is required. Acceptance
of that risk is not an instruction to merge or deploy this PR, and it does not
waive the rollback floor below.

New API/new App and CLI use the reduced capability shape. New App/old API works:
the removed response property is surplus data. The outgoing production App and
CLI do not enable Billing response validation; their remaining product actions
never read this property, so its omission does not require a new Web build floor.
App tests do validate responses, as do callers explicitly opting into validation:
an external client pinned to the old required-field schema must update. Sandbox
CLI packages are run-captured; this change does not rewrite an existing Run's
package or payload. This is source-level compatibility evidence, not deployed
mixed-client verification.

The rollback resolver uses the canonical main commit introducing migration 1315
as the API floor. Pre-cleanup APIs are not compatible with the contracted schema.
Rollback promotes artifacts, not database columns: recovery below this floor
requires a reviewed forward restoration migration before the old API serves.
No production deployment, Web-floor update or provider action is part of this PR.

Historical SQL fixtures and the pro-suspend transition validator retain the
field because they replay pre-retirement migrations, not current capability
behavior. Old migration snapshots remain immutable; the new Drizzle snapshot
contains the contracted schema.

## MCP Web-parity protocol simplification

The owner explicitly approved removal of the MCP-specific chat protocol in
[#37513](https://github.com/okou-ai/okou/issues/37513). MCP is a thin adapter to
ordinary Web chat commands, not a separately versioned creation/replay product.
The dedicated `create_chat_thread` tool, required `requestId`, 24-hour exact
replay contract, input receipts/references, `nextAction` handoffs and server-side
status waiting are removed rather than retained behind a compatibility branch.
Clients must refresh tool discovery and use the current input schemas. An
uncertain send must not be automatically retried as a new intent.

Sending without a thread id creates an ordinary conversation; sending with one
continues it. Acceptance does not imply Run admission, delivery or completion:
read ordinary conversation events and Run facts for the resulting state. MCP
editing, revocation and stopping may expose only operations with equivalent Web
semantics. OAuth, scopes, tenant ownership and ordinary Web client-event identity
are not relaxed by this protocol deletion.

This is an intentional MCP client-contract change, not a historical message
migration or a Runner protocol change. Existing stored message/source decoding
remains readable; no old MCP protocol fallback or dual-write path is required.
Rolling back restores the prior advertised MCP tools and contracts, while normal
Web chat data remains in its existing format. This approval does not waive other
persisted-state, database or deployment-compatibility contracts.

MCP send input is `{agentId, prompt, threadId?, model?}`. Status reads take
`{runId}` and return the ordinary Web Run response. Old protocol arguments are
rejected, not replayed or silently translated. The common metadata command no
longer accepts the MCP-only mutation identity; Web metadata event IDs retain
their existing behavior. Mixed MCP-serving versions can advertise different tool
schemas during deployment; clients must use the serving version's schema rather
than assume old request replay is available.

## Owner-selected RSA-AES VNC (default off; #37500)

Migration `1313_rsa_aes_vnc` adds an independent nullable RSA wire-key pin and
expands exact credential/profile checks; existing rows, ciphertext, revisions and
generations are preserved. Apply this expansion before code that selects the new
column. Required RSA pins cannot occupy CA/serverName fields; other profiles must
retain a null RSA pin. ne requires saved SSH and literal loopback in storage as
well as API/native admission.

The owner's preactivation compatibility waiver applies to this disabled non-GA
surface: no old/new VNC version overlap gate, legacy credential reader or protocol
downgrade is added. This does not waive data preservation, exact pre-KMS capability,
current owner/run/chat/member/SSH authority, trust or bounded resource checks. Old
implementations cannot be assumed to support new RSA rows. Keep the expansion on
rollback and keep VncAccess disabled; source/CI/engine interop do not prove a real
product PNG or authorize production activation. Parent delivery and activation
remain separate from this child PR.

## Pi official model-limit corrections (2026-10-02)

The shared Pi resolver applies verified context/output corrections by exact
catalog provider and model; see the
[model-limit audit](../turbo/packages/pi-agent-runtime/src/model-limits-audit.md).
It preserves source admission, opaque deployments, dialect compatibility,
credentials, pricing and reasoning defaults. Public API capacity, subscription
runtime defaults and gateway primary-provider limits remain distinct.

The internal session-construction hash document now includes the correction
table as well as prompt/tool profiles. Its format is internal; the public launch
and installed manifest still carry the same opaque SHA-256 string. This changes
parity for a limits-only fix, so a new API cannot silently reuse an old installed
CLI with stale corrected limits. New API/old CLI and old API/new CLI use the
existing task-captured immutable package on a mismatch; matching versions can
reuse the installed bundle. Older captured contexts retain their digest/package.
No DDL, event or launch generation, historical rewrite, deployment activation,
or independent compaction/summary policy change is part of this correction.

## Long-context threshold in the Runner payload (2026-10-01)

The long-context pricing threshold is catalog data:
`model_routes.long_context_min_total_input_tokens` (NULL = single tier).
The API captures the assigned route's threshold in
`modelUsageLongContextMinTotalInputTokens` (`0` = single tier). The Runner
forwards the captured value to the addon, which uses it for usage classification.

The owner has waived rollback to pre-catalog versions. Deploy the catalog API
before deploying this cleanup, and drain pre-catalog API instances before the
schema contraction. Runner binaries and their addons deploy together; ongoing
runs retain their captured execution contexts. Model pricing configuration
remains in the database.

Usage displays now name model usage rows by `agent_runs.selected_model`, joined
by `run_id`. This is a read-time API projection: stored `usage_event`,
`usage_event_hourly_rollup` rows and existing `usage.recorded` chat events are
unchanged. An old App shows the new response values through its existing
catalog mapping. No database migration is involved.

## Agent instruction transaction-free preparation

Instruction PUT reserves the existing same-key Pi token and canonical Storage
generation in a short authorized transaction before archive/manifest IO. Its
final transaction rechecks current Agent permission/name, Storage identity and
that exact token before publishing. Failed or cancelled work settles only its
own token. A superseded preparation returns the additive `409 CONFLICT` response;
request and successful response shapes remain unchanged. Existing consumers
already treat non-200 updates as failures and must not blindly retry a conflict.

No schema or token format changes. Old transaction-held API writers share the
same source locks and keyed publication fencing with new prepared writers; the
old lock-held IO remains until those instances drain. Rollback restores the old
transaction boundary. Readers keep following the last committed HEAD throughout
preparation. Bootstrap already uses the shared preparation/DB-only publication
helpers; with both callers migrated, the unused transaction wrapper is retired.
This does not make R2 keys immutable or recover token/byte obligations from
process termination; see [Storage version publication](storage-version-publication.md).

## Storage version reuse and reference-first Clerk cleanup

Registered Storage versions are reused from their database metadata without an
R2 existence probe or normal re-upload. Server-side publishers await archive and
manifest PUT success before registering a version; client-direct first commits
retain pre-transaction upload verification. The initial empty artifact remains
an explicitly archive-less version. No Storage row shape changes.

Clerk deletion now commits Storage/export reference removal together with
handler-version-1 `storage-object-cleanup` jobs in the existing `background_jobs`
table before touching those R2 objects. Prefixes and output keys survive owner
and source-row deletion, partial provider failures, and worker lease expiry.
Older workers ignore this new kind and cannot erase the queued obligation; a
rollback delays cleanup until compatible workers return. Older deletion code
still uses R2-first ordering until it drains. Existing user-deletion jobs retain
their current handler/checkpoint contract and can resume through the new code.
See [Storage version publication](storage-version-publication.md) for the bounded
cleanup, legacy shared-prefix policy, and remaining immutable-key/late-PUT scope.

## Bootstrap private-generation publication and advisory retirement

Bootstrap seed IO now finishes before canonical parent publication. Each new
attempt prepares a disjoint Storage UUID/prefix without registering a row. A
short transaction arbitrates the canonical owner/name, takes its parent directly
`FOR UPDATE`, checks default freshly and publishes only the elected generation.
An incumbent HEAD is preserved; only a versionless empty container may be
retired. Agent/metadata/credits/index references commit atomically. Exact failed
or losing generations reuse handler-v1 storage-object-cleanup inventory; no
schema, version identity, Runner reader or public API contract changes.

The initial metadata insert now checks configured policies, like the existing
conflict-update branch: policies configured before a metadata row exists retain
Custom instead of being switched to Auto. On conflict, configured policies retain
the stored mode; an unconfigured new org still starts in Auto. The policy and
catalog schemas and paid-tier behavior do not change.

At the owner's direction, mixed old/new bootstrap API writers are outside this
change's acceptance scope. No runtime version dispatch or legacy bootstrap path
is retained, and the earlier preparation-stage writer-drain/rollback gate is not
an acceptance requirement for this PR. This is a scope decision, not a claim that
serving builds were inspected. Other deployment and retirement contracts are
unchanged.

Concurrent attempts using this implementation keep disjoint UUIDs/prefixes.
Canonical parent ownership and uniqueness select one default; losers enqueue
only their own prefixes. Existing canonical Storage/version/index rows retain
their shape and key layout, with no persisted-state conversion or migration.
Published instructions and legitimate versionless empty reservations remain
part of the data contract, independent of writer-version coexistence.

Compensation fences an uncertain publication by probing the same candidate's
primary key under a private probe name, then reads only that captured UUID/prefix.
It removes only a newly inserted, unpublished probe; any live captured parent is
retained. Recovery SQL has one-second lock and five-second statement timeouts,
independent of request cancellation, without lock retries. Cleanup failure does
not reinterpret a successful publication or replace the original failure.
Process crashes before inventory and provider late PUTs still need #37402's grace
sweep. No grace period or complete orphan-GC guarantee is introduced here. The
[publication protocol](storage-version-publication.md#bootstrap-seed-publication)
details canonical election, empty-parent recovery and bounded cleanup.

## Astra Ultrafast temporarily disabled (2026-09-30)

> Superseded: Ultrafast was retired on 2026-10-07 (see "Ultrafast service tier
> retired"); this section is a historical record and is not a re-enablement path.

Ultrafast is no longer advertised in model run options. Both model pickers hide
its entry. The API rejects new Ultrafast thread selections, member preferences,
and sends, including sends retaining an existing Ultrafast thread pin. Users
with such a pin must select Standard or Fast before sending again. New threads
ignore a previously saved Ultrafast member preference and use Standard.
Run creation and claim reject Ultrafast even on direct OpenAI API-key routes;
already queued Ultrafast work is not silently downgraded. This pause leaves
Standard, Fast, reasoning efforts, and GPT 6.1 Sol unchanged.

No schema, enum, historical event reader, Runner protocol, or billing-category
changes are made. Historical Ultrafast data and usage remain readable, and
already running sandboxes are not interrupted. Old clients can still show the
entry, but receive `400` from the new API when enabling or sending with it. An
old API instance may still accept Ultrafast until the API rollout completes;
the new App alone does not disable old API instances. Rolling back restores the
previous availability. Re-enabling requires verified account-specific tier
discovery, rather than assuming subscription eligibility from the model name.

With the global model catalog below, this pause is catalog data rather than a
code check: migration 1298 seeds the `gpt-6-astra` `openai-api-key` route with
`service_tiers = {priority}` only, so every Ultrafast check (pickers, member
preference, thread selection, send, run creation and claim) finds no route
offering it and returns `400`. Re-enabling is a `model_routes` data change.

> **Superseded.** Migration `1326_prune_retired_model_routes` deleted the
> `gpt-6-astra` `openai-api-key` route along with every other non-subscription,
> non-Auto route. The remaining `gpt-6-astra` `codex-oauth-token` route still
> lists only `priority`, so Ultrafast stays unavailable.

## Global model catalog and projected system default (2026-09-30)

> **Historical record, superseded.** This and other dated global-catalog
> sections describe their original rollouts. For current model selection they
> are superseded by [Run model schema contraction](#run-model-schema-contraction);
> they are not instructions to restore policy projection, organization BYOK,
> custom gateways or general platform-model routing.

The server model catalog (`run_model_catalog` plus `model_routes`, served by
`GET /api/model-catalog`) becomes the only authority for model names, order,
the system default, retirement and replacement, price tiers and route
capabilities; code model labels and `ORG_DEFAULT_RUN_MODEL` are no longer
product authority, and the system default is the DB row with
`is_system_default = true`. Code still owns runtime adapters, keyed by
provider (Built-in concrete provider vendor pool, BYOK/subscription provider
type), never by model ID: `SUPPORTED_RUN_MODELS`, `SupportedRunModel`,
`isSupportedRunModel` and `supportedRunModelSchema` are removed, so a model
added only as catalog and route rows on an existing protocol is configurable
and runnable by the new API, IM model pickers and CLI (Pi too, when its route's
upstream model is one the pinned Pi runtime resolves). No schema change; the
previous API still rejects such a row as unsupported, so operators add
catalog-only models after this API is fully deployed. The CLI no longer
pre-rejects model IDs outside its bundled list; an old CLI still does. Free-plan
model access is catalog data (`built_in_on_restricted_plans`, migration 1300,
true only for `okou-1.0`), read by model policy writes, run admission and the
Platform; the static `isLimitedFree1RestrictedRunModel` allowlist is gone and
is not reproduced. Free plans (`limited-free-1` and legacy `free`, whose
`restricted_built_in_models` migration 1300 backfills to true) run only
`okou-1.0` on Built-in, or a model on the member's own connected Claude Code or
Codex subscription route; organization BYOK and custom gateways are no longer
free-plan entitlements. During the rolling window the old API still enforces
its code allowlist against the backfilled legacy Free rows, which only narrows
access earlier; stored selections that become restricted fail explicitly
(`PRO_REQUIRED`) rather than being rewritten. Custom-gateway mapping
follows the model's routes instead of hard-coded model IDs. The organization default is not configurable: the
catalog system default (`okou-1.0`, Auto) is projected into every
organization's `GET /api/model-policies` as a non-deletable system policy and
is not stored per organization. Resolution is thread selection, then member
preference, then the system default. Stored selections of retired models
resolve along the replacement chain (`claude-fable-5` → `claude-fable-5-1`,
`claude-opus-4-8` → `claude-opus-5-5`, `claude-sonnet-4-6` →
`claude-sonnet-5-5`, `deepseek-v4-pro` and `gpt-5.5` → `gpt-6-luna`); a
replacement never transplants credentials, and a selection whose provider type
has no route on the replacement fails explicitly. Chains may have several hops,
constrained by `lineage_rank` (each hop strictly increases it). App credit
usage and history show a run's own model name from the catalog, including
retired models, never the replacement's name. Built-in runtime candidates
come from enabled `model_routes` rows, and the API takes BYOK and
subscription upstream IDs from the route's `upstream_model`; the Pi execution
config in `@okouai/core` consumes the catalog route data. The `OkouModels` feature
switch is removed. See [the design note](model-catalog.md).

Migrations:

- `1297_okou_1_0_fixed_org_default` intentionally changes no data; the system
  default is projected from the catalog.
- `1298_global_model_catalog` adds `display_name`, `sort_order`,
  `is_system_default`, `replaced_by`, `lineage_rank` and
  `replaced_by_lineage_rank` to `run_model_catalog` (rank-based acyclic
  replacement chains, no triggers) and adds `model_routes`. It seeds every
  recognized model, the system default, the approved replacements and routes
  (Built-in candidates, BYOK and personal subscription routes). Unrecognized
  rows are kept with their ID as label, sorted last, and no routes. `gpt-5.6-terra`,
  `okou-1.0-pro` and `okou-1.0-max` (seeded by migrations 1191 and 1194; code
  support removed by #37363 and #37368; MaskDB on 2026-09-30 shows zero
  references in `chat_threads`, `org_model_policies`, `org_members_metadata`,
  `agents` and `model_providers`) are kept with their former labels, no
  routes, and are retired into the
  owner-approved targets `gpt-6-luna`, `okou-1.0` and `okou-1.0`. The previous
  API does not offer them either: they have no adapter or route and are not
  addable.
- `1299_model_catalog_stored_selections` rewrites mutable stored selections of
  retired models to their final replacement: `org_model_policies.model` (only
  onto a replacement route of the same provider type; incompatible retired
  policies are dropped and merged duplicates keep one row), `org_members_metadata.selected_model`
  and `model_settings`, `agents.selected_model` and
  `model_providers.selected_model`, and chat thread selections
  (`chat_threads.selected_model` and `model_settings`, with one
  `model_selection_updated` event per re-pinned thread; a thread whose
  provider pin cannot serve the replacement keeps its retired model and the
  API resolves it on read). It is re-runnable and serializes with API policy
  writes through the per-organization advisory lock. It never touches history
  (`agent_runs`, `chat_events` including queued inputs, usage and billing,
  session conversations) or custom-gateway `model_mappings`; the API rechecks
  queued inputs at dispatch. `org_plan_entitlements.restricted_built_in_models`
  is a boolean flag (MaskDB: 968 true and 32 false in the first 1000 rows) that
  turns on the catalog's restricted-plan flags and stores no model IDs, so
  1299 has nothing to rewrite there.
- Production impact of 1299: as of MaskDB on 2026-09-30, no chat thread,
  organization policy, member preference, agent or model provider references
  any of `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`,
  `deepseek-v4-pro`, `gpt-5.5`, `gpt-5.6-terra`, `okou-1.0-pro` or
  `okou-1.0-max`. The migration rewrites zero production rows. Every rewrite
  statement scans its table once (no `selected_model`/`model` index exists);
  on synthetic data at production scale (162,621 chat threads, 32,810
  policies) the whole migration took 0.21 s with zero matches and 1.01 s with
  10% matches, and 1.29 s at 5x scale with 1% matches, far below a 10 s
  statement timeout, so batching is unnecessary. 1299 analyzes its rewrite
  map before the chat thread scan; without it the planner sorted every thread
  first (2.0 s at 5x). Evidence and the verified/unverified boundary:
  `turbo/packages/db/MIGRATIONS.md`, "Migration 1299 performance evidence".
- `1300_model_catalog_restricted_plans` adds the
  two restricted-plan flags to `run_model_catalog` with defaults and seeds
  them from the former code allowlist. Additive; the previous API ignores the
  columns.
- `1301_model_catalog_pi_route_class` (in progress in this PR) adds nullable
  `run_model_catalog.pi_route_class` with a check constraint and seeds it
  from the former `@okouai/core` Pi policy. Additive; the previous API
  ignores the column and keeps its static Pi policy.
- Queue pick: an input enqueued by the previous API is re-resolved by the new
  API against the catalog at the pick (provider-prefixed upstream IDs and
  replacements included); runs that already started are unaffected. The
  pick no longer seeds per-organization policies under the policy advisory
  lock; the projected system default replaces that write.

App, iOS and CLI require `GET /api/model-catalog` for the system default,
names and capabilities. Deploy the catalog API before these clients. The
owner accepted breaking older clients and waived pre-catalog rollback.
Schema contraction requires the catalog API to be fully deployed first.

## Integration model commands are thread-scoped (2026-09-29)

The integration `/model` command now reads the effective model of an existing
routed chat thread (using the organization default when the thread's stored
choice is unavailable) and updates only that thread through the existing
metadata path. It no longer writes the member's shared model preference; new
threads continue to initialize from the member preference and then the
organization default. A command without an existing route does not create a
thread or change a preference. Slack slash commands identify only the main DM
route; other Slack contexts need a main DM conversation first. Slack, Teams,
and Discord model pickers bind to the original chat thread and reject stale
submissions if that route changes. Telegram and AgentPhone no longer recognize
the session-reset command: unrecognized slash inputs use their ordinary message
paths, including agent admission when addressed and connected.

This is an API-only behavior change with no schema, event, queue payload, App,
CLI, or Runner contract change. Existing queued inputs retain their captured
model. During an API rollout an older instance can still accept a model command
and write the member preference as well as a routed thread; after promotion,
new instances read and update only the thread. Old Slack modals and Teams cards
lack the original chat-thread binding and must be reopened; old Discord model
controls lack the signed thread tag and expire rather than changing another
conversation. No retained compatibility reader or rollback floor is needed;
rolling back the API temporarily restores the previous command behavior.

The release-7 section below records the behavior at that historical release,
not the new command contract.

## Image model thread columns and `image_model_updated` dropped

Final step of "Image model becomes a member setting" (#37246, released
2026-09-28 23:53 UTC). The owner chose to remove the tombstone tests, dead
projections and the whole compatibility layer in one change.

- Migration `1287_drop_image_model_thread_columns` deletes the remaining
  `image_model_updated` thread events (five production rows per MaskDB on
  2026-09-29 01:13 UTC, the latest from 2026-09-28 05:25 UTC, before #37246
  was released) and recreates `chat_thread_event_kind` without that value in a
  single table rewrite of `chat_thread_events`. At that observation the tables
  held 147,134 events and 162,361 threads; only the five retired events are
  deleted. It then drops `selected_image_model` from both tables. MaskDB's
  index metadata shows no index on either column. The committed schema and
  migration history have no dependent constraint; MaskDB does not expose the
  constraint catalog or either column, so live constraints and non-null counts
  cannot be queried through it. The member setting
  `org_members_metadata.selected_image_model` and the run snapshot
  `agent_runs.selected_image_model` stay.
- `POST /api/chat-threads/:id/image-model` and its contract are removed. The
  create body no longer declares `imageModel`, and thread metadata, thread
  events and snapshot projections no longer carry `selectedImageModel`. The
  contract, core replay, API, Platform and CLI no longer know the
  `image_model_updated` kind.
- `POST /api/image-io/generate` no longer declares `model`. The request schema
  remains `.passthrough()`: unknown keys are retained, not stripped or rejected.
  A released CLI that still sends `model` is accepted and the value is never
  read: the route passes the resolved model (run snapshot, else
  member setting, else default) to `parseImageOptions`. Stored job requests
  still carry their normalized model and are re-parsed by the provider webhook,
  so `parseImageModel` and the alias table stay.
- Runs no longer receive `OKOU_DEFAULT_IMAGE_MODEL`, and
  `DEFAULT_IMAGE_MODEL_ENV` is removed.

Release decision: the owner accepted shipping this without first raising the
Web client floor.

- The floor is App 0.982.0, the last build before #37246. Its snapshot and
  event schemas already treat `selectedImageModel` as optional, it does not
  validate thread metadata responses, and a missing value reads as no thread
  pin, so removing the field itself does not break thread-list sync. Fresh
  projections without a pin display the member setting. Cached pins and old
  server snapshot archives can still display stale selections until the new
  App is loaded or the cached snapshot is replaced. Archives shed the field
  when compacted again. Changing the composer image picker registers
  an optimistic pin and then returns `404`; that optimistic state remains until
  reload. Runs have used the member setting since #37246. Its create
  requests still send `imageModel`, which the create body schema strips.
- Older CLIs inside a run detect the sandbox token and omit `model` unless
  explicitly given `--model`; the
  server chooses the model in either case.
  Without `OKOU_DEFAULT_IMAGE_MODEL` their size default falls back to
  `1024x1024`, or `auto` with `--image-url`. The formerly incompatible model
  has since been retired as documented above. Their snapshot and event schemas treat
  `selectedImageModel` as optional, so chat thread reads are unaffected.

Release prerequisite: release #37268 published CLI 9.373.0 but skipped
[production Runner rebuild](https://github.com/okou-ai/okou/actions/runs/36498080195/job/109188223120)
and
[promotion](https://github.com/okou-ai/okou/actions/runs/36498080195/job/109188968213).
The preceding verified production rootfs
[installed CLI 9.371.0](https://github.com/okou-ai/okou/actions/runs/36426838612/job/108946499812).
A rootfs-installed CLI does not expire with an individual run, so a two-hour
drain does not establish its retirement. The default-size failure that required
CLI 9.373.0 has since been superseded by the model retirement documented above.
This cleanup does not change CLI launch paths or the installed-CLI floor.

Old and new versions during deploy:

- Migrations run before API promotion. The previous API still declares the
  columns, so its inserts and bare `select()`/`returning()` on `chat_threads`
  and `chat_thread_events` receive `42703` until it drains, as with `1283`. Its
  raw thread-event insert names `selected_image_model` explicitly, so every
  thread event it writes (create, rename, pin, model selection, archive) fails
  in that window. Both are hot tables; release this change at low traffic.
- Previous API with the new App or CLI: the previous API still sends
  `selectedImageModel`, which the object schemas strip. The new App never calls
  the image-model route. Before the migration, any retained
  `image_model_updated` event is rejected by the new clients and the new API's
  event parser. The migration must precede their promotion; after migration,
  the previous API instead has the column errors above until it drains.
- New API with App 0.982.0: see the release decision above.
- Cached state: a cached snapshot or event that still has
  `selectedImageModel` parses and the key is stripped. A browser that cached an
  `image_model_updated` event fails its strict IndexedDB read. The existing
  degraded path then loads the server snapshot and replaces the local snapshot
  and event log, with no Sentry report. The CLI cache discards an unparseable
  file and rebuilds it from the snapshot in the same way. A deleted event cursor
  receives `410` and reloads the snapshot unless it still equals the valid
  snapshot watermark.
- iOS keeps its `imageModelUpdated` wire case, and its decoders do not
  require `selectedImageModel`; it never called the image-model route. The
  new event responses and freshly compacted projections omit both.

Rollback promotes artifacts without restoring schema, so
`resolve-production-rollback-target.sh` rejects API targets that predate the
canonical main commit that added `1287`. Recovering past that commit requires a
forward-fix migration that restores the columns and the enum value.

## Chat Event V8 (2026-09-28)

This is step 2 of the Chat Event V8 plan. `CURRENT_CHAT_EVENT_SCHEMA_VERSION`
becomes 8; the current V8 contract is documented in
[Chat Event schema versioning](./chat-event-schema-versioning.md#v8).

Migration `1286_chat_event_v8` is non-transactional and re-runnable. It first
replaces `chat_events_event_type_check`, `chat_events_context_type_check` and
`chat_events_input_context_type_check` with their V8 versions as `NOT VALID`
and drops the three Goal payload checks, so new writes are held to V8
immediately. It then commits bounded batches: it walks the `chat_events` and
`agent_runs` primary keys in 5,000-row ranges (neither table indexes the
rewritten columns), deletes the eight retired event types, rewrites `goal` and
`github` contexts and Goal userMessage parts, and moves the `goal` run and
uploaded-file sources to `automation-schedule`. Thread and agent drafts lose
their Goal parts and saved shares lose `runGroupIndex`. Finally it validates
the three checks. Every rewrite selects only rows that still hold a retired
value, so an interrupted or completed run can be repeated. The procedures take
row locks only, under a `1s` lock timeout; the constraint swaps take a brief
`ACCESS EXCLUSIVE` lock on `chat_events` and `chat_event_snapshots`. On
2026-09-28 the rewrite covered about 146,000 deleted rows, 63,000 Goal input
rows, 360,000 other Goal rows and 124,000 Goal runs. The input context check
now also covers `input.rejected`. Production rejections replace a queued input
and inherit its context, so no hot row lacked one; a context-less rejection in
the table or a V7 Snapshot becomes `web`.

`chat_event_snapshots.archive_schema_version` now accepts 7 and 8 and defaults
to 8. A thread's V8 pointer is published beside its V7 pointer by the adjacent
V7 to V8 Snapshot migration.

Migration `1294_retire_v7_chat_event_snapshots` deletes V7 pointer rows in
committed 5,000-primary-key ranges and tightens the constraint to
`archive_schema_version = 8`. Before deleting, it fails closed if any V7 pointer
lacks a V8 pointer for the same thread; the `NOT VALID` constraint blocks new
V7 rows while the existing rows are removed. It does not delete R2 objects.
PR-3 also removes the V7 upgrade service, previous-pointer cron joins, read-time
publication, V7 cursor coverage and dual-version history/MCP/provenance/export
selection, together with their obsolete fixtures, tests and lint exemptions.
The historical 1286 rewrite validator is retired; a focused 1294 validator
protects pointer deletion, unchanged V8 rows, batching, fail-closed checks and
retry. Run this migration only after no pre-V8 API can serve or be selected for
rollback; the existing `chat-event-v8` rollback floor enforces the rollback
boundary, and the outgoing V8 API writes only version 8.

Browser open/close now accept an empty request body and no longer echo
`lifecycleEventId`; browser create/use responses also omit that field. The Web
client floor is 0.982.0, above the 0.979.1 build at #37225 that stopped emitting
browser lifecycle events. Supported clients do not require the echo. The new
App must not reach an API predating this empty-body contract: even earlier V8
APIs require `eventId`. The `.github/rollback-floors/browser-session-mutations`
marker raises the API rollback floor to the canonical main commit that adds
this contract, matching the owner's forward-only release decision. The
resolver rejects unresolved history and incompatible targets before artifact
or host access. Released CLIs using create/use do not require
`lifecycleEventId`.

1286 release precheck: migration 1286 runs before API promotion, so the
serving API must no longer write any retired type, context or source. The
production API must already contain
`d687f84782c736f451682e7066caffb3696f6306` (#37225), which stopped the last
writers. Do not release this change while production or a
rollback target predates that commit.

Compatibility:

- Old App, CLI or iOS reading V8: V8 rows are a strict subset of V7, so V7
  readers accept them. The Web client floor is not raised.
- New App against a rolled-back API: the old API serves V7 rows and Snapshots
  that the V8 reader rejects. The marker
  `.github/rollback-floors/chat-event-v8` therefore sets the API rollback floor
  to the main commit that adds it. `resolve-production-rollback-target.sh`
  must reject targets that predate that commit, as it does for
  `chat-event-schema-header-retired`.
- Old API during the deploy window: it only writes V7 Snapshot pointers and
  rows that V8 accepts, and it reads its own V7 pointers.
- MCP chat history no longer returns the retired events; it has not returned
  them since #37225 projected them away.

## Image model becomes a member setting (2026-09-28)

Built-in image generation now uses one image model per workspace member:
`org_members_metadata.selected_image_model`, edited in Settings › Built-in
tools, else `DEFAULT_IMAGE_MODEL`, which changes from `gpt-image-1` to
`gpt-image-2.5-flare`. Members without a stored value move to the new default.
No onboarding or seed path writes the member value. Run creation snapshots the
resolved model onto `agent_runs.selected_image_model` as before, but no longer
reads `chat_threads.selected_image_model`. The `SettingsToolsTab` and
`PaidToolControls` feature switches are removed, so the Tools tab is shown to
every member. There is no migration.

With video generation retired (#37242), new threads pin no media model at
all. The composer never shows the image model: the staff `composerModelPanel`
switch still chooses between the #37229 panel and the legacy menu with its
effort chip, and both list only chat models. #37848 has since removed that
switch and the legacy menu; the composer uses the #37229 panel, which lists
only chat models. The undocumented `birefnet` and `clarity-upscaler` transform
models are removed.

The compatibility layer this release kept for older Web App builds, iOS and
released CLIs (the thread image-model route, the create body `imageModel`, the
thread `selectedImageModel` projection, the `image_model_updated` event kind,
the image generation body `model` and `OKOU_DEFAULT_IMAGE_MODEL`) is removed by
"Image model thread columns and `image_model_updated` dropped" above.

`PUT /api/user-model-preference` still requires the run preference. A request
that echoes the stored `selectedModel` and `serviceTier` without a
`modelSettingsPatch` skips org model policy admission, so a member whose stored
chat model has left the policy can still change their image model. Older APIs
reject that case with `400`; the new Settings dropdown then reports a save
error until the API is promoted. Org model policies were later removed; see
[Run model schema contraction](#run-model-schema-contraction).

## Video model columns and `video_model_updated` dropped (#37249)

Final contract step of the video retirement (#37242, #37256).

- Migration `1283_drop_retired_video_model_columns` drops
  `selected_video_model` from `chat_threads`, `org_members_metadata`,
  `agent_runs` and `chat_thread_events`, deletes the remaining
  `video_model_updated` thread events (one row in production per MaskDB on
  2026-09-28) and recreates `chat_thread_event_kind` without that value in a
  single table rewrite of `chat_thread_events`. It re-adds
  `agent_runs_metadata_presence_check` without the dropped column as
  `NOT VALID`; `1284_validate_agent_runs_metadata_presence_check` validates it
  in its own transaction, so the `agent_runs` scan does not hold the
  `ACCESS EXCLUSIVE` lock.
- The contract, core replay, API, Platform and CLI no longer know the
  `video_model_updated` kind or the `selectedVideoModel` field on thread
  metadata, thread events or snapshot projections. Historical usage and credit
  records are unaffected: `chat_events` usage payloads never carried the field,
  and the video model catalog stays for historical display.

Release decision: the owner accepted shipping this without first raising the
Web client floor and without waiting for #37256 to be released on its own.

- App 0.981.0 (the current floor) still requires `selectedVideoModel` when it
  parses IndexedDB thread events and snapshots and the R2 snapshot archive, so
  its thread-list sync fails once the field is gone. This is accepted: after
  the App from this release is promoted, a reload loads a build that does not
  need the field. Between API and App promotion, a reload still loads 0.981.0.
- Sandbox CLIs from before #37256 also require the field in the snapshot
  archive; their chat thread reads fail until they drain (about two hours).
- If #37256 ships in the same release, the previous API still reads the
  columns explicitly as well; it falls into the same `42703` window below.

Old and new versions during deploy:

- Migrations run before API promotion. The previous API still declares the
  columns, so its inserts and bare `select()`/`returning()` on those four
  tables receive `42703` until it drains, as with `1274`. `agent_runs`,
  `chat_threads` and `chat_thread_events` are hot tables; release this change
  at low traffic.
- Previous API with the new App or CLI: the previous API still sends
  `selectedVideoModel: null`, which the object schemas strip. It writes no
  `video_model_updated` event.
- New API with App 0.981.0: see the release decision above; the tab recovers
  on reload once the new App is promoted.
- Cached state: a cached snapshot that still has `selectedVideoModel` parses
  and the key is stripped. A browser that cached a `video_model_updated` event
  fails its strict IndexedDB read. The existing degraded path then loads the
  server snapshot and replaces the local snapshot and event log, with no
  Sentry report. The CLI cache discards an unparseable file and rebuilds it
  from the snapshot in the same way. A client whose saved cursor was a deleted
  event receives `410` and reloads the snapshot.
- iOS decoders do not require `selectedVideoModel`, and the server no longer
  sends it or a `video_model_updated` event. iOS decodes thread events only
  from the server and never persists them, so its `videoModelUpdated` wire
  case was removed.

Rollback promotes artifacts without restoring schema, so
`resolve-production-rollback-target.sh` rejects API targets that predate the
canonical main commit that added `1283`. Recovering past that commit requires a
forward-fix migration that restores the columns and the enum value.

## Unified chat queue final cleanup (after release 7)

This change contracts what release 7 (#37200, released in #37237) retired and
removes compatibility that no longer has a reader.

**Migration 1282: retired integration agent tables.** Migration
`1282_drop_retired_integration_agent_tables` drops
`slack_user_agent_preferences`, `discord_user_agent_preferences`,
`feishu_user_agent_preferences`, `feishu_platform_user_agent_preferences`,
`teams_user_agent_preferences`, `telegram_user_agent_preferences`,
`agentphone_user_agent_preferences`, `telegram_user_links` and
`telegram_installations`, and the column
`feishu_org_installations.default_agent_id`, together with their Drizzle
declarations. It first deletes the self-hosted Telegram rows from the two
shared tables, then drops `telegram_chat_thread_routes.telegram_user_link_id`
and `telegram_messages.installation_id` with their partial indexes and
one-owner checks, and makes the official owner
(`telegram_official_user_link_id`, `official_org_id`) `NOT NULL`. The chat
threads of the deleted self-hosted routes remain as history; self-hosted
Telegram messages are 30-day context rows. Dropping the foreign keys briefly
locks `agents` and `discord_org_connections`, and `SET NOT NULL` scans the two
small Telegram tables, all under the default 1 s `lock_timeout`.

Gate evidence: release 7 removed every read and write of the tables and the
Feishu/Lark column (the runtime Feishu mapping already omitted it), and no
fixture, cron, erasure or export list names them. Release 7 is live in
production (`91223f52`), the last output from an earlier API (`f06f2e0f`) was at
2026-09-28 13:25:49 UTC, and the API rollback floor is release 7. The one-time
KMS 013 recovery manifest treats `telegram_installations.encrypted_bot_token`
as optional, like `agent_run_queue`, so snapshots from either side of the drop
verify. The 1279 transition validator is retired because 1279 no longer
replays on the contracted shapes (see `turbo/packages/db/MIGRATIONS.md`).

Release 7 APIs still declare `telegram_messages.installation_id` and
`telegram_chat_thread_routes.telegram_user_link_id` and name them in Telegram
message and route inserts. The migration runs before API promotion, so until
the release 7 API drains its official Telegram message and route inserts
receive `42703`. This window is accepted, as for `1274`; release at low
traffic. The other dropped tables and the Feishu column are not named by any
release 7 statement.

**API rollback floor: this change**, resolved from the first main commit that
adds `1282_drop_retired_integration_agent_tables.sql` in
`resolve-production-rollback-target.sh`. Rollback promotes artifacts without
restoring schema, and every earlier API names the dropped Telegram columns.

**Integration `/model` also switches the current thread.** Integration `/model`
commands (Slack DM picker, Discord `/okou model`, the Teams model card,
Feishu/Lark, official Telegram and AgentPhone) now also switch the model of the
conversation's existing chat thread. They reuse the web thread model-selection
path, so the thread row and its `model_selection_updated` and
`service_tier_updated` events are written exactly as a web switch writes them.
A context without a routed chat thread changes only the member default, and the
next new thread initializes from it. This is code-only. During the rollout an
old API instance only updates the member default. Teams model cards now carry
the route key of the conversation where `/model` was sent; a card posted before
this change has none and is answered with a notice to send `/model` again,
without changing any model.

**Chat send response `status` removed.** The `POST /api/chat/events` 201
response contract no longer declares the optional `status` field. Only APIs
that created a run synchronously returned it, and every API at or above the
release 7 floor returns only `runId: null`, `threadId` and `createdAt`. Nothing
changes on the wire and no App, iOS or CLI build reads the field.

Kept compatibility, with the unmet condition:

- `runId: null` in the chat send response: user-installed CLIs, MCP and token
  clients have no version floor and may still read the key.
- `queued` run status and historical `run.queued`/`run.dequeued` rows: persisted
  data that must still parse; no migration removes it.
- Nullable `chat_events.model_selection` and pick rejecting inputs without it:
  historical inputs have no captured model.
- Legacy `direct-message:<agentId>:<model>` route keys handled by
  `/new_session`, and the pick-time rebinding of threads bound to a former
  per-user agent: persisted routes and thread bindings without a data migration.
- `piInstalledCliRequirement` optional in the execution context: tightening it
  is a separate Runner/Guest protocol change without a documented deadline.
- `GET /api/integrations/telegram/bots` for older CLIs: deployed CLIs have no
  version floor.

## Direct PUT checksum removal and Browser file uploads (#37241)

The shared presigner no longer puts `x-amz-checksum-sha256` into a required
request header or the signed URL. The host CLI keeps its original PUT with
`Content-Type`; no host prepare/complete workflow changes. The same removal
also applies to Discord canonical PUTs. This deliberately drops
R2 enforcement of the client-declared byte hash. A holder of a hosted or
Discord PUT URL can replace its object with different bytes while that URL is
valid (the host URL expires after 48 hours). The request's `Content-Type` is
also not signed, so a replay can change the object's media type. The
client-provided SHA-256 and host manifest are not trusted proof of the
originally intended bytes. Host
manifests still carry `immutableContent: true` for their existing serving and
cache policy; that marker must **not** be interpreted as an R2 overwrite
barrier. Treat replay-versus-cache consistency as an accepted limitation until
server-owned sealing or cache-policy changes are separately approved.

Browser native file input no longer computes or transports a file SHA-256 and
apply no longer compares a readback digest. Prepare still requires an exact
pending request and issues a ten-minute temporary PUT URL, using the same
shared ten-minute Browser idle-lease duration; the provider's absolute timeout
and request/target state can still end the operation earlier. Apply still
checks downloaded byte length and the 10 MiB aggregate / three-file limits,
then uses the existing exact target, pending/uncertain, and 15-second CDP
boundaries. Cancellation attempts object cleanup, but a holder of an unexpired
PUT URL can recreate a temporary object after cleanup; the 24-hour R2
lifecycle rule remains the eventual backstop. No production CORS or feature
switch is changed. The non-GA Browser wire shape changes directly, with no
legacy compatibility path. Roll out the API and Platform changes together
while the production file-input feature remains disabled.

## Chat Event V8 preparation: retired writers stop (2026-09-28)

This is step 1 of the Chat Event V8 plan. It changes no wire protocol: the row
schema, `CHAT_EVENT_TYPES`, the database checks and
`CURRENT_CHAT_EVENT_SCHEMA_VERSION` stay at V7.

- The API no longer writes `output.thinking` (Codex reasoning items) or
  `browser.open` / `browser.close` (viewer open, viewer close and instance
  suspension). The browser `open` and `close` endpoints still require the
  request `eventId` and return it unchanged as `lifecycleEventId`. `use` and
  `create` keep returning `lifecycleEventId: null`.
- Shared threads no longer write `runGroupIndex`. The field stays optional in
  the contract because saved shares may still carry it.
- The `chatEventFromRow` projection drops the eight types in
  `V7_ONLY_CHAT_EVENT_TYPES` (`input.goal`, `goal.open`, `goal.close`,
  `run.queued`, `run.dequeued`, `output.thinking`, `browser.open`,
  `browser.close`) and no longer derives `runGroupId`. `ChatEvent` is built
  inside each artifact from raw V7 rows and is never sent over the network.
  MCP chat history reads therefore no longer return thinking, goal or browser
  events.
- Platform removes run-group folding, goal cards, queue markers, the thinking
  marker and the browser sidebar auto-open. Historical goal parts render as
  plain text. The Platform read cursor follows raw rows, so a thread whose
  latest rows are dropped types still catches up.

Compatibility:

- New Platform, old API: the old API may still return the retired rows, which
  the new projection drops. It persists the browser lifecycle event under the
  `eventId` the new Platform still sends, and returns that ID.
- Old Platform, new API: the old Platform receives no new retired rows, so its
  thinking marker and auto-open do not trigger for new activity. Its optimistic
  `browser.open` / `browser.close` event is never confirmed by a server row; it
  stays hidden local state until the page reloads. The echoed
  `lifecycleEventId` matches what it sent.
- Old and new APIs read the same V7 rows and snapshots. Historical retired
  rows remain valid V7 data until V8.

V8 (PR-2) deletes these rows and tightens the database checks, so it assumes
production has no writer for them. After this change is released, raise the API
rollback floor to its main commit so that no rollback target writes the retired
types; that floor update is a separate follow-up and is not part of this change.

## Video retirement follow-up: accepted-job paths and video model reads removed

Follow-up to the retirement below, tracked in #37249.

- The API no longer completes video or avatar jobs accepted by a
  pre-retirement API. The retired video-provider webhook routes are
  removed (callbacks now receive `404`). A fal success callback for a video job
  is logged and acknowledged without completing the job; a fal failure
  callback still fails it. Status reads of
  finished jobs, existing video artifacts, and historical usage and credit
  records are unchanged. `JOGGAI_API_KEY`, `JOGGAI_WEBHOOK_SECRET`, and the
  API's `MINIMAX_API_KEY` are no longer read.
- The API no longer reads or writes the `selected_video_model` columns on
  threads, thread events, members, or runs. Thread metadata, thread events,
  and compacted snapshots still send `selectedVideoModel: null`, because Web
  clients at the current floor require the field. Historical
  `video_model_updated` events stay readable and replay as no-ops.
- The Web client floor is raised to `0.981.0`, the App build that retired
  video generation (live in production from release #37254). Older tabs
  receive `426` and reload, so no client still reaches the removed routes and
  controls.
- The production API rollback resolver now rejects targets that do not contain
  #37242 (`VIDEO_GENERATION_RETIREMENT_COMMIT`), so a rollback cannot restore
  an API that accepts video jobs. Before merge, a read-only MaskDB query
  confirmed no `video` job is within its 30-minute timeout in `queued` or
  `running`.

Old and new versions during deploy:

- Previous API with the new App: the new App treats `selectedVideoModel` as
  optional and ignores it, so the historical values the previous API still
  returns have no effect.
- New API with the floor-level App: it receives `selectedVideoModel: null`
  and no video model control reads it.
- Jobs: a video or avatar job still in flight would not complete; the gate
  above requires that none remain.

No database migration is included. Dropping the columns, the
`video_model_updated` kind, and the wire field is the next step under #37249,
after this API is the rollback floor and this App build is the Web client
floor.

## MCP user-message source reader preparation (#37233)

The API contract and App can parse and display a server-owned MCP source part
with a bounded OAuth client ID and optional client-name snapshot. Direct chat
sends reject caller-authored MCP parts. No production `/mcp` message writer
emits this part in the reader-preparation release; older API/App builds continue
to receive the previous text-only MCP input shape, and the new readers continue
to accept historical source kinds.

Strict older V7 Chat Event readers cannot parse an MCP source kind. The writer
slice (#37234) therefore requires independently verified promotion of prepared
API/App readers, an enforced Web client floor for older App builds, prepared or
excluded serving/rollback API readers and persisted-history consumers, and
completed old CLI context drain. This is a future gate, not satisfied merely by
merging this PR. See [Chat Event schema versioning](./chat-event-schema-versioning.md).

## Video, voice, and talking-avatar generation retired

Built-in video, voice (text-to-speech), and talking-avatar video generation are
removed. The API no longer serves `/api/video-io/generate`,
`/api/voice-io/speech`, `/api/avatar-video/generate`,
`/api/avatar-video/avatars`, or `/api/avatar-video/voices` (each including its
`/private` variant), and the CLI no longer has `okou generate video`,
`okou generate voice`, or `okou generate avatar-video`. Chat sends that select a
video or avatar template are rejected at admission. The App no longer offers
video or avatar templates, a video model picker, the retired paid-tool
toggles, or the `newUserVideoPickers` switch.

Old and new versions during deploy:

- Old Sandbox CLI with the new API: a run created before this release may still
  call a removed route and receive `404`. This is accepted; the CLI is not kept
  compatible with removed API routes, and commit-addressed CLI artifacts live
  about two hours.
- Old App with the new API: a still-open tab may still show retired controls.
  A video or avatar template send is rejected, and its thread video model write
  (`POST /api/chat-threads/:id/video-model`, now removed) fails. Its default
  video model and create-thread `videoModel` fields are stripped by the request
  schemas and ignored; paid-tool writes keep their contract. These failures
  are limited to retired controls and are accepted until the tab reloads. Do
  not raise the Web client floor in this release: production promotes the API
  before the App, so the floor is raised in a follow-up release after this App
  build is live (#37249).
- New App with the old API: the App simply stops calling the retired surfaces.
- Jobs accepted before the deploy: provider webhooks, status reads, artifacts,
  and billing for already accepted video and avatar jobs keep working
  (`webhooks-built-in-generations`, `built-in-generation`). The window is the
  old API's drain plus the 30-minute video job timeout, extended while a
  pre-retirement API remains a rollback target (a rollback re-enables
  submissions). Remove those paths under #37249.
- Inputs queued before the deploy with a video or avatar template run without
  that template once picked by the new API; they are not rejected after
  acceptance.

New threads and runs no longer resolve or store a video model; the member
default is no longer written or returned. Thread metadata and thread events
still expose the historical `selectedVideoModel` value (null for new threads;
the follow-up above sends null for all threads), and the `video_model_updated`
event kind stays readable for replay.

No database migration is included. Historical usage and credit records keep
their `video` and `audio` rows and display names. Dropping the thread, member,
run, and event video model columns is left for #37249, after the client floor
excludes the old App. `video_model_updated` is a strict enum member of
persisted events, so historical events must be compacted or migrated first.

## Chat send diagnostics and model admission (release 5)

Migration `1277_chat_network_body_captures` adds a sparse table keyed by the
input chat-event ID. Only sends requesting `captureNetworkBodies` write a row,
in the same transaction as the input. The table also records the owning thread
for cascade cleanup and a creation timestamp; it does not store model choices
or general send options. Pick reads the marker and passes the existing capture
flag to run creation, which retains the production staff-organization gate.

The migration runs before API promotion. Older APIs ignore the additive table,
and existing inputs without a marker keep capture disabled. During mixed API
operation or rollback, an older picker does not read the marker, so a capture
request it consumes may launch without network-body capture. The marker grants
no permission and changes no Runner protocol. Once a new API creates the run,
capture uses the existing persisted run configuration. No new rollback floor
is required.

Chat sends no longer accept structured `runOptions.video`. The nested request
schema strips this unknown key from older clients; the other run options remain
supported. New clients omit the key and work with older APIs. The Create
composer still includes its video instructions in the message's agent-only
additional information, but there is no structured video-options persistence.

Model admission happens when an input is picked. A thread's selected model
that is unavailable in its workspace rejects the input as `bad_request`; a
configured route that the plan does not cover rejects it as
`insufficient_credits`. The picker no longer switches a persisted selection to
another model. This also applies to inputs queued before the policy changed.
Older pickers retain their previous fallback behavior during API rollout or
rollback; the event and thread data shapes are unchanged.

## Retired preference and occurrence columns dropped (2026-09-28)

Migration `1274_drop_retired_voice_reasoning_collection_columns` drops
`org_members_metadata.voice_input_model`,
`morning_brief_native_occurrences.collection_facts` and
`chat_threads.reasoning_effort`, and removes their Drizzle declarations. This
is the contract step for the voice input model retirement (#36561), the Morning
Brief collection account retirement (#36719) and the pre-GA thread reasoning
effort column, whose effort now lives in `model_settings`. No current API reads
or writes any of the three columns.

Gate evidence: both retirements are ancestors of the current API rollback floor
(`08c7ad2455c8fcd2b043ba8fe3639b558cb98b48`, #37110) and of the production API
(`api-v1.686.2`, `218ac4f621983bc708209505bd5f20df3ccda064`). No supported
rollback target reads or writes the values.

Every API before this change still declares the columns, so Drizzle names them
in `insert` column lists and in bare `select()`/`returning()` on those three
tables. As with `1228`, `test:migration-consistency` requires the declaration
and the physical schema to agree, so declaration removal and the drop ship in
one release. Migrations run before API promotion. Until the previous API drains,
its chat thread, member preference and Morning Brief occurrence statements
receive `42703`. That window (about 20 seconds in the `1228` release) is
accepted; release this change at low traffic.

Rollback promotes artifacts without restoring schema, so
`resolve-production-rollback-target.sh` rejects API targets that predate the
canonical main commit that added `1274`. Recovering past that commit requires a
forward-fix migration that restores the columns.

The migration replay tests for `1156` (GPT 5.5 retirement) and `1213` clone the
current schema. The `1156` replay restores `chat_threads.reasoning_effort` in its
clone because that historical migration still clears the column; the `1213`
fixture no longer inserts it.

## Custom API request headers retired (2026-09-27)

The API no longer reads, echoes, or allows these request headers in first-party
CORS preflight: `X-Chat-Event-Schema-Version`, `X-Client-Product`,
`X-CSRF-Token`, `X-Requested-With`, `Accept-Version`, and `X-Api-Version`. The
response header `X-Chat-Event-Schema-Version` is no longer exposed. The last
four had no first-party sender. Desktop sent `X-Client-Product` from its
Electron main process, which does not use CORS; the API now ignores it.

Chat Event schema negotiation is replaced by the general client rules in
[Chat Event schema versioning](./chat-event-schema-versioning.md). Web App
builds before this change send the schema header on Chat Event reads and reject
responses that do not echo it. Once the new API serves, a still-open old tab
fails Chat Event preflight and cannot receive `426 Upgrade Required` for those
reads until it is reloaded. Its other API requests still pass preflight and can
receive `426` after the Web client floor is raised. Raising that floor to the
first App build containing this change is therefore a required follow-up release
step. CLI artifacts live at most about two hours and need no separate floor.

Older APIs require the schema header and answer header-free Chat Event reads
with `400`. The marker `.github/rollback-floors/chat-event-schema-header-retired`
therefore sets the API rollback floor: `resolve-production-rollback-target.sh`
rejects any target that predates the main commit adding it.

## Browser native-input handoff guidance (#37087)

The agent tool prompt now prefers native input over direct Browser takeover only
when both thread Browser access and the existing `BrowserNativeInput` switch are
enabled. The API still enforces the switch for input actions; an older CLI or
agent prompt cannot grant access. When the switch is off, the new prompt does
not advertise native input and keeps viewer takeover as a last resort.

The required `browserNativeInputEnabled` prompt input is written on new runs
and recomputed from the current feature context on stable-context recapture.
Older persisted inputs without it remain readable: recapture uses their
existing trigger source and thread Browser state, then constructs fresh prompt
inputs before calling the prompt builder. The flag participates in the
feature-prompt digest so a changed switch state cannot silently reuse the old
cached guidance. Older API versions ignore the new semantic field; no database
migration or rollback floor is needed.

### Safe tab inspection across native-input callbacks (#37311)

A fresh `agent-browser` attachment may restore a locally persisted tab binding
or select an unrelated live tab; the binding is not guaranteed across sandboxes
or provider restarts, and `okou browser use` does not enable strict `--pin-tab`.
Browser continuation guidance uses `okou browser tab list` to inspect safe
current-session IDs, selected state and HTTP(S) origins. If non-sensitive page
and step evidence confirms the selected tab, the agent keeps it; otherwise it
uses `okou browser tab select <id>` only to inspect a candidate, then confirms
the intended page before any navigation or submission. Neither an origin nor a
selected flag proves the page identity, even with a single matching tab. The
CLI discards untrusted child output, and the prompt forbids directly invoking
raw `agent-browser` tab-list or tab-switch commands: their tool output can
expose full URLs, titles and OAuth parameters even if not quoted to the user.
The CLI cannot recover the native action's exact page target. If identification
remains ambiguous or the page is missing, the agent stops instead of guessing.
A successful native input write still does not submit the website form or
establish login.

The API prompt and these CLI commands are delivered in the same code change.
New launch contexts bind the serving API's CLI package, but queued runs may
retain an older CLI that lacks the safe commands. The prompt explicitly stops
when safe tab inspection is unavailable and never invokes the raw commands as
a fallback. No stored Browser action, callback, provider contract, or
feature-switch state changes, so older API/CLI pairs retain their previous
guidance and behavior.

## Member source-first onboarding completion column (2026-09-27)

Migration `1269_org_member_onboarding_completed_at` adds the nullable
`org_members_metadata.onboarding_completed_at` column. It is a metadata-only
`ADD COLUMN` without a default, so it takes a brief `ACCESS EXCLUSIVE` lock
under the default 1s lock timeout and rewrites no rows.

The column records one non-admin member's own completion of the source-first
onboarding. `GET /api/onboarding/status` reads it only for a non-admin whose
`OnboardingSourcesFirst` switch is on, and `POST /api/onboarding/complete`
writes it only for a non-admin caller. Admin status and completion are
unchanged and never touch the column.

Old and new versions during deploy:

- Old API with the migrated database: it neither reads nor writes the column,
  keeps every member at `needsOnboarding: false` and still refuses member
  completion with `403`. A rollback therefore only stops offering the flow to
  members; members who already completed keep their stamp for a later
  roll-forward.
- New API with an old app: an old app already routes a non-admin with
  `needsOnboarding: true` through the member branch (no invite, no Slack) and
  would reach the old ready step, which skips completion for members and
  starts their first chat. The new API counts that chat as use, so the member
  is not sent back into onboarding. This is reachable only for members with
  the non-GA switch on, so no compatibility code is added
  (`docs/fallback.md` section 2).
- New app with an old API: the old API never reports `needsOnboarding: true`
  for a member, so the new member branch, including its completion request,
  is unreachable.

No API rollback floor is needed.

## Unified chat queue (release 7): current launch compatibility

Release 7 completes the unified queue and removes compatibility code made
unreachable by release 6:

- The reserve and receipt endpoints
  (`POST /api/runners/runs/:runId/active-inputs/reserve` and
  `.../active-inputs/deliveries/:deliveryId/receipt`), their contracts and Rust
  bindings, and `activeInputDeliveryIds` with its completion-time settlement.
  Only `steerable-inputs/next` and `steerable-inputs/:eventId/steered` remain.
  They also steer run-targeted `input.budget` events: a replacement retains
  its type and gains the current `runId`, with the revoke edge providing
  idempotence. Completion revokes any unconsumed warning. The Runner/Guest
  response shape remains the existing event ID and prompt.
  The completion body is not strict, so a stray `activeInputDeliveryIds` is
  stripped.
- The Guest reads installed-CLI requirements from `piInstalledCliRequirement`
  in the captured execution context. `okou run usage` accepts only the
  `sandboxProxy` source.
- `PI_SANDBOX_INSTALLED_CLI_MIN_VERSION` remains **9.370.3**, the launch-payload
  compatibility floor. A newer published CLI does not justify raising it:
  eligible installed CLIs must still satisfy the captured runtime/session
  construction identity, otherwise the Guest uses the commit-addressed
  `CLI_PKG_URL`. Do not lower the floor without proving that older strict CLI
  readers accept the current launch payload.

The completed rollout gates and predecessor handoff protocol no longer
constrain deployments. The independent Chat Event V8, Browser session mutation
and migration 1315 rollback checks are later first-parent main commits than
this release, so they subsume its former standalone rollback marker. Those
checks remain mandatory in `resolve-production-rollback-target.sh`.

### Integration DM threads and org default agent

- **DM routes (migration 1279).** The main direct-message conversation of each
  integration identity now maps to one chat thread through the fixed route key
  `direct-message:main` (Slack `thread_ts`, Feishu and Teams `thread_id`,
  Discord `session_key`, official Telegram and AgentPhone `root_message_id`).
  The migration keeps the most recently used `direct-message:%` route per
  connection/link ID (regardless of older channel IDs), rewrites its key to
  the constant. It preserves every thread's model, provider and service-tier
  selection and writes no thread or chat-thread events. It deletes the other
  DM route rows; their chat threads and canonical input
  messages remain as history. Existing Discord route foreign keys also cascade
  deletion to the detached route's private launch context and ingress rows.
  No new table, column or constraint is introduced. Deploy window:
  the migration runs before the new API, so an old API instance that receives a
  DM in that window no longer finds its `direct-message:<agentId>:<model>` key,
  creates a new thread and inserts an old-style route. After promotion the new
  API uses the `direct-message:main` thread; the window thread stays as
  history and its old-style route is unused. Rollback to an earlier API has the
  same effect: each DM opens one new old-style thread, and replaying the
  migration later folds it back in by recency.
- **Model selection at enqueue (migration 1281).** Web and every integration
  use the same rule. Existing threads use their stored model, or the org
  default when that model is unavailable. New threads initialize their model
  from the member preference, then the org default; explicit web model choices
  remain normal thread edits. Each input captures the effective model, tier
  and reasoning effort in the nullable server-only JSONB
  `chat_events.model_selection`. A thread's unavailable choice is not
  overwritten merely because an input uses the org default. Pick validates
  the captured choice without consulting current thread/member preferences;
  if it is unavailable, the input becomes `input.rejected` without fallback.
  `direct-message:main` is only a route key and has no model semantics.
  Model settings update the thread normally. Integration `/model` commands
  still set the member default for newly created threads; `/new_session`
  remains an intentional conversation reset.
  The additive column is separate from the strict public event payload, so
  old API/App/SharedWorker readers and archive paths can ignore it. Migrations
  precede new code; old writers omit the column and remain valid. No hot-table
  backfill is performed: pending inputs from an outgoing API lack a captured
  model and are rejected by the new pick instead of being re-resolved. Steering
  inputs into an already-running run uses that run's existing model. Keep the
  column on rollback; the existing rollback resolver floors remain unchanged.
- **Org default agent only.** Integrations no longer read or write the
  `*_user_agent_preferences` tables or installation-level `default_agent_id`;
  every integration message runs the org default agent. The tables and columns
  are not dropped in this release because the migration runs before the new
  code and earlier APIs still read them; a later release or the daily
  compatibility cleanup drops them. Rolling back restores the old per-user
  selections, which were left untouched. A legacy integration thread bound to
  a former per-user preference moves once to the immutable org default at pick,
  in the same transaction as the new run and session binding. The single-row
  CAS matches thread ID, owner and former agent; it has no default-change
  subquery or visibility branch. Rebinding starts a new native/Pi session. The existing
  `sort_touched` event carries an explicit optional `reassignedAgentId`;
  updated clients replay that identity update without resetting other metadata.
  Ordinary activity and optimistic pin-order events may carry an old `agentId`
  and never reassign the thread. Older clients ignore the additive field and
  retain their previous agent until they load a newer canonical snapshot.
- **Feishu/Lark installation binding (migration 1279).** Every physical
  `feishu_org_installations.default_agent_id` is set to its org default for
  both platforms. The default cannot change or be deleted, so the retained
  `ON DELETE CASCADE` foreign key no longer follows a retired user selection.
  Old instances read the same default; the new runtime mapping omits the
  retired column, which is dropped only in a later compatibility cleanup.
  The migration changes routes and installation bindings only, with no
  `chat_threads` or event-table updates and no lock-timeout adjustment.
- **Agent reassignment events (migration 1280).** The nullable UUID column
  `chat_thread_events.reassigned_agent_id` records only canonical reassignment
  facts, in the same transaction as the thread and run binding. No DM routing
  table changes. Existing events and outgoing API INSERTs leave the column
  null; the new API omits it from ordinary event responses. Both full and
  incremental event reads include it on reassignment events. The migration
  runs before the new API, so outgoing API statements remain valid; the new
  API requires the column before promotion. App/SharedWorker/IndexedDB use the
  optional contract field and keep accepting earlier events without it. An old
  App may also omit the field from cached events; upgrading does not change
  those cached facts, and a newer canonical snapshot resolves their identity.
  This field adds no rollback floor beyond the existing rollback resolver floors. Keep the
  column on rollback; older APIs and Apps can ignore it, while snapshots read
  the canonical thread agent directly. It is a permanent event fact with no
  compatibility fallback or removal deadline.
- **Self-hosted Telegram bots retired.** Only the official shared bot remains.
  The API no longer reads or writes `telegram_installations` or
  `telegram_user_links`, and the register, setup-status, bot delete and bot
  default-agent routes are removed; bot-scoped Telegram routes answer `404` for
  any bot other than `official`. Webhooks that the nine self-hosted bots still
  have registered with Telegram are not deleted and receive `404`. Their chat
  threads remain as history. Dropping the two tables is left to a later
  release, like the preference tables. The Discord agent-preference route is
  removed as well; an old App tab calling it receives `404`.
  The Telegram CLI no longer has `bot list`, `--bot-id` or `--as`: message
  send, upload and download use the official bot directly. The unified `--to`,
  `--reply-to`, `--topic` and `--json` options remain, including `--to me`. The existing official
  bot API paths remain usable by deployed CLIs. Integration notes and CLI
  help no longer ask the user to choose a bot.

### Pi memory and queue cleanup

Maintenance admission and job binding run through `persistProducerRunBinding`
in the launch transaction. The core accepts a generic no-agent identity,
threadless session parameters and an explicitly empty secret namespace; claim
validates session owner and organization without reading Pi jobs. Pi memory
retains its own leases, fences, retries, result publication and cleanup/cancel
protection. Only maintenance completion takes the existing memory-storage
lock. The bypass still occupies a slot without applying the org concurrency
limit, and releases through the same org-pick path.

An idle queued head that cannot launch is consumed as `input.rejected`, even
when assembly or rejection formatting fails. Only an actual active run leaves
an unchanged head for a later pick. Concurrency admission stays in the picker;
there is no create-time 429/waiting result. Stripe capacity changes schedule
org picks through `waitUntil`. Entry-owned context rows commit with their input,
and idempotent sends that append nothing do not touch `queued_chat_threads`.
The existing runless-input predicate and index from #37193 are unchanged.

## Unified chat queue (release 4)

Migration `1273_drop_active_input_delivery_tables` drops
`active_input_delivery_items`, then `active_input_deliveries`, and their schema.
Release 3 (#37082) removed every read and write of both tables. Dropping them
removes their foreign keys to `chat_events`, `agent_runs` and `chat_threads`,
which takes a brief `ACCESS EXCLUSIVE` lock on each referenced table under the
default 1 s `lock_timeout`.

**Merge gate:** merge only after release 3 (#37082) is released to production
and every earlier API instance has drained (no Axiom output from an earlier API
commit).

**API rollback floor: release 3**, main commit
`553fc566b7e9be2cd4a8c1de314d55939b99490a`, pinned in
`resolve-production-rollback-target.sh`. Release 2 APIs reserve steered input by
writing the dropped tables. Rolling back to release 3 is safe: it never names
the dropped tables and understands every replacement event this release writes.

Release 4 also adds two runner steer endpoints next to the unchanged reserve
and receipt endpoints: `GET /api/runners/runs/:runId/steerable-inputs/next`
returns the next run-less, unrevoked `input.prompt` after the queue input the
run consumed last, without writing, and
`POST /api/runners/runs/:runId/steerable-inputs/:eventId/steered` consumes it
with the same replacement event as receipt. No Runner calls them yet; the
current Runner keeps using reserve, receipt and `activeInputDeliveryIds`, so the
additive endpoints need no deploy order. A later Runner that calls them
requires an API at or above this release.

## Unified chat queue (release 3)

Every input, from web sends and MCP to integrations and automations, enters
through one enqueue entry: upsert `queued_chat_threads`, append the run-less
`input.prompt` or `input.automation` event, then pick the thread once. One pick
path launches runs; a running sandbox run consumes `input.prompt` by steering.
Both consume an input the same way: a replacement event carrying the `runId`
with `revokesEventId` set to the input, so the unique revoke edge is the only
mutual exclusion. Schedule coalescing, already best-effort and lock-free since
the prepared-key retirement, moves out of admission to the schedule trigger,
which revokes its old unconsumed schedule tick (never a manual Run now) when it enqueues the new one;
a journaled Morning Brief tick does so only after its claim succeeds, in the
same transaction. Only `CONCURRENT_RUN_LIMIT` keeps
an input waiting; every other launch failure appends `input.rejected`.

Steering no longer reads or writes `active_input_deliveries` or
`active_input_delivery_items`. Reserve returns the source `chat_events` id as
the delivery ID without writing; receipt and completion insert the run's
replacement on the revoke edge. Release 4 drops the tables. See
[active input delivery](./active-input-delivery.md). Runner and Guest do not
change: they treat the delivery ID as an opaque UUID.

**Merge gate:** merge only after release 2 (#37063) is merged and released to
production, every earlier API instance has drained (no Axiom output from an
earlier API commit), and the API rollback floor is at release 2. The
[`agent_run_queue` drop](#agent_run_queue-dropped-release-3) already enforces
that floor, so this change adds no migration and no new floor.

Rolling back to release 2 is safe: this release persists no new shape, and
replacement events look the same to both. This release writes no delivery rows,
so release 2 reserves new ones for inputs this release left pending. Delivery
rows that release 2 itself opened during the overlap are the exception: a
receipt or terminal callback that reached this release left them `open`, and
release 2 settles an open delivery only in its own run's receipt or terminal
callback. After a rollback, such a row keeps hiding its source input from
release 2's pick and steering until the row is settled by hand or the user
sends again; an input this release already picked is consumed and unaffected.
**Accepted risk:** this touches only inputs reserved in the overlap window
whose run's callbacks ran on this release and that were still pending at the
rollback.

Old and new instances during deploy:

- Enqueue and pick: both APIs admit through `queued_chat_threads` with the same
  lease, idle-thread and capacity checks, so either picks input the other
  enqueued. An older API still coalesces a schedule tick inside admission
  while this release revokes the old tick from the trigger, so an overlapping
  tick can add one extra automation input. This is accepted.
- Steering: release 2 reserves by writing a delivery row and returns its ID;
  this release returns the source event ID. A receipt or completion that reaches
  the other API cannot settle that ID, so the source input stays run-less and a
  later pick runs it again. The same holds for release 2 deliveries left
  unsettled across the deploy. **Accepted risk:** for the few minutes both APIs
  serve, and for those old deliveries, the model may see the same steered
  message twice. No message is lost, and no compatibility fallback is added.
- Pi API-first runs no longer steer. A message sent during such a run stays
  queued and is picked after the run releases its slot. Release 2 instances
  may still hand such a turn to a sandbox; both outcomes consume the input once
  through the revoke edge.

## `agent_run_queue` dropped (release 3)

Migration `1272_drop_agent_run_queue` drops `agent_run_queue` and its schema.
#37063 (`84ac71914345b8360f3df43cc2cd47f0a8af7a23`) removed every read and write
of the table. Before this release, production evidence showed (2026-09-27, read
at 12:12–12:14 UTC):

- The first production API containing #37063 (`6b624e6e`) went live at
  08:34:16Z; every API promotion since contains it.
- Axiom `vm0-traces-prod`: the last `vm0-api` span from a version without
  #37063 was at 08:34:15Z; the last hour only has versions containing it.
- MaskDB: `agent_run_queue` has 0 rows, `agent_runs` has no `queued` run, and no
  `run.queued` event was written in the last 24 hours.

**API rollback floor: `84ac71914345b8360f3df43cc2cd47f0a8af7a23`** (#37063),
raised from #37034 and enforced by `resolve-production-rollback-target.sh`. The
#37034 API still reads `agent_run_queue` while promoting, so it would fail on
the dropped table. The KMS 013 recovery manifest treats the table as optional so
snapshots from either side of the drop verify.

## Legacy queued-run promotion retired (release 2)

#37034 stopped creating `agent_runs` rows with `status = 'queued'`: input that
arrives at org capacity stays in `chat_events` without a run and
`queued_chat_threads` schedules its thread. #37034 kept the legacy promotion
(`agent_run_queue` payload decryption, `drainOrgQueue$` and the
`run.queued`/`run.dequeued` markers) only to drain queued runs left by older
instances. This release deletes it: no API reads or writes `agent_run_queue`,
and nothing appends queue markers. Historical `run.queued`/`run.dequeued` rows
still parse and render, and `queued` stays a valid historical run status. The
`agent_run_queue` table and schema remain until release 3 drops them.

Migration `1268_retire_legacy_run_queue_promotion` deletes any
`active_agent_runs` row whose run is still `queued` (the production gate
expects none), so the table only holds rows of pending and running runs, plus
started terminal runs until their runner is released. It also drops
`chat_events_pending_queue_idx` concurrently: every pending-input read is
scoped to one thread (or a bounded set of threads) and takes run-less input
rows through the thread indexes, then drops revoked rows through
`chat_events_revokes_event_id_not_null_unique`.

**Release gate:** ship this release only after the #37034 release is live in
production and every earlier API has drained, so no queued run remains to be
promoted.

**API rollback floor: `4d4c7599bbece03bab5c1851da467702685bc1ea`** (#37034's
merge commit). Rolling back to #37034 is safe: it creates only pending runs,
and its leftover promotion finds nothing to promote. Older APIs create queued
runs that no deployed API promotes, so those messages would never start.
`resolve-production-rollback-target.sh` rejects targets below this floor.

Old and new instances during deploy:

- This API with the #37034 API: both create only pending runs and admit queued
  input through `queued_chat_threads`. The #37034 API still runs the legacy
  promotion, which finds no queued run; this API ignores `agent_run_queue`.
- Slot hand-off: this API wakes queued threads where an `active_agent_runs` row
  is deleted (Runner completion of any kind, cancel of a never-started run,
  claim failure, cron timeout) instead of from terminal chat callbacks. The
  #37034 API still wakes from its callbacks and terminal side effects. Either
  API picks with the same lease, idle-thread and capacity checks, so a run that
  ends on the other API's instance is still handed off, and a duplicate wakeup
  finds the thread busy or the organization full. No persisted shape changes.
- Either API with the migrated database: neither depends on
  `chat_events_pending_queue_idx`, and neither expects an active row for a
  queued run.

## Queue response fields removed (2026-09-27)

No run waits in a queue since queued runs were retired, so `GET /api/runs/queue`
returned `queue: []` and `estimatedTimePerRun: null`, which the App never
rendered. #37079 made both optional in the contract; App builds from `0.973.0`
tolerate their absence, and #37093 raised the client-version floor to
`0.973.0`. This change removes both fields and `queueEntrySchema` from the
contract and the API response. The floor and this removal ship in the same or
consecutive API releases, so every App build that can still reach this API
parses the response without them; older builds receive `426` first.
`runningTasks` and `concurrency` are unchanged. Rolling the API back below
#37093 is unaffected: older APIs still send the fields and the current App
ignores them.

## GitHub direct-chat readers retired (2026-09-27)

#24941 removed the only producer of GitHub direct-chat input (`issue_comment`
continues only through workflow automation). This change deletes its readers:
the `github` queued-launch loader, the chat callback payload's `githubDelivery`
field, the `github:chat` delivery callback writer and dispatcher, and the
GitHub admission-failure delivery. The chat callback payload schema is
passthrough, so a payload an older API wrote with `githubDelivery` still parses
and is ignored; an older API reading a new payload sees the optional field as
absent. No producer has existed since #24941, so no such payload or pending
`github:chat` callback is in flight (production has one delivered row).
`github:chat` stays in the SQL inline-only exclusion lists of the callback
dispatch queries, so historical rows are never dispatched as HTTP callbacks.
Persisted `context_type = 'github'` events and GitHub source annotations still
parse and render; like `automation` and `goal`, a `github` context can no
longer route a queued user message. No App, CLI or public contract changes.

Migration `1270_drop_github_chat_tables` then drops `chat_github_context` and
`github_chat_thread_routes`, and the queued-event monitor stops checking
`github` contexts. The older API still has GitHub readers for both tables, but
they only run for a `github` context event or a GitHub delivery callback, and
production has neither pending (zero `github` context events; one delivered
`github:chat` callback). Its queued-event monitor queries a context table only
for context types present among the scanned events, so it never reaches the
dropped table. `context_type = 'github'` stays in the `chat_events` check
constraint as a historical value.

## pgstattuple extension dropped (2026-09-26)

Migration `1265_drop_pgstattuple` runs `DROP EXTENSION IF EXISTS pgstattuple`.
`1178` installed it only so the chat search projector could read
`public.pgstatginindex`. `1263` turned `fastupdate` off on the remaining chat
search GIN index and #36990 removed that projector maintenance; #36990 reached
production on 2026-09-26T04:49Z (release `224656bd`). No current code calls a
`pgstattuple` function.

**API rollback floor: `98b5515ae2874128734b19a17b96dc8c6c7afe47`** (#36990's
merge commit). Earlier API artifacts call `public.pgstatginindex` at the start
of every chat search projection tick; after this migration that call fails with
`42883` and the tick projects nothing. Rolling the API back does not reinstall
the extension. `.github/scripts/resolve-production-rollback-target.sh` enforces
the floor.

## Resource creation advisory lock retirement (2026-09-26)

VNC host and credential creation now use their existing primary keys to
arbitrate duplicate IDs. A losing insert rolls back the whole transaction,
including any inline credential, before resolving an owned replay or an ID
conflict. Only the requested table's primary-key violation is handled; unrelated
constraint and database failures still propagate. Existing-resource VNC replays
still skip KMS.

Banking Connect creates sessions under a short `FOR NO KEY UPDATE` lock on the
existing connection row, retaining the partial unique index for one pending
session. The transaction rechecks ownership and live state, supersedes the old
session, and inserts the replacement. Provider requests remain outside it. This
lock mode is compatible with the foreign-key checks used by account syncing.

`VncAccess` and `Banking` are both registered as default-disabled, non-GA
features. Their advisory locks retire in the same release under the
[pre-GA policy](fallback.md#2-features-behind-a-feature-switch-need-no-fallback).
Mixed old/new API writers can make an old request fail with a unique-key error
during the cutover; the existing constraints still prevent duplicate resources
or pending sessions. This is the bounded pre-GA cutover exception, not a claim
that the old and new locking protocols coordinate with each other. The API
contracts and stored shapes do not change, and no migration is required.

SSH and Cloudflare Access creation use the same exact-primary-key conflict
recovery, including two admins creating the same organization-scoped Access
configuration. Their resource-ID advisory lock is retired after the #37009
preparation reached production. The separate owner lock remains; supported
rollback targets must include the conflict recovery under the API floor below.

## Resource and lifecycle synchronization cleanup (2026-09-26)

Connector refresh failures now use the existing single conditional UPDATE,
matching the connector identity, owner, auth method, and exact state revision.
It cannot mark a subsequently reconnected account as needing reconnection.
Other connector-state writers keep their current coordination.

Migration `1266_feishu_installation_org_platform_unique` adds the missing
unique key on Feishu/Lark `(org_id, platform)`. Configuration uses this key and
the existing global `app_id` key, with exact owner/platform/app predicates on
updates. The migration runs before the new API and fails on historical duplicate
installations instead of choosing or deleting a bot. Feishu and Lark remain
non-GA, so an old concurrent create may receive a unique violation during
cutover under the pre-GA policy. No compatibility fallback is added.

The canonical Agent mutation advisory key is removed. Its Stage 6 database
bridge was dropped by #28880 on August 24. Agent edits/deletion retain their
existing row protection, and child mutations check parent existence with
compatible KEY SHARE reads before updating their own resources and generations.
The separate public-Agent quota key remains. No stored shape or API contract
changes. An outgoing connector-selection writer can still leave an inert
non-FK generation or publication row after deletion; Agent foreign keys and
builder existence checks prevent that metadata from restoring a resource or
authorizing a run. Conflicting outgoing writers retain the existing
transaction rollback and deletion-conflict responses.

Browser profile creation prepares the external profile outside a transaction,
then uses the thread's unique profile key to select the owner. Unused external
profiles are reclaimed. Cleanup checks the target profile and exact session
identity/version before removing state. The profile advisory key is retired;
the exact cleanup predicates prevent cleanup of profile A from deleting a
replacement B. Provider creation remains outside the transaction.

The retired Native Morning Brief collector was the only production consumer
of `chat_threads.provenance`. Its writes, service, and implementation-only
tests are removed; the nullable column and historical migrations remain.
Automation resolution now uses the existing unique owner binding and its row
lock, without writing a reused destination thread. Its resolver advisory key
is retired. The binding is locked before its destination is read, so concurrent
resolvers observe the current binding instead of an earlier destination.
Browser and the shared Morning Brief resolver are GA paths; both rely on the
#37009 preparation and the API rollback floor below, not the non-GA catalog
switch. No new lock or fallback is introduced.

## Scoped advisory cleanup and owner-row preparation (2026-09-26)

Nine more caller entrypoints stop acquiring redundant advisory locks:

- The Workflow queue-head lookup is one primary-database SELECT. It reserves
  nothing; final launch still claims the event's unique revoke edge and active
  run identity in its own transaction.
- Browser screenshot persistence is one UPSERT on the thread primary key.
- Standalone SSH credential and Cloudflare Access creation retain exact-ID
  conflict recovery, without the retired creation-ID key or the owner
  key. SSH host deletion and host-key reset retain their exact host row lock,
  ownership, generation, and foreign-key checks without the owner key.
- Connector account rename retains the exact account row lock and an
  owner/target-qualified UPDATE without the shared target helper.
- Remote-host defaults use one owner-qualified UPDATE. The VNC path no longer
  enters the three cleanup keys and owner key; override and binding mutations
  keep their existing lifecycle protocol.
- Failed Official Workflow installation cleanup no longer requests the catalog
  and organization keys. Its required `installing` state and Workflow row lock
  arbitrate against the activation CAS; installed uninstall is separate.

These narrow removals preserve coordination with outgoing writers through the
same primary keys, unique constraints, conditional writes, and existing row
locks. Public-Agent quota acquisition also becomes conditional: public create
and requests setting public visibility acquire it before the Agent row;
private creation and other metadata edits do not. The seven-public-Agent limit
is unchanged. No persisted shape changes.

Social admission replaces its organization advisory key with
`FOR NO KEY UPDATE` on the existing organization row. Reservation sums and the
hundred-unsettled-job limit stay inside that transaction. Its allowance check
is a read-only snapshot: it must not acquire the credit key while holding the
organization row, because credit settlement acquires those in the reverse
order. Only an insufficient-balance request with an expired allowance releases
the transaction, refreshes the allowance once through the existing billing
path, and repeats the complete admission check. Requests with sufficient
credits do not acquire a new Stripe dependency. Provider job requests remain
outside admission.

Social is non-GA and uses the same-release cutover policy. Outgoing admissions
still use the retired advisory key, so old and new writers can overshoot the
reservation limit while overlapping. The new protocol preserves the limits
among new writers; it does not claim mutual exclusion with old writers. No
compatibility branch or additional advisory key is introduced.

Five Official catalog readers (copy, run, reconciliation, installation, and
uninstall) replace shared advisory acquisition with `FOR SHARE` on the existing
accepted-catalog singleton. This conflicts with the old publisher's pointer
UPSERT as well as the new publisher's row lock. Exact revisions and storage
versions are immutable; Official runs and copies do not read a mutable Storage
HEAD. New publication locks the singleton before changing dependent rows, uses
the singleton primary key for first publication and an expected-pointer UPDATE
thereafter, and commits the pointer, revisions, artifact heads, and
reconciliation work together. A losing first publisher rolls back all writes.

The publisher's catalog advisory key and the normal-admission organization key
are retired after this preparation reached production.
Official run admission takes its credit plan row before Workflow/Automation
rows, matching reconciliation; the singleton protects accepted catalog reads
and publication. These shared paths include GA Morning Brief, regardless of
catalog discovery flags. Copy has a separate conflict-recovery preparation
below; failed Run persistence and uninstall do not enter the plan lock and no
longer acquire the organization key. Reconciliation retains its organization
key for the additional Morning Brief row-order preparation below.

Built-in generation admission now locks the existing Run row with
`FOR NO KEY UPDATE` before expiring and counting admissions and inserting the
winner. The three-active and fifty-started limits remain, and the transaction
ends before provider requests. Its original advisory key is retired; serving
admission writers and supported rollback targets use the same Run row protocol.

User export now claims through the existing active-job partial unique index
before checking the completed-job cooldown. A conflicting request returns the
active job from a no-op conflict UPDATE, without a second-read gap or changing
its timestamps. A new claim that fails the twenty-four-hour cooldown rolls
back, and only a new accepted claim enqueues work. The GA admission key is
retired; serving and supported rollback writers use this conflict-handling
protocol rather than a bare INSERT.

## Prepared advisory key retirement and writer preparation (2026-09-27)

The supported production aliases and cron use API **1.682.4**, commit
`931167c9d234821a3ffd186d7493058e92631cb3`, which includes #37009's replacement
protocols. Current production was verified on 2026-09-27. For this cutover,
Ethan confirmed production readiness and excluded retained deployment URLs
from the supported serving surface; their continued existence is not a
retirement gate. This does not claim that the retained deployments were deleted
or that their endpoints reject requests.

Seven prepared acquisition sites now retire: Browser profile, automation
destination resolver, SSH creation-ID, user export admission, built-in
generation admission, Official catalog publisher, and the Official
normal-admission organization site.

**API rollback floor: `c639e3397602b5c9b049315c7a99f5ed2e23e660`** (#37009).
`.github/scripts/resolve-production-rollback-target.sh` rejects older API
artifacts before artifact selection. A supported rollback retains the same
constraint, existing-owner-row, and catalog protocols even if it still acquires
the retired advisory keys. No schema migration is needed for this retirement.

Morning Brief dormant reconciliation needs one further preparation. Its
reservation/staging paths already take native owner authority before the
Workflow, but validation/finalization in API 1.682.4 take the same rows in the
reverse order. The organization key currently serializes those transactions.
Validation/finalization now follow native authority, Workflow, then
Automation/identity, reusing the existing locks. Keep the reconciliation
organization key until this preparation covers serving and supported rollback
versions and outgoing reconciliation transactions drain. #37009 alone does not
satisfy this new gate: a new reservation without the organization key could hold
native authority while an outgoing validation holds the Workflow, leaving each
waiting for the other's row. The native authority still owns the selected
Morning Brief lineage and first-materialization mirror; it is not redundant.

Official failed Run persistence and installed uninstall no longer acquire the
organization advisory key. Both retain the accepted-catalog singleton read,
the existing parent/Workflow/Automation row protection, and exact installation
and revision validation. The failed Run branch does not admit credit, and
uninstall performs provider cleanup after commit. Neither enters the credit
plan after Workflow rows, so these removals do not depend on the separate
normal-admission ordering preparation above.

Workflow event admission now acquires the queue key only for schedule
automations, including manual schedule executions that must coordinate with
cron coalescing. Event automations retain their delivery identities, source
transition CAS, transactional event insertion, and final Run claim. Connector
and check-in rewards have no total-count cap: their shared redemption helper
retains the exact reward key, claim and credit transaction but skips the owner
key and count query. Capped rewards keep their existing protocol. Old and new
requests still coordinate on each reward identity; no migration or rollout
wait is required for these narrower entrances.

Official copy now handles only the private owner/Agent/name unique constraint
after the complete copy transaction has rolled back, returning the existing
name-conflict response and cleaning up the unpublished volume. Different
Official source installations can target the same private name without sharing
a source row, so row protection alone cannot replace this conflict handling.
The copy organization key remains until this preparation covers all serving
writers, outgoing copy requests have drained, and supported rollback targets
include it. The earlier #37009 preparation does not contain this recovery.

Device authorization prepares tokens before its commit transaction. The
existing connector account target serializes start and completion; the exact
poll claim, connector credentials, and completion marker now commit together.
A superseded claim writes no credentials, and a failed credential write also
rolls back the session transition. Provider work and post-commit cleanup remain
outside the transaction. The device-specific key stays on start and completion
until every serving and supported rollback writer uses this atomic protocol
and old requests drain: an outgoing completion can otherwise persist stale
credentials in its separate transaction after a replacement start. No new lock
key, lock table, schema migration, or persisted shape is introduced.

## Advisory prechecks and exact-identity callers (2026-09-27)

Browser's active-to-suspended and expired-claim release operations use their
existing conditional UPDATE directly. Non-event-source connector selection
clear keeps parent KEY SHARE protection, exact selection identity and atomic
generation invalidation; the six automation event sources keep the target
key for source reprojection. Connector/check-in rewards use the existing
actor/quest/source unique claim, claim row lock and transactional credit
idempotency instead of the exact reward key. Bootstrap finalization reuses the
key already held by its caller in the same transaction. These narrower callers
coordinate with outgoing writers through unchanged SQL predicates, constraints
and existing row protection. No schema or API contract changes are required.

Ordinary allowance availability now reads the existing single-query snapshot.
Only `allowance_refresh_required` enters the existing credit-locked Stripe
refresh transaction. Missing windows still report their entitlement limits;
window initialization, authoritative admission, settlement and payment-failure
grace rules are unchanged. Neither the previous committed precheck nor this
snapshot reserves units for a later operation. Telemetry retains both timing
series, with zero credit-lock wait for a snapshot.

SSH host create/update translate only
`ssh_connections_credential_owner_fk` violations to the existing credential
404 after the whole write transaction rolls back. This is preparation, not
permission to remove credential deletion's owner key: rotation currently locks
host rows before the credential, while DELETE locks the credential before its
RESTRICT check can lock a newly attached host. The existing owner key prevents
that cycle. Future removal needs a compatible lifecycle lock order and the
precise error handling in all serving/rollback writers; this batch leaves the
key and rotation ordering in place.

## Constraint arbitration and narrower advisory entrances (2026-09-27)

Get Started redemption now uses its existing reward-key, beneficiary/quest/slot
and Slack-org unique constraints instead of the reward/owner advisory keys.
The claim row lock still owns completion. A savepoint rolls back the entire
credit grant and claim update before interpreting an exact unique conflict;
invite allocation is bounded to the existing 15 global beneficiary slots.
Connector/check-in keep their exact actor/quest/source claim protocol. No schema
or persisted API shape changes. Get Started remains a pre-GA feature: outgoing
old capped-grant writers still encounter the same constraints and may roll back
a conflicting request, but cannot commit duplicate rewards or exceed the cap.

Calendar previous-channel cleanup uses the unchanged watch/current/previous
channel predicates in one UPDATE. Connector deletion/replacement reuses the
first account-target acquisition in its existing transaction; custom deletion
still takes it before reading the account. Bootstrap reservation keeps its
membership upserts while finalization and compensation retain their key.
Standalone VNC credential creation retains all shared cleanup scopes, unique
creation identity and owner checks. Pi failure commits still decide
cancellation under the final lifecycle arbiter. Social settlement retains its
original first-acquisition order and committed ledger transaction. These scoped
removals introduce no unsupported old/new writer combination.

Official copy skips the organization key only when reading its initial source
snapshot. It still holds catalog and existing source rows, releases that
transaction before external preparation, then takes the organization key and
revalidates the complete source for final publication. This does not retire the
final publication key or relax its separate serving/rollback gate.

SSH deletion prepares a short explicit READ COMMITTED transaction: lock the exact
credential FOR UPDATE, validate its revision, read references in a separate fresh
statement without locking hosts, then DELETE by owner/id/revision RETURNING.
The credential lock blocks new FK attachments while the fresh reference check
sees attachments committed before it acquired the lock. An existing host returns
the same in-use response before DELETE's RESTRICT check can wait on a rotating
host. Missing/stale-revision responses and rotation/pin ordering are unchanged.
The deletion caller retains the owner advisory key until both this preparation
and #37071's exact host-FK-to-404 handling cover serving and supported rollback
versions and old transactions drain. The other owner callers remain necessary.
No new key or migration is introduced.

At this batch's 2026-09-27 verification, `api.okou.ai/api/build-info` still
reported API `1.683.0`, commit
`d97a36a06c664b149d2598d5e14a12e7cbd4ea5b`. The newer main release version alone
does not establish serving coverage for SSH or the earlier Device auth,
Official copy publication and Official reconciliation preparations.

## Soft limits and prepared-key retirement (2026-09-27)

Both `api.okou.ai/api/build-info` and `api.vm0.ai/api/build-info` now report API
**1.684.2**, commit `6b624e6e1b23a45386db5c07f9b21a8ffdd8af9f`. Production
[promotion run 36306299421](https://github.com/okou-ai/okou/actions/runs/36306299421)
completed its API promotion at **2026-09-27T08:33:45Z**. The aliases were
rechecked after the API's configured 300-second maximum invocation duration
had elapsed. This covers the supported alias/cron writer surface and outgoing
requests; retained deployment URLs remain outside the serving boundary already
accepted above. It is not a claim that those retained deployments were deleted.

**API rollback floor: `ee863a302a6c547f94e50ec4069f70910d68bee2`** (#37076).
The canonical resolver now rejects earlier targets before selecting artifacts.
This includes #37057's complete-copy-conflict recovery, atomic device completion
and native-before-Workflow reconciliation order, plus #37071's exact SSH host-FK
error recovery and #37076's parent-first credential-deletion protocol.

Official copy, Device auth and Official reconciliation retire their advisory
SQL sites. SSH credential deletion also stops entering its owner helper. The
other SSH owner callers remain. Supported outgoing/rollback writers may still
take these keys, but both versions retain the same unique constraints, account
transaction, row order and conditional writes. Deletion preserves its fresh
READ COMMITTED reference check, revision predicate and complete-rollback host
error mapping. No schema, stored payload or client/Runner protocol changes.

The Public Agent limit is explicitly soft: a request that observes a full
organization is rejected; overlapping requests may both create or publish.
Pending schedule coalescing is also best-effort. A concurrent cron/manual pair
can admit two legitimate events, each of which follows normal Run admission
and billing. Exact scheduled-occurrence claims, event identities, transactional
source transitions, FIFO and Run/event consumption are unchanged. These product
semantics apply during mixed-version serving as well: an old writer's advisory
key does not serialize a new writer, and that accepted overshoot needs no new
counter or coordination protocol.

VNC Agent access retains shared cleanup scopes and existing Agent row
protection; thread override clear only deletes its exact owned selection.
Calendar retry retention keeps its exact channel predicate and cancellation
rollback. Pi's provider preflight only reads eligibility; it leaves authoritative
publication/cancellation checks intact. These narrower entrances require no new
writer preparation.

## Custom account, Browser and bootstrap owner protocols (2026-09-27)

This is writer preparation. All three advisory keys and their acquisition
expressions remain; no schema, persisted payload, public API response or
rollback-floor change is introduced. Old and new API instances still coordinate
on their existing keys throughout this release.

Custom account mutations retain the definition credential-contract protection
already taken by creation and exact deletion. Default changes lock the affected
accounts in ID order with `FOR NO KEY UPDATE`; deletion uses that order for the
deleted account and promotion candidate, then upgrades only the deleted account
to `FOR UPDATE`. A fresh READ COMMITTED statement clears its selections after
the upgrade. Promotion does not block a selection's FK KEY SHARE on the sibling.
SET handles only `fk_chat_thread_connector_selections_custom_connector` after
whole-transaction rollback; initial thread creation handles that same FK within
one selection savepoint and omits that vanished account. Other failures propagate.
Definition deletion, Feishu uninstall and owner cleanup keep their existing
protocols; no early account KEY SHARE is added to selection writes.

Browser creation and resume prepare exact owned-thread unique outcomes. Provider
publication inserts its instance before changing the exact logical browser, in
the same order as physical stop. The logical write compares its observed state;
failure rolls back the instance and screen before mapping to the existing
conflict response and reclaiming the provider. Rejected publication skips the
generic mark-error path; real provider failures can only mark their original
claim. Fresh claims explicitly write the same millisecond timestamp format as
resume, avoiding Date round-trip precision loss. The old advisory key did not
span provider HTTP or establish a unique cross-provider attempt generation;
this preparation does not claim to fix every pre-existing stale observation.
Retention continues to use its exact claim and provider-profile identity.

Bootstrap's final transaction atomically ensures the real Storage parent using
its existing owner/name unique constraint, preserving the incumbent row's ID,
prefix and metadata on conflict. After acquiring that parent it reads the
default Agent in a fresh statement before writing seed instructions. The
publication attempt captures its actual Storage ID and prefix before S3 work.
After rollback, compensation only locks/deletes that captured generation and
rechecks the default Agent after acquiring the row; an absent old row never
redirects cleanup to a new same-name Storage. S3 cleanup uses the captured prefix
after the database transaction. The existing S3 work inside the publication
transaction remains and the Storage row is held earlier.

Before a later key-retirement PR, this preparation must cover supported serving
and rollback versions, and unprepared in-flight work must drain. The current
rollback floor does not prove coverage of code introduced by this preparation.
In particular, old custom deletion can hold a sibling FOR UPDATE while waiting
for a selection; a new keyless selection can hold that selection while waiting
for the sibling. Old bootstrap compensation can read no default, wait for the
Storage, and delete a newer publisher's successful instructions without
rechecking. Old Browser publication still uses unconditional thread writes.
Retaining the common advisory keys prevents introducing those mixed-writer
combinations in this PR. No production release or activation is part of it.

## Workflow import source column (2026-09-25)

Migration `1264_workflow_import_source` adds the nullable
`workflows.import_source` column. It is a metadata-only `ADD COLUMN` without a
default, so it takes a brief `ACCESS EXCLUSIVE` lock under the default 1s lock
timeout and rewrites no rows.

The skill import writes the column when it creates a workflow, from the
`provider` claim in the session token; the workflow list and detail responses
expose it as an optional `importSource`. An older API neither reads nor writes
the column, so a rollback only stops tagging new imports, and an older app
ignores the extra response field. A newer app reads a missing `importSource`
from an older API as untagged; that optional field is a bounded rollout
fallback, removed once the pre-change API is no longer serving or retained as
a rollback target. The session request body and token now require `provider`.
Skill import is still behind the non-GA `OnboardingSourcesFirst` and
`WorkflowSkillImport` switches, so an older app's bodyless session request and
a session token issued before this change are rejected rather than kept
compatible, per `docs/fallback.md` section 2. No API rollback floor is needed.

## Chat search GIN index drops fastupdate and API maintenance; audit approval column contracted (2026-09-26)

Migration `1263_chat_search_gin_fastupdate_off_drop_audit_approval` is
non-transactional and does two things.

It first drops `computer_use_command_audit_events.approval_outcome` under a 1 s
`lock_timeout` and 10 s `statement_timeout`, since `DROP COLUMN` needs a brief
ACCESS EXCLUSIVE lock. #36984 stopped naming that column in audit INSERT and
SELECT, and its API reached production on 2026-09-26T02:28Z (release
`d9daec96`). **API rollback floor: `cdeec36c168636b1a2e510e660eb6139c9c4e07a`**
(#36984's merge commit). Earlier API artifacts name the column in every audit
INSERT and would fail with `42703`; rollback does not restore the column.
`.github/scripts/resolve-production-rollback-target.sh` enforces the floor. The
migration-consistency adapter that restored this column in the generated
schema is removed.

It then runs
`ALTER INDEX chat_event_search_messages_user_tsv_gin_idx SET (fastupdate = false)`
and `gin_clean_pending_list` on that index, with `lock_timeout` raised to 10
minutes and `statement_timeout` disabled, then resets both. `SET` takes SHARE
UPDATE EXCLUSIVE and the flush works page by page, so neither blocks chat
search reads or projector writes.

The search projector no longer drains the pending list: it has no GIN
maintenance budget, advisory lock or `pgstatginindex` call, and never defers
candidates. `deferredThreads` is removed from the
`/api/cron/project-chat-event-search` response, whose only caller is the Vercel
cron, and the test-only projection route no longer accepts `gin_index_names`.

A production-branch benchmark on 2026-09-26 (5,000 sampled real messages per
run, one INSERT per transaction, warm cache) measured 21.2 s and 25.5 s total
with fastupdate off against 14.6 s plus a 0.2 s flush with it on. p50 rose from
0.11 ms to 0.55 ms and p99 from 46 ms to 67-79 ms. The largest single insert
stayed about 0.5-0.6 s in both modes.

New API/old DB is compatible: until the migration runs, PostgreSQL still
flushes a full 4 MiB pending list in the foreground. Old API/new DB is
compatible for the index: an older API finds zero pending pages and skips
cleanup. The audit column floor above bounds API rollback. The `pgstattuple`
extension stayed installed for rollback targets that still call
`pgstatginindex`; `1265` later drops it behind #36990's rollback floor.

## R2-only chat thread snapshot API rollback floor (2026-09-26)

The production API rollback resolver rejects targets before the #36945
main merge commit `3d93ff8d4b4a07a5888e3030e69b340f40da0ad4`. That API
returns an R2 URL for every existing snapshot row; no supported rollback target
returns non-empty inline snapshots.
The commit preceded release #36948 (`4ecb619b5c409396edd5815a1ce65941cb29cd74`),
whose production API promotion succeeded on 2026-09-25 at 23:13:47 UTC
([release run](https://github.com/okou-ai/okou/actions/runs/36198938622/job/108284233073)).

The floor and the JSONB column removal were deployed in release #36989
([production run](https://github.com/okou-ai/okou/actions/runs/36213251627),
API promotion succeeded 2026-09-26 03:02:37 UTC). The subsequent client cleanup
removes Web App and CLI non-empty inline readers, the capability header from
new client requests, and the non-empty inline contract. The empty response for
a scope without a snapshot row is permanent and stays supported.

The API CORS preflight allowlist no longer includes `X-Chat-Thread-Snapshot-R2`
(#36375). The header-free App shipped in `0.970.1`, and the enforced Web
client floor (`0.973.0`) excludes every header-sending bundle. A browser cannot
receive `426 Upgrade Required` if preflight rejects the request first, so this
removal followed the floor enforcement in production. It neither restores
inline snapshot responses nor changes the empty response.

## Chat thread snapshot JSONB column retired (2026-09-26)

Migration `1261_drop_chat_thread_snapshot_jsonb` drops only
`chat_thread_snapshots.chat_threads`. The API already reads the snapshot cursor
and scoped R2 `object_key`, not the old JSONB body; the archive in R2 and the
empty response for a scope without a snapshot row remain unchanged. A masked
production census on 2026-09-26 00:14 UTC visited all 5,549 snapshot scopes
in stable key order and observed no null `object_key` (paginated reads, not a
single-transaction snapshot). This does not establish that every R2 object
exists. The migration discards the old JSONB column and its contents, but
leaves all R2 objects and their pointers untouched.

Outgoing API artifacts still write an empty JSONB array on snapshot
publication (via raw SQL or Drizzle). The owner explicitly accepts a temporary
failure of that job while
migrations run before the replacement API is promoted. It may upload an
unreferenced immutable R2 object before its publish statement fails with
`42703`; that invocation does not proceed to lifecycle-event pruning or R2
snapshot garbage collection. Existing snapshot pointers, their R2 downloads,
and the separate lifecycle-events API do not read the column. A new scope
without a published snapshot takes the existing empty-snapshot plus event-tail
path until the new compactor catches up. Verify the outgoing API is already an
R2-only reader and that no older JSONB reader is still serving at migration
time. The new API omits the column from both INSERT and UPDATE, so its
compaction works against either side of the migration.

Rollback does not restore the dropped column. The production rollback resolver
therefore finds the first-parent main commit adding this migration and rejects
all API targets before it, including the previous release whose compactor
would fail and earlier APIs that still read JSONB. Until the new release is
READY in production, no pre-migration API target is eligible; recovery requires
fixing forward. This is the accepted single-release compatibility trade-off.
The R2 JSON archive and its response contract are unchanged.

## Personal subscription credentials become account-only (2026-09-26)

Personal (`user_id <> '__org__'`) `claude-code-oauth-token` and
`codex-oauth-token` credentials now live only in `model_provider_accounts` and
`model_provider_account_secrets`. Organization subscriptions and API-key
providers keep `model_providers` + `secrets` unchanged.

Removed from the API:

- the `secrets` mirror of the active account and the personal singleton fields
  on `model_providers` (`token_expires_at`, `needs_reconnect`,
  `last_refresh_error_code`, `secret_id`, `auth_method`, workspace/plan and
  reset metadata are neither written nor read for personal rows; the columns
  remain for organization providers);
- lazy account seeding from legacy secrets, legacy bundle import, mirror/KMS
  equivalence checks and the request-scoped coordination that existed only for
  API 1.595.0 singleton writers (`docs/personal-subscription-run-identity.md`
  formerly §A2), plus the sourceId-less personal reader;
- every credential advisory and row lock on reads, run admission, connect,
  reconnect, activation, disconnect and terminal cleanup. Token refresh keeps
  the `model_provider_state` advisory lock.

Migration `1260_personal_subscription_account_only` sets
`model_providers.secret_id = NULL` for personal Claude/Codex providers, deletes
their mirrored `secrets` rows (Claude token; Codex `CHATGPT_*`/`CODEX_AUTH_JSON`)
and adds the unique index
`idx_model_provider_accounts_provider_identity (model_provider_id, external_account_id)`
(NULLs distinct). Connections merge by that identity with `INSERT ... ON
CONFLICT`; concurrent conflicting account writes surface as `409`.

Prerequisites: every personal Claude/Codex provider must own an account row
before the migration (seeded 2026-09-26: 21 providers, 12 Claude + 9 Codex;
the Codex seeds have NULL `external_account_id` until reconnect), and no
duplicate non-NULL `(model_provider_id, external_account_id)` pair may exist.

Overlap and rollback:

- During the ~20s migration-to-promotion window (API overlap measured at
  api-v1.673.0) the previous API still reads the mirror for some paths and may
  report a personal subscription as unavailable or require reconnect. This is
  accepted; no persisted data is lost because accounts are canonical.
- This release is the API rollback floor for personal subscriptions. An older
  API treats the missing mirror as an unavailable subscription and its legacy
  import/seed paths could recreate or diverge from account state. The production
  rollback resolver rejects API targets that predate the merge commit adding
  `1260_personal_subscription_account_only.sql`; roll forward instead.

## Computer Use audit column: code-only read/write cutover (2026-09-26)

The production database still has
`computer_use_command_audit_events.approval_outcome`. #36960 already changed
the audit-list SELECT to project only response fields, but its Drizzle schema
still declares the retired column. Drizzle therefore names it in audit INSERTs
with `DEFAULT`, even though no writer supplies an approval outcome.

This code-only release removes the Drizzle declaration without a migration.
The new API's generated INSERT and SELECT no longer name the column; both work
while the physical column still exists. Existing write-command and plugin
audit route tests exercise the current endpoints against that retained schema.
Older serving APIs can still insert because the column remains. Do not drop it
until this version has been independently promoted to production, the old API
instances have drained, and the production rollback floor excludes those old
writers. The follow-up #36969 must remove the narrow migration-consistency
test adapter for this retained nullable text column when it drops the physical
column, and must raise the rollback floor to this cutover's canonical main
merge commit. No screenshot decoder or index changes belong to this step.
The contraction, adapter removal and rollback floor shipped with migration
`1263_chat_search_gin_fastupdate_off_drop_audit_approval` (see the entry above).

## Chat run admission moves to the `active_agent_runs` thread slot (pending)

**Release ordering:** #36900 shipped separately in release #36948. #36955
merged into main with migration `1258_active_agent_runs_step2.sql` and shipped
separately in release #36974. #36980's step-3 migration
`1259_drop_agent_runs_last_heartbeat_at.sql` must ship alone in its own release
(#36986), with the previous API drained. #36975's
`1261_drop_chat_thread_snapshot_jsonb.sql` must also ship independently and
its previous API must drain before #36929 enters the merge queue. Only then
may #36929 ship with migration `1262_active_agent_runs_chat_thread_slot.sql`,
after #36976's `1260_personal_subscription_account_only.sql` and #36975's
`1261` in the migration journal. The slot rollout requires the deployed
step-3 API as its predecessor; the effective rollback floor also inherits the
stricter #36976 account-only and #36975 snapshot-drop floors.

#36955 owns the backfill for queued, pending, running and started terminal runs
still within the recovery grace or heartbeating. #36929 does **not** repeat
that backfill. Its migration keeps only the newest active row slotted per
thread and adds the plain unique index on `active_agent_runs.chat_thread_id`.
NULL thread IDs remain distinct. The new API's last launch statement inserts
the active row with `ON CONFLICT (chat_thread_id) DO NOTHING`; a collision rolls
back that launch as a lost queue claim and keeps the message queued. Queue-first
admission, Web preflight and queue drain read the slot. Admission, completion,
timeout and queued-run markers no longer lock the thread row; the session
binding uses compare-and-set.

**Mixed-version risk:** the step-3 API still inserts active rows without a
thread-slot conflict handler. If its launch races a new API launch or a still-
finishing terminal run, the unique index can reject its insert (`23505`): its
launch rolls back and inline send returns a temporary HTTP 500. The separately
enqueued input remains durable and can drain after slot release; no second run
starts. This is a user-visible error, not seamless compatibility. The release
owner must explicitly accept it and monitor errors and queue progress, or
first provide an older-API conflict handler / avoid serving the older API
after the index is created. Separating releases alone does not remove the
rolling mixed-version window.

## Chat thread hot-path cleanup and draft contraction, release 3 (2026-09-25)

**Draft columns and owner key.** Migration `1257_drop_chat_thread_draft_columns` drops `chat_threads.draft_user_message`, `draft_attachments` and `chat_threads_draft_user_message_check`, and makes `(chat_thread_id, user_id)` the `chat_thread_drafts` primary key.

`PATCH /api/chat-threads/:id` no longer reads the thread. It upserts or deletes the caller's own row and always returns `204`; the contract no longer declares `404`. A write to a missing or foreign thread lands in a row keyed to the caller that nobody else reads.

**Rollback floor: `7a187fa0a3fe2f23a134c7cdff66ee9c7e2bdb38`** (#36932). Older APIs name the dropped columns in thread inserts or upsert `ON CONFLICT (chat_thread_id)`. The resolver enforces this floor. #36932 entered production in release #36941 before this contraction. The account-erasure retirement below also independently prohibits rolling back to pre-#36927 APIs.

**Read cursor.** mark-read, mark-unread and mark-agent-read run without a transaction or account-erasure admission:

- mark-read reads the thread and Agent by primary key, reads the newest terminal marker, then advances the cursor with one single-row compare-and-set;
- mark-unread is one single-row `UPDATE`;
- mark-agent-read takes the same bounded candidates as the unread indicators (last message within seven days and newer than the cursor, newest 128) and advances each with its own compare-and-set. Older unread threads under the Agent are not bulk-marked read.

Responses are unchanged.

**Indexes.** Migration `1256_drop_redundant_chat_thread_indexes` (non-transactional) drops `idx_chat_threads_user_agent_updated` and `idx_chat_threads_user_last_read` with `CONCURRENTLY`. The planner serves their prefixes from `idx_chat_threads_user_agent_last_message` and `idx_chat_threads_user_last_message_id`. Read-cursor-only updates become HOT-eligible. No API names these indexes.

**Snapshot compaction.** The cron no longer unions every thread, event and snapshot scope:

- it pages `chat_thread_event_sequences` by primary key and reads snapshot heads by user;
- it builds each projection from the org's Agent ids and the user's threads, with no join;
- it skips the R2 upload when the projection's content hash is unchanged;
- it publishes with one single-row compare-and-set;
- it prunes compacted events with bounded reads and one `DELETE` by id.

Agent deletion reads the affected thread ids and owners in bounded keyset pages before the deletion transaction. After commit it appends `deleted` lifecycle events in small batches using the single-statement sequence allocator, with the captured org id (the Agent is already gone). Batch failures are logged, not retried, and never roll back deletion; as with `sort_touched`, an occasional missing event is accepted. Event-page reads keep `deleted` tombstones visible after the Agent is gone while continuing to filter other events by live Agent. With these events driving snapshot invalidation, the 24-hour full refresh and repeated empty-scope publication are removed. A scope with no visible event and no snapshot remains empty. The projection's timestamp strings keep the exact `jsonb_build_object` format.

## Public brand retirement contraction (2026-09-25)

Phase 2 of #36766 contracts the columns that Phase 1 stopped reading. Migration
`1255_retire_public_brand` drops `public_brand` from `slack_org_installations`,
`slack_chat_ingress`, `chat_slack_context`, `discord_chat_ingress`,
`chat_discord_context`, `feishu_org_installations`, `feishu_org_connections`,
`feishu_chat_ingress`, `chat_feishu_context`, `teams_org_installations`,
`chat_teams_context`, `telegram_installations`, `telegram_official_user_links`,
`chat_telegram_context`, `github_installations` (with `setup_public_brand`),
`chat_github_context`, `chat_automation_context`, `push_subscriptions`,
`email_outbox`, `export_jobs`, `usage_pack_invitation_purchases`,
`browser_sessions` and `socialkit_download_jobs`, and removes their Drizzle
declarations.

The per-row link layout marker is renamed, not dropped: `public_brand` becomes
`link_layout_segment` on `hosted_sites`, `hosted_deployments`,
`private_hosted_deployments`, `artifact_shares` and `shared_threads`, with the
same `okou` / `vm0` values, `NOT NULL` and `DEFAULT 'okou'`. The unique key
`idx_hosted_sites_id_public_brand` and the foreign keys
`fk_hosted_deployments_site_public_brand` and
`fk_private_hosted_deployments_site_public_brand` are renamed to their
`link_layout_segment` spellings with `RENAME CONSTRAINT`, so no index is rebuilt
and no foreign key is revalidated. Every statement is a catalog-only change
under the default 1s lock timeout; no table is rewritten or scanned. No
function, trigger or view references the retired columns.

Gate evidence: the seven Phase 1 slices (#36768, #36770–#36774, #36777) are all
in API release `api-v1.676.0`, and `api/production` serves release #36892
(`api-v1.677.1`, `2be63cd`) since 2026-09-25 11:25 UTC; every earlier
production API that remains deployable contains Phase 1.

Phase 1 APIs no longer read these columns, but they still declare them.
Drizzle names every declared column in `insert` column lists and in bare
`select()`, so those APIs still reach `public_brand` on every table above,
including the five layout tables. As with `1228`, `test:migration-consistency`
requires the declaration and the physical schema to agree, so the declaration
changes and the migration ship in one release. Migrations run before API
promotion. In the window before the previous API drains, its Slack, Discord,
Feishu, Teams, Telegram, GitHub and automation ingress/context statements,
push, email, export, usage-pack invitation, browser-session and SocialKit
statements, and its hosted-site, artifact-share and shared-thread statements
receive `42703`. Release this change alone at low traffic; the promotion window
after migration completion is about 20 seconds.

This release also stops writing the rollout-only `publicBrand: "okou"` in chat,
Slack, Discord, Feishu, Teams, Telegram, GitHub and workflow-automation
result-email callback payloads and in built-in generation requests, and removes
the run-level and queued-launch brand. The Phase 1 readers of those payloads do
not declare or read the field, and stored payloads that still carry it keep
parsing because the current readers strip unknown keys.

The `agentphone:chat` payload was the rolling-deploy exception. The Phase 1
reader (`agentPhoneChatCallbackPayloadSchema`) required `publicBrand`, so Phase 2
kept writing the literal `"okou"` while Phase 1 instances might still serve or
be selected as rollback targets. The Phase 2 reader no longer declares the field.

Follow-up #36913 stops writing that literal. Phase 2's migration and API shipped
to `api/production` in release #36970 (`191d95c`): the production migration
completed at 2026-09-26 00:50 UTC and API deployment succeeded. The most recent
pre-Phase-2 API (`4ecb619`) was marked inactive at 00:50 UTC and no longer has a
Vercel production alias; at the 02:29 UTC check, production API aliases pointed
to the later Phase-2-descendant `355e1ac`. The production rollback workflow
checks out `main`, where its target resolver rejects any commit predating the
canonical `1255_retire_public_brand` migration merge; the resolver test passes.
Stored callbacks with the old extra field still parse because the current reader
strips unknown keys.

Stored R2 records keep their historical names: the `publicBrand` field of
policies, delivery records, preview grants, pointers and manifests, the
`public-brand` object metadata, the `publicBrand` key of
`run_uploaded_files.metadata`, and the `<segment>` path components. Legacy
links keep resolving: the host Worker reads only R2 and is unaffected by the
column rename, and the API reads the unchanged `okou` / `vm0` values from
`link_layout_segment` to lay out records derived from existing content. OAuth
and install states are unaffected; Phase 1 already removed the brand from them.

Rollback promotes artifacts without restoring schema. The production rollback
resolver therefore rejects API targets that predate the canonical main commit
that added `1255_retire_public_brand.sql`. Recovering past that commit requires
a forward-fix migration that restores the columns and the old layout column
name, not an artifact rollback.

## Stripe payment-method Portal brand metadata retirement (2026-09-26)

The restricted payment-method Billing Portal configuration is stored in Stripe,
not in Postgres. The existing live Stripe account has one matching active
configuration with `metadata.purpose=payment_method_management`, an old
`metadata.managed_by=vm0` key and a legacy display name. The API now selects
it by `purpose` alone; it does not select by brand or name. A fresh configuration
writes only the purpose and uses a new brand-neutral idempotency key. An
incomplete list or multiple matching configurations fail closed instead of
choosing a different Portal configuration. Existing features, disabled login
page and configuration ID are
preserved. No database migration is needed.

This code release does **not** remove Stripe's existing `managed_by` key:
Stripe metadata updates merge omitted keys, and the old API still requires that
key to find the same configuration. Wait until the purpose-only API is serving,
all older API instances have drained, and the production rollback resolver
excludes every pre-cutover API (using the first-parent main commit that adds
`.github/rollback-floors/stripe-portal-purpose-only`). Only then update that
same Stripe configuration in place: remove `metadata.managed_by`, rename its
legacy display name to `Okou payment methods`, and leave
`metadata.purpose=payment_method_management`, active status, and the restricted
feature set unchanged. Read back the Stripe configuration and open a Portal
session to verify that the same configuration ID remains in use and no second
configuration was created. An older API restored outside the protected rollback
path cannot be used after that provider update without a forward fix.

## Account erasure retirement (2026-09-25)

The whole account-erasure mechanism from EPIC #33745 is removed. It will be
redesigned from scratch; until then account deletion runs the legacy Clerk
cleanup, narrowed so that user deletion never deletes an Agent.

- **Writer and reader fence.** API writes and reads no longer check whether
  their user or organization was closed for erasure, take the shared subject
  advisory lock, or set a custom `lock_timeout`/`statement_timeout` for it.
  Nothing returns `subject_closed`, `account_closed`, "Account unavailable" or a
  closure-only 404. The Computer Use host stop and command completion contracts
  drop their `403` response; the Desktop client only handles `401`/`409` there.
  `VNC_OWNER_CHANGED` leaves the VNC error contract and the App.
- **Deletion hold (#36842).** The `clerk-user-deletion` job no longer yields for
  24 hours before cleanup. Auth, firewall credential handoff, runner
  cancellation state and X resource usage no longer look up a pending deletion
  job; Clerk stops issuing tokens for a deleted user.
- **Deletion job.** The Clerk `user.deleted` webhook still revokes shared-thread
  artifacts, records one durable `clerk-user-deletion` job (#36236) and starts
  it; the per-minute background-job cron reclaims unfinished work. The job now
  runs only the legacy cleanup (`cleanupClerkDeletedUser$`, including the
  empty-organization branch) and completes. There is no capture or verify
  phase. Jobs queued by an older API with a `phase` or `safetyHold` checkpoint
  simply run the idempotent cleanup. `organization.deleted` is unchanged: billing
  cleanup in the webhook, then `cleanupClerkDeletedOrg$`.
- **Agents are retained on user deletion.** User cleanup deletes no Agent and
  never cascades through one. It removes only the user's own data by `user_id`:
  their runs (cancelled first), sessions, chat threads and drafts, usage, stable
  context, credentials, connectors, storages and the other per-user rows.
  Agents the user owned keep `owner` pointing at the deleted user (no ownership
  transfer), together with their instructions Storage, Workflows, Morning Brief
  deliveries, other members' stable context, and other members' sessions,
  threads and runs.
  Other members' runs on those Agents are no longer cancelled. Organization
  deletion is unchanged and still deletes every Agent in the organization.
- **Executor and collectors.** The user executor, selector, ownership coverage
  guard, relational sweep, every object/remote collector, shared blob erasure,
  chat content deletion receipts and their late-content sweep, the dormant Clerk
  bridge and the separate decision journal are deleted. Blob retention uses the
  plain reference count again and upload intents are gone.
- **X resource retention.** Clerk cleanup, telemetry ingestion and the
  retention cron no longer take a global `x_resource_reads` advisory lock.
  Ingestion still validates the UTC today/yesterday window, serializes claims
  by the resource primary key, and holds the Run's SHARE lock while writing
  usage. Cron reads at most 1,000 expired keys, then deletes only those keys
  with a repeated day predicate in a separate statement. An insert committed
  just after its final time check at midnight can leave an expired key until
  the next retention tick; it cannot reopen the admission window. Database
  global timeouts replace the per-transaction X resource and 100 ms Clerk
  lifecycle overrides. An upload holding its Run lock may delay cleanup;
  the user deletion job retries a failed attempt, organization cleanup does not.

Rows written for a deleted account after its legacy cleanup committed are no
longer swept by anything. That is the accepted gap until the redesign.

Migration `1254_drop_account_erasure` follows the VNC migration `1253`, required
agent-run context ownership migration `1252`, and Computer Use migration `1251`.
It replaces the earlier, never-released
`1248_drop_pi_stable_context_erasure_fences`. It drops the `account_erasure_*`
tables (jobs, work, pages, sinks, selector dependencies, bridge ingress and
replay), `chat_content_erasure_subjects`, `pi_stable_context_erasure_fences`,
`blob_upload_intents`, and `blobs.erasure_pending`/`erasure_eligible_at` with
their check constraint, in the same release by explicit decision rather than
after a rollback window. An older API still serving during the overlap fails
every path that touches those relations: account-erasure fence admission on
almost every write, membership-cache refresh, Pi stable-context, connector,
permission and Workflow admission, session-history blob retention and Clerk
deletion. **Rolling the API back below this revision is unsupported.**

Older entries below that mention account erasure, erasure admission, the
relational sweep, collectors, the Clerk erasure bridge or deletion-status
capabilities describe the retired mechanism.

## Computer Use audit approval column: reader cutover (2026-09-25)

`computer_use_command_audit_events.approval_outcome` belongs to the retired
approval flow. No current writer sets it or response exposes it; a masked
production census on 2026-09-25 found 0 non-null values across 11,258 audit
rows. The audit-list API now selects only the fields it returns instead of the
full table row; other audit reads already select individual columns. The
physical Drizzle schema and database still declare `approval_outcome`, so this
release does **not** drop or migrate the column. The HTTP response is unchanged.

Drop the column in a follow-up release **after** this reader cutover has shipped
to production, outgoing API instances have drained, and the enforced production
API rollback floor is at or above this reader-cutover commit. Otherwise an
older API's unqualified Drizzle `SELECT` would name the dropped column and fail
with `42703` between database migration and API promotion (or after rollback).
Reconfirm zero non-null rows before the DROP, remove the physical schema
mapping in that same follow-up, and validate the old/new API/DB combinations.
The column drop is not authorized by this preparatory release alone.

## Discord file deliveries become fire and forget (2026-09-25)

`POST /api/integrations/discord/files/complete` sends each upload operation to
Discord at most once, without a nonce. A send that Discord rejects,
rate-limits or never answers is recorded as a failed delivery with
`retryable: false` and no `retryAfterSeconds`; a repeated completion returns the
recorded outcome and never sends again. To retry, start a new upload operation.
The enforced-nonce replay, its window and the stored retry deadline are
removed, and new delivery rows no longer store a nonce.

The delivery response no longer declares the unused optional
`retryAfterSeconds` field, and the CLI no longer suggests retrying a failed or
pending delivery. `pending` remains a valid response during concurrent
completion; a repeated completion reports the recorded state without resending.
Discord has no production users, so rows written by the previous replay flow
need no migration; their extra JSONB keys are ignored.

## Agent-run context ownership becomes required (2026-09-25)

Migration `1252_chat_agent_run_context_owner_not_null` deletes
`chat_agent_run_context` rows whose `source_user_id` or `source_org_id` is null,
then makes both columns `NOT NULL`. Every API from the split writer on (API
1.672.0) inserts a row only after reading both owners from the source thread and
agent, so no rollback target writes a null owner. The deleted rows were written
by older APIs; on 2026-09-25 all 955 had lost their source thread, so no owner
could be derived. No code reads these rows, and the `chat_events.context_id`
values that referenced 70 of them carry no foreign key.

The Clerk legacy cleanup deletes these rows by copied ownership. The account-
erasure collector and its captured replay are retired by this PR; older API
instances cannot safely run against the dropped relations, and API rollback
below this revision is unsupported as noted above.

## Computer Use erasure admission and legacy host retirement (2026-09-25)

Host START, command creation, the host directory and the audit-event list no
longer take account-erasure admission or open transactions; START is one
upsert and creation is a bounded host read plus one INSERT. A closed erasure
subject is no longer refused with `403` by these routes; late writes
are not swept until the deletion mechanism is redesigned.

`POST /api/computer-use/hosts/start` now requires `installationId`. Hosts
registered without one (the last was seen in August 2026) are no longer
accepted, and stop always keeps the host as an offline installation instead of
revoking it and clearing chat-thread bindings. Every current Desktop build
sends `installationId`.

Migration `1251_computer_use_commands_required_host_timeout` deletes commands
left by the retired approval flow (and their audit rows), revokes any active
host without an installation, and makes `computer_use_commands.host_id` and
`timeout_ms` `NOT NULL`. Older APIs always write both columns for new commands,
so they remain compatible after the migration.

## Computer Use host sessions and command reads stop locking (2026-09-25)

Computer Use heartbeat, command claim, command completion, host stop, command
status reads and screenshot/plugin-content reads no longer open multi-statement
transactions, take account-erasure admission locks or lock host/command rows.
Each reads with plain bounded queries and writes with single-row conditional
UPDATEs; a request that loses a race skips its write (heartbeat), reports
`idle` (claim), or reports the command as already completed (completion).
Heartbeats and claim polls only rewrite the host row when its reported state
changed or `last_seen_at` is at least 30s old, and Desktop sends steady-state
heartbeats every 15s instead of 2s.

Observable differences:

- A closed erasure subject is no longer refused with `403` by these routes; late
  writes are not swept until the deletion mechanism is redesigned.
- Claim is no longer serialized with stop. A claim that read the host just
  before a concurrent stop can still start one command, which then fails
  through the normal running-command timeout.
- A command status read times out only the command being read. Other running
  commands time out when they are read or when their host polls again.
- Migration `1241_computer_use_host_liveness_indexes` (#36895) drops
  `idx_computer_use_hosts_last_seen` and adds the partial unique index
  `idx_computer_use_commands_running_host (host_id) WHERE status = 'running'`,
  which now enforces one running command per host. Older APIs serialized claims
  per host and never create a second running row, so they remain compatible.
  While old and new APIs overlap, an old claim racing a new one for the same
  host can hit the index and return one `500`; the Desktop recovers on its next
  poll.

## Active run state moves to `active_agent_runs` (2026-09-25, step 1 of 3)

Heartbeats rewrote the wide `agent_runs` row and two heartbeat indexes that no
query used, and activity snapshots were written through the run-content lock
chain. Migration `1249` builds `idx_agent_runs_status` concurrently and drops
`idx_agent_runs_status_heartbeat` and `idx_agent_runs_running_heartbeat`; no
API names either index. Migration `1250` adds `active_agent_runs`, one narrow
row per active run with an immutable `chat_thread_id` (no foreign key, null for
threadless runs), and seeds it from queued, pending and running runs.

A row lives while a runner may still work on the run. The new API inserts it as
the launch transaction's last statement and refreshes its heartbeat on
promotion, claim and every sandbox heartbeat. A run that never reached `running`
loses the row when it turns terminal; a run that did, including one cancelled
while running, keeps it until the completion webhook, the running-heartbeat
timeout, or a cleanup sweep that releases rows of runs terminal and silent for
the 120-second cancellation-recovery grace. Every release is the last
statement of its transaction, after the provider-account cleanup. The follow-up
per-thread admission index relies on this ordering. It still writes `agent_runs.last_heartbeat_at`, and timeout cleanup and capacity
checks still read that column. Activity capture and the activity summary read
and write only the active row with single-row compare-and-set updates; they no
longer touch `run_activity_snapshots`, `chat_threads` or `chat_events`, and no
longer pass the account-erasure write fence.

During rollout, and on any rollback to an older API, the older API keeps writing
`run_activity_snapshots`, creates runs without an active row (the new API shows
no activity for them), and ends seeded runs without deleting their active row.
New API instances no longer expire `run_activity_snapshots` rows; they stay
until step 2 drops the table and remain erasable through the `agent_runs`
cascade. An older API's account-erasure worker rejects the uncatalogued
`active_agent_runs` table (`catalogue_uncovered`), so account deletions wait for
a new worker during the migration-to-promotion window and on rollback. A row an
older API abandons is either still live, or terminal and released by the
stale-terminal sweep once its heartbeat and completion age past the grace; no
reader treats it as more than activity for a run the summary already reports as
ineligible, so none of these states needs a runtime fallback.

## Active run state: readers and old storage retired (step 2 of 3)

**Release gate:** #36900 / `c0a46af5` reached production in release #36948
(run 36198938622); step 2 may enter the merge queue. Migration `1258` backfills
missing active rows created by pre-#36900 API instances; it includes started
terminal runs still within the 120-second recovery window or still heartbeating
(except cancelled runs with completed recovery). It removes terminal rows only
when _both_ completion and heartbeat are more than 120 seconds old, matching
the existing stale-terminal sweep. The insert is idempotent on `run_id`.
#36929 must rebase after this migration and remove its duplicate backfill;
its own migration owns the unique `chat_thread_id` index and slot admission.

Timeout cleanup now checks the active row's heartbeat (including its locked-run
recheck); capacity excludes queued runs and expired pending runs but counts
started terminal runs while their active row still exists. Launch, promotion,
claim and sandbox heartbeats no longer write `agent_runs.last_heartbeat_at`.
Activity and summary already use `active_agent_runs`; migration `1258` drops
`run_activity_snapshots` and its ORM declaration. Once this release deploys,
**do not roll back to #36900**: its timeout cleanup reads the now-stale
`agent_runs.last_heartbeat_at`, and older APIs write the dropped snapshot
table. Step 3 drops the old heartbeat column. Do not ship step 3 in this PR.

## Active run state: `agent_runs.last_heartbeat_at` dropped (step 3 of 3)

**Release gate:** step 2 (#36955, `e62567d3`) shipped alone in `api-v1.681.2`
(release #36974). Promote the release carrying this change only after
`api-v1.681.2` is live in production and the previous API has drained. Step 2
is the first API that neither reads nor writes `agent_runs.last_heartbeat_at`;
timeout cleanup, capacity and every heartbeat use `active_agent_runs`.

Migration `1259` drops the column and this release removes its Drizzle
declaration. `test:migration-consistency` requires both to ship together (as in
`1228` and `1257`). Step 2 still declares the column, so Drizzle names it in
every `agent_runs` insert, bare select and bare returning. Migrations run
before API promotion; until the previous API drains, those statements on the
old instances fail with `42703`, including run creation. Release this change
alone at low traffic. The drop is metadata-only; the two heartbeat indexes on
the column were already removed by `1249`.

Rollback promotes artifacts without restoring schema, so the production
rollback resolver rejects API targets that predate the canonical main commit
that added `1259_drop_agent_runs_last_heartbeat_at.sql`. Recovery past it needs
a forward-fix migration that restores the nullable column.

## Chat thread archived rollout fallbacks removed (2026-09-25)

Issue #36551 removes the bounded rollout fallbacks added with #36480. The
`archived` field is now required in `chatThreadSnapshotProjectionSchema` and
`chatThreadMetadataSchema`, and the `?? false` normalizations in chat thread
event replay and the Platform metadata projection are gone.

Evidence for each gate:

- Web clients: the force-upgrade floor at this retirement was `0.963.3`;
  #36480 first shipped in App `0.955.0`.
- API rollback: the production rollback floor is `32e48c76` (#36885), which
  contains #36480, so no API from before archiving is serving or retained as a
  rollback target.
- Snapshots: a MaskDB census found all 5536 `chat_thread_snapshots` rows were
  updated after the first production API containing #36480 was deployed
  (2026-09-24T06:12Z; oldest row updated 2026-09-24T13:00Z).

IndexedDB caches are intentionally **not** reset (`CHAT_IDB_VERSION` is
unchanged). A Web snapshot cache row last written by a pre-0.955.0 build now
fails schema parsing and takes the existing degraded read path, which refetches
from the API. The CLI chat thread cache likewise treats such a row as invalid
and rebuilds it. No database migration is included.

## R2 chat thread snapshot rollout fallbacks removed (2026-09-25)

Issue #36375 removes the rollout fallbacks that #36320 added. Evidence for the
removal gates:

- The Web App client floor at this retirement was `0.963.3`. #36320 first
  shipped in App `0.950.0`.
- The owner confirmed that no CLI builds from before R2 support remain in use.
- A MaskDB census found 5536 `chat_thread_snapshots` rows, none with
  `object_key IS NULL`. Compaction writes only rows that have an object key.
- The production API rollback floor is 32e48c76 (#36885), which descends from
  #36320.

The API no longer reads the legacy `chat_threads` JSONB. A row without an
object key is now an error. A scope without a snapshot row returns the
permanent empty `{ chatThreads: [], latestEventId: null, latestSeqId: null }`
shape. The App SharedWorker and CLI keep handling the inline contract variant for
the API rollback window. They send the header, so current and rollback-window
APIs return them an R2 URL whenever a row exists.

At the time of #36942, one fallback remained: the native iOS TestFlight
client (0.2.x) read only inline `chatThreads`, so the API materialized the R2
archive for requests without the capability header. That branch was retired
later on 2026-09-25 with explicit acceptance of breaking the old TestFlight
builds; see "iOS inline chat thread snapshot response retired" below.

## iOS inline chat thread snapshot response retired (2026-09-25)

The owner approved removing the remaining header-less inline response for
#36375 despite breaking old internal iOS TestFlight builds. For a scope with a
compacted snapshot, `GET /api/chat-threads/snapshot` now returns a scoped,
short-lived R2 URL whether or not `X-Chat-Thread-Snapshot-R2: 1` is present.
The API no longer downloads and decompresses the R2 archive on behalf of a
header-less client. A scope without a snapshot row still returns
`{ chatThreads: [], latestEventId: null, latestSeqId: null }`.

Pre-fix iOS TestFlight builds decode only inline `chatThreads`, so they cannot
load a non-empty compacted chat thread list from this API. The updated native
client downloads and decodes the R2 archive. It also accepts inline responses
from a scope without a snapshot row or a rollback-window API. Installed pre-fix
builds remain incompatible until users install a TestFlight build containing
the native client fix. There is no iOS minimum-version gate. This preserves
the explicitly accepted break rather
than reintroducing API-side R2 download and decompression for header-less
requests. Web App and CLI still send the capability header and accept inline
responses for the existing API rollback window: an older API behind the
current rollback floor still branches on that header. Keep the header in CORS
and the shared inline response variant until the API rollback floor advances
past that implementation.

## Thread draft contraction, release 2 (2026-09-25)

Release 2 of the thread-draft move off `chat_threads` (#36173). Release 1
(#36897, merge commit `4558c9fa`) made `chat_thread_drafts` the only draft
store and writes `user_id` on every row.

Migration `1248_contract_chat_thread_drafts` fills any missing `user_id` from
the thread. It then deletes cleared tombstones (both draft values null) and rows
whose thread no longer exists, makes `user_id` and `draft_user_message`
`NOT NULL`, drops `chat_thread_drafts_draft_user_message_check`, and adds the
unique index `uq_chat_thread_drafts_thread_user`. Release 1 always writes an
owner and deletes on clear, so it stays compatible with the contracted table
during rollout; its `ON CONFLICT (chat_thread_id)` upsert still matches the
unchanged primary key.

The API drops the two compatibility paths Release 1 declared. The drafts listing
no longer filters null tombstones, and account erasure no longer reaches draft
rows through the thread, because every row now has an owner. Draft upserts
target `(chat_thread_id, user_id)`. `GET /api/chat-threads/:id/draft` no longer
declares `404` (Release 1 already never returns it), and the App stops accepting
it. The runtime `chat_threads` mapping no longer declares `draft_user_message`
or `draft_attachments`, so no API from this release names them in an implicit
`INSERT`, `SELECT` or `RETURNING`. The DDL schema still declares them.

**API rollback floor: `4558c9fac46ce1a96a25745b477b32b70dab7ae6`** (#36897). An
older API dual-writes a draft row without `user_id` and fails every draft save
against this schema. The production rollback resolver enforces the floor.

Release 3 is allowed only after this API is in production and becomes the
rollback floor. It drops the two `chat_threads` draft columns and their check
constraint, which Release 1 would still name in thread inserts. It also makes
`(chat_thread_id, user_id)` the primary key and lets the draft `PATCH` skip the
owner read, so a missing or foreign thread returns `204` instead of `404`.

## Chat event retention and Discord delivery table retirement (2026-09-25)

Discord has no production users, so this change ships without a staged
compatibility window.

- Migration `1246_drop_discord_chat_deliveries` drops `discord_chat_deliveries`
  with its foreign keys into `chat_events`, then the
  `chat_events_id_thread_unique` constraint that only backed the composite
  foreign key, and the redundant `idx_chat_events_run_id` (covered by
  `chat_events_run_event_seq_unique`). An API that predates #36879 fails its
  Discord reply enqueue, and a user export on an older API fails its Discord
  deliveries page until the rollout completes. Account erasure on an older API
  also fails with `account_erasure_relational:catalogue_absent:discord_chat_deliveries`
  and retries until it runs on this API; rolling back below this API stalls
  erasure jobs the same way.
- Migration `1247_chat_event_retention_cursors` adds the retention sweep
  cursor. Retention now reads candidates with bounded, unlocked single-table
  queries and deletes them by ID in short statements, without the advisory
  lock, `FOR UPDATE SKIP LOCKED` or the in-transaction remainder scan. The cron
  response drops `deleteLimit`, `candidates`, `skippedBatchLimit` and
  `overlapPrevented` and adds `sweepRestarted`. An older API still running the
  locked sweep is safe alongside the new one: both only delete rows that pass
  the same holds.
- The cancellation-recovery queue sweep only redrives barriers that expired in
  the last ten minutes. Older barriers are left to per-thread admission and
  callback paths, as for stale queue items.

## Chat event write control retirement (2026-09-25)

Migration `1245_drop_chat_event_write_control` drops `chat_event_write_control`
together with its `preserve_chat_event_write_activation` trigger and function.
APIs 1.674.0 and 1.675.0 read the control row on every chat event write, so the
production rollback resolver now refuses targets before #36703 (`15117da781`,
API 1.676.0), the release that removed that reader. The owner approved the new
floor on 2026-09-25 while production served API 1.676.1. Migration precedes API
promotion, and no API from 1.676.0 on reads or writes the table.

APIs before this change still list the table in their account-erasure ownership
inventory. While one of them serves after the migration (the release overlap or
a rollback), its Clerk deletion jobs fail with
`account_erasure_relational:catalogue_absent:chat_event_write_control` and retry
every 60 seconds without losing their checkpoint, until an API with this change
serves. The table was not account-scoped and had no foreign keys, so the
relational sweep plan and its collector version are unchanged.

## Thread drafts served only from `chat_thread_drafts` (2026-09-25)

Thread composer drafts are read and written only through `chat_thread_drafts`
(#36173). `PATCH /api/chat-threads/:id` reads the thread owner by primary key
outside any transaction, then saves the draft with one upsert, or clears it by
deleting the row. None of these paths writes or locks the `chat_threads` row, and draft writes no longer take
the account-erasure admission. `GET /api/chat-threads/:id/draft`, the drafts
listing and the user export read the child table. Request and response
contracts are unchanged.

`GET /api/chat-threads/:id/draft` reads only `chat_thread_drafts`, by thread id
and the caller's `user_id`. A thread the caller does not own, a missing thread
and a thread without a draft all return `200` with the empty draft instead of
`404`; every App bundle maps a `404` to "no draft" and parses the empty draft to
the same state, so the composer behaves identically. A draft row an older API
inserted without `user_id` during the rollout reads as empty until the user's
next save fills it. `PATCH` still reads the thread owner until the contract
release keys drafts by `(chat_thread_id, user_id)`.

Sending a message no longer touches the draft. The web client already clears
its draft with its own `PATCH` alongside every send (since #24657, so every App
bundle in use does), which made the server-side delete a duplicate write on
the send path. Senders that do not clear the composer, such as MCP, agents and
forwarded sends, now leave the user's draft in place. If the client's clearing
`PATCH` fails, the sent text reappears as the draft.

The web client now refetches the sidebar drafts listing only when a save adds
or removes a thread's draft, instead of after every debounced save.

Migration `1244_chat_thread_drafts_user_backfill` drops the
`chat_thread_drafts` → `chat_threads` foreign key, so a draft write takes no
lock on the thread row. It adds `chat_thread_drafts.user_id` with an index,
copies drafts that exist only in the legacy `chat_threads.draft_user_message` /
`draft_attachments` columns with `ON CONFLICT DO NOTHING`, and fills `user_id`
from the thread. Every API since #36230 dual-writes both stores in one
transaction, so an existing child row is already current. Production held 433
legacy drafts (126 kB), 430 of them without a child row and none disagreeing
with their child row (2026-09-25).

Without the cascade, `DELETE /api/chat-threads/:id` removes the draft row with
one statement after the thread deletion commits. Agent deletion, account
deletion and other thread-deletion paths can leave an unreachable draft row
behind; no API serves it, and cleaning it up belongs to deletion. Account
erasure reaches draft rows by `user_id` and, for rows without one, through the
thread while it exists.

During the rollout an older API still dual-writes both stores and serves the
legacy columns, so it keeps the child table current but does not see a draft
the new API saved or cleared. An older API can also insert a child row without
`user_id`; such a row is missing from the new drafts listing until the contract
migration backfills it, and it is still read and cleared by thread id. Rolling
the API back therefore only shows each thread's last draft from before this
release; no draft is lost.

The legacy columns and their check constraint stay in the schema, unused, for
this release. The contract release drops them, backfills any `user_id` left null
by the rollout and makes `user_id` `NOT NULL`; ship it only after this API is in
production and set this release as the API rollback floor.

## Morning Brief expired admission containment (2026-09-25)

This is a partial, fail-closed incident slice, **not** the recovery of stalled
Morning Brief schedules. With the global schedule-expiry switch off, API
instances at this revision no longer select `daily-delivery` anchors older than
30 minutes in the legacy due batch. A selected anchor that ages past that
boundary before queue admission is also refused; the generic, unjournaled
claim CAS applies the same cutoff to `daily-delivery` and checks that the row
is still enabled. The cutoff is strict: exactly 30 minutes late remains due.
The old anchors, historical claims, runs, queue events, native rows, enabled
choice, Official installation and sent messages are not changed. Other due
automations keep their existing expiry policy and are selected in stable
next-run order instead of sharing an unordered batch with stalled briefs.

This does not advance an old anchor to a future occurrence. The global expiry
flag must **not** be enabled as a substitute: an earlier mismatched Native
obligation still holds that path. The Native/Official decision fence and old
callback settlement remain in place; the mixed-version disable/enable and
reconciliation contract has not been proven under single-statement hot-path
constraints. An older API poller can still select or claim an expired brief
during rollout or after rollback. Therefore production release of this
containment requires a separately approved deployment plan that prevents old
pollers from admitting overdue briefs throughout the overlap and sets a
rollback floor at this revision or later; absent that plan, do not promote it
as a no-backfill guarantee. Already queued or running claims and email/Chat
outcomes require separate evidence and handling, not age-based settlement.
No database migration or client protocol change is included.

## Chat search agent recency index dropped (2026-09-25)

Migration `1242_drop_chat_search_agent_created_idx` drops
`chat_event_search_messages_user_org_agent_id_created_idx` with
`DROP INDEX CONCURRENTLY`. It does not block chat search reads or projector
writes; it waits for older transactions on the table, so it raises
`lock_timeout` to 10 minutes and disables `statement_timeout` for its own
session, then resets both.

Since #36456 no query orders this table by `(user_id, org_id, agent_id,
created_at)`. Chat search and MCP chat search take keyword candidates from
`chat_event_search_messages_user_tsv_gin_idx` and sort them in the query;
projection writes and thread deletion use the primary key; account erasure
deletes by `user_id`, which `chat_event_search_messages_user_org_created_idx`
serves.
Production statistics from 2026-09-17 to 2026-09-25 show 164 scans reading
about 157,000 index tuples each, consistent with agent-scoped searches that
walked an agent's whole history and filtered each row by keyword.

No code names the index, so old API/new DB and new API/old DB are both
compatible and no API rollback floor is needed. Restoring the index means
rebuilding it concurrently; no data is lost.

## Discord replies become fire and forget (2026-09-25)

Discord replies and ingress notices are now posted once, directly after the
transaction that creates their event commits, and only by the attempt that
created it. A part Discord rejects, rate-limits or never answers ends the send;
there is no retry, nonce replay, uncertain-part notice or cron redelivery. A
repeated runner callback or terminal-marker replay does not post again, and a
process lost between commit and send loses that reply. The canonical event
stays readable in the Okou chat. Access checks and suppression after binding
or channel revocation are unchanged.

The API no longer writes or reads `discord_chat_deliveries`, and the test-only
Discord delivery drain endpoint is removed. Migration
`1246_drop_discord_chat_deliveries` drops the table (see above).

## Completed Clerk deletion receipt index retirement (2026-09-25)

Migration `1240_retire_clerk_deletion_receipt_index` drops
`idx_background_jobs_completed_clerk_deletion`. Its only reader was the
late-content sweep's receipt reconciliation for older APIs
(`kind = 'clerk-user-deletion' AND status = 'completed' ORDER BY id`), which
#36862 removed. No current query filters on that predicate.

API rollback targets from 1.672.0 through 1.676.1 still run that reconciliation
every minute. Without the index it becomes a sequential scan of
`background_jobs`, which held 23 rows on 2026-09-25, so their results and
correctness are unchanged. The migration takes a brief `ACCESS EXCLUSIVE` lock
on that small table under the default 1s lock timeout.

## Keyword-only chat search GIN index dropped (2026-09-25)

Migration `1239_drop_chat_search_tsv_gin` drops
`chat_event_search_messages_tsv_idx` with `DROP INDEX CONCURRENTLY`. It does not
block chat search reads or projector writes; it waits for older transactions on
the table, so it raises `lock_timeout` to 10 minutes and disables
`statement_timeout` for its own session, then resets both.

Ship it only after the API that stops maintaining this index (previous entry,
#36885) is in production; that API was promoted in release #36887 (`f24f7192`).
Chat search and MCP chat search already use the `(user_id, tsv)` index; queries
and responses are unchanged. Restoring the index means rebuilding it
concurrently; no data is lost.

**API rollback floor: `32e48c76fea61c39d0962762e1bc2e0aa5a5cab0`** (#36885's
merge commit). An API artifact that predates it names
`chat_event_search_messages_tsv_idx` in chat search GIN maintenance; after this
migration its `::regclass` cast fails with `42P01` and every projection tick
fails before projecting a thread. Rolling the API back does not restore the
index. The production rollback resolver
(`.github/scripts/resolve-production-rollback-target.sh`) enforces the floor for
API targets; verify manually with
`gh api repos/okou-ai/okou/compare/32e48c76fea61c39d0962762e1bc2e0aa5a5cab0...<artifact-sha> --jq .status`
and require `ahead` or `identical`.

## Chat search stops maintaining the keyword-only GIN index (2026-09-25)

Chat search and MCP chat search both filter by `user_id` before the keyword
predicate, so the planner serves them from
`chat_event_search_messages_user_tsv_gin_idx` (`1214`). After that index
shipped, `SELECT chat_event_search_messages` on `/api/chat/search` fell from
p90 3.5 s to 348 ms (Axiom, 2026-09-24T14:44Z to 2026-09-25T08:00Z).

The search projector now drains only the `(user_id, tsv)` index from its
30-second GIN maintenance budget. The keyword-only
`chat_event_search_messages_tsv_idx` remains in the database for this release;
its pending list is flushed by PostgreSQL in the foreground when it reaches the
4 MiB `fastupdate` threshold, as for any unmaintained GIN index. No migration,
query, or response change.

Old API/new API remain compatible with the same database. This release must
reach production before the follow-up migration drops
`chat_event_search_messages_tsv_idx`: an API that still names the index in
maintenance fails its projection tick once the index is gone. Rollback to an
older API is safe until that migration ships.

## Runner active-producer affinity for delayed finalization (2026-09-25)

Every Runner heartbeat must include `activeReuseProducers`, even when empty.
The API rejects a heartbeat that omits it; it no longer treats omission as an
empty producer list. Each entry is a bounded exact `runId/reuseKey/profile`
capability for a locally publishable active run. The additive
`runner_state.active_reuse_producers` JSONB column retains its `[]` default for
existing rows; the heartbeat handler always writes the supplied list.

The API uses a producer capability only for the exact completed predecessor on
the same Runner process generation and a fresh running heartbeat. Registration
triggers an immediate but asynchronous producer heartbeat. A same-generation
predecessor that completes before that snapshot reaches the API can still receive
a completion-relative preference for at most 1.5s; this protects the current
Runner's first-heartbeat race, not an omitted-field protocol. Producer-qualified
claim priority instead expires at successor creation plus 2s and does not
inherit the 30s heartbeat freshness interval. Runner-local pre-claim proof,
running handoff, and global claim CAS remain unchanged. A stale or missed
producer revocation can delay an individual cold claim only within the bounded
successor-relative preference window; measure that tail cost alongside reuse.

## App floor 0.963.3 retires the mark-read `unreads` field (2026-09-25)

`POST /api/chat-threads/:id/mark-read` and
`POST /api/chat-threads/:id/mark-unread` no longer return `unreads`; both
response contracts now carry only `lastReadAt`. The field was the rollout
fallback kept by the unread-snapshot change below.

`app-v0.963.3` (release commit `f53bf151eef29e6e21711850d6237719ab4ffdcd`) is
the first App that contains #36877 and no longer reads the field. Production
App serves `0.965.0` at `a4794200e232f46f6f64eb8102067c6a367667d7`, a
descendant of that release. This change raises the identified-App minimum
version from `0.958.0` to `0.963.3`; older bundles receive `426` on their next
API request before any route is matched and refresh into the live App. Do not
roll the App back below `0.963.3` without also rolling the API back below this
change.

## Mark-read responses stop computing unread snapshots (2026-09-25)

`POST /api/chat-threads/:id/mark-read` and
`POST /api/chat-threads/:id/mark-unread` no longer compute the per-Agent unread
snapshot and always return `unreads: []`. That snapshot used a correlated
lateral query that dominated mark-read latency, and the App already derives
unread state from `/api/indicators`. The new App no longer reads the field.

Older App bundles still pass `unreads` to their optimistic read-mark pruning;
an empty list only skips pruning, and those bundles already hide a local mark
when indicators report a newer `unreadAt`. A new App talking to an older API
ignores the populated field. The field was removed together with the App floor
raise to `0.963.3` above.

## Phone proactive sends target the caller's own link (2026-09-25)

`POST /api/integrations/phone/message` and
`POST /api/integrations/phone/upload-file/complete` now always deliver to the
caller's own AgentPhone link, resolved by user and organization (a member has at
most one link per organization). The request `toNumber` is optional and ignored.
Previously the routes normalized `toNumber` as an SMS number, so email-shaped
iMessage handles normalized to an empty string and every proactive send from
an email-linked member failed with 404.

CLIs released before this change still send `toNumber`; the API accepts and
ignores it. The new CLI no longer sends `toNumber`. A new CLI talking to an
older API (rollout overlap or API rollback) is rejected with 400 because the
older contract requires `toNumber`; the send can be retried after the new API
is live. Remove the contract field once CLI versions from before this change
are no longer in use. Since the unified messaging flags (#37212), the phone
commands' `--to` is a visible option that accepts only `me` (the default); a
phone number there is rejected rather than ignored.

## Platform and run pipeline public brand retirement (2026-09-25)

Okou is the only product brand (#36766, slice E). The API no longer reads or
writes `public_brand` on `push_subscriptions`, `email_outbox`, `export_jobs`,
`usage_pack_invitation_purchases`, `browser_sessions` or
`socialkit_download_jobs`. `shared_threads.public_brand` is owned by the
artifact link layout (#36773), which writes the current layout segment and
reads the stored segment to locate existing shares; this change only drops it
from shared-thread responses and request plumbing. Reusing a pending
usage-pack invitation checkout no longer filters by brand.

Migration `1237_public_brand_okou_default_platform` sets the column default to
`'okou'` on all seven tables (previously `'vm0'`, or no default on
`browser_sessions` and `socialkit_download_jobs`). An old API reads `okou` from
rows the new API inserts, and its own inserts still carry an explicit brand, so
old API/new DB and rollback remain compatible. The columns and their ORM
declarations stayed in place until the
[public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25).

`GET /api/shared-threads/:id` and `GET /api/shared-threads/:id/meta` no longer
return `publicBrand`. No App code reads it, and the App does not validate
responses. The test-only email outbox state endpoint no longer returns
`public_brand`.

Chat run callbacks no longer read `publicBrand`. The persisted `chat` callback
payload still carries a fixed `publicBrand: "okou"`, because an older API
instance that processes the callback defaults a missing value to `vm0`; the
[public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25) stopped writing it. Stored callbacks that carry any
`publicBrand`, including `vm0`, keep parsing because the payload schema passes
unknown keys through, and the value is ignored. Provider delivery callback
payloads keep the fixed value until their provider slices retire the field.
Queued Feishu launches no longer require a run-level brand.

A queued Web input whose context ID is the VM0-era Web ID decodes exactly like
the Okou Web ID. Writers still emit the Okou ID. Official Workflow inputs use
that normal identity with a private claim; the separate launch markers are
[retired by #29908](#official-workflow-canonical-queue-contexts-29908).

The internal custom connector OAuth start no longer takes a brand; the brand
was never part of the persisted OAuth state, so no in-flight flow is affected.

The Platform runtime configuration no longer carries `publicBrand`, and the
Platform no longer sends the PostHog `public_brand` property or the Sentry
`public_brand` tag. Queries that filter on `public_brand = 'okou'` must drop
that filter; historical events keep the property.

## Discord native history attachment URLs (2026-09-25)

`GET /api/integrations/discord/messages` and `/replies` no longer return
`attachments[].url` (the signed Discord CDN link); `id`, `filename`, `size` and
`contentType` remain. Older CLI builds do not validate this response and print
only attachment filenames, so they are unaffected; downloads use the
attachment ID through `download-file`. `channel list` also stops returning
forum and media channels. The Discord integration is default-off.

## Teams and Telegram public brand retirement (2026-09-25)

Teams and Telegram are Okou-only (#36766, slice C). The API no longer reads or
writes `public_brand` on `teams_org_installations`, `chat_teams_context`,
`telegram_installations`, `telegram_official_user_links` or
`chat_telegram_context`. Queued Teams and Telegram launches and inbound-file
materialization use the fixed `okou` brand. The official Telegram user-link
lookup no longer copies a row's own brand back onto it, and
`chat_telegram_context` rows with a null or `vm0` brand now launch normally
instead of being dropped at claim time.

Migration `1234_teams_telegram_public_brand_okou_default` sets the column
default to `'okou'` on `chat_teams_context` (previously `NOT NULL` without a
default), `chat_telegram_context` (previously no default),
`telegram_installations` and `telegram_official_user_links` (both previously
`'vm0'`), matching `teams_org_installations`. An old API therefore reads `okou`
from rows the new API inserts, including the non-null brand its Telegram
queued-launch path requires, so old API/new DB and rollback remain compatible.
Existing rows keep their stored values; no current reader observes them. The
columns and their ORM declarations stayed in place until the
[public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25).

Teams and Telegram chat callback payloads, and the Teams delivery target inside
persisted run payloads, still carry `publicBrand: "okou"`. APIs before this
change require that key when they parse a pending callback or a claimed run, so
removing it would break delivery during a rolling deploy or after an API
rollback. The new readers ignore any stored value, including `vm0`. The
[public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25) stopped writing the key.

The Teams OAuth `state` no longer carries `publicBrand`, and the callback no
longer requires it. A state issued by an older API still parses because the
extra key is ignored. A state issued by the new API and returned to an older
API instance during the rollout, or after an API rollback, is rejected as
`Invalid connect state.`; the user restarts the Microsoft sign-in. States live
only for one interactive sign-in, so no durable flow depends on the key.

## Slack and Discord public brand retirement (2026-09-25)

Slack and Discord are Okou-only. The API no longer reads or writes
`public_brand` on `slack_org_installations`, `slack_chat_ingress`,
`chat_slack_context`, `discord_chat_ingress` or `chat_discord_context`, and the
Slack webhook handlers no longer overlay a request brand on the installation
row (#36766, slice A).

Migration `1233_slack_discord_public_brand_okou_default` sets the column default
to `'okou'` on `slack_chat_ingress`, `chat_slack_context`,
`discord_chat_ingress` and `chat_discord_context` (previously no default);
`slack_org_installations` already defaulted to `'okou'`. An old API therefore
reads a non-null `okou` brand from rows the new API inserts, so old API/new DB
and rollback remain compatible. The columns and their ORM declarations stayed in
place until the [public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25).

Persisted callback payloads:

- `slack:chat`: the reader no longer declares `publicBrand`, so stored payloads
  that carry it keep parsing (the key is stripped). Older APIs require the
  field, so the writer kept emitting the literal `publicBrand: "okou"` until
  the [public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25).
- `chat` callback `discordDelivery`: the target no longer declares
  `publicBrand`; stored targets that carry it keep parsing. Older APIs require
  `publicBrand: "okou"` on the stored target, so the persisted `chat` callback
  kept writing that literal through `storedDiscordDeliveryTarget` until the
  [public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25).

Slack OAuth state no longer carries `publicBrand`. During the Phase 1 rollout,
the new API accepted states with the retired key, while an older API rejected
states without it; the user restarted an affected install or connect. States
expire after 15 minutes. Since Phase 2 #36909 shipped to `api/production` and
the rollback floor excludes pre-Phase-2 APIs, no serving or rollback-target API
can issue the old shape; its synthetic test and test-only signing export are
removed. Current install/connect, signature and expiry coverage remains. The
`?publicBrand=` install query parameter was already ignored.

The test-only `/api/test/slack-state` contract no longer accepts
`public_brand` or returns `publicBrand`; undeclared request keys are stripped.

## Feishu public brand retirement (2026-09-25)

Feishu and Lark are Okou-only (#36766, slice B). The API no longer reads or
writes `public_brand` on `feishu_org_installations`, `feishu_org_connections`,
`feishu_chat_ingress` or `chat_feishu_context`. Ingress processing and queued
launches no longer reject a null brand, so stored null or `vm0` rows launch and
deliver normally. The Feishu launch hands the fixed `okou` brand to the shared
run pipeline; that run-level field is retired separately.

Migration `1231_feishu_public_brand_okou_default` sets the column default to
`'okou'` on all four tables (`feishu_org_installations` was `'vm0'`; the others
had none). An old API therefore reads `okou` from rows the new API inserts,
including the non-null brand that its ingress processor and queued-launch path
require, so old API/new DB and rollback remain compatible. The columns and their
ORM declarations stayed until the [public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25).

Stored `feishu:chat` and `feishu:org` callback payloads keep parsing: current
readers no longer declare `publicBrand`, so a stored brand is ignored. Older
APIs still require the field, so writers kept stamping the fixed
`FEISHU_CALLBACK_ROLLBACK_PUBLIC_BRAND` value until the
[public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25) excluded those APIs from rollback.

Feishu OAuth state no longer carries `publicBrand`. During the Phase 1 rollout,
states signed by an older API still verified because the extra key was stripped;
a new state returned to an older API was rejected and the user retried. States
expire after ten minutes. Since Phase 2 #36909 shipped to `api/production` and
the rollback floor excludes pre-Phase-2 APIs, no serving or rollback-target API
can issue the old shape; its synthetic test is removed. Current state signing,
validation and expiry coverage remains.

The Feishu and Lark connect status responses no longer return `publicBrand`,
either at the top level or per installation. The App only copied the value into
its installation list and never read it, and the App does not validate
responses, so older App bundles are unaffected. The unused `publicBrand`
argument of `startCustomConnectorOAuth2$` is removed; it never reached a
persisted or external shape.

## Account deletion local-data cleanup retirement (2026-09-25)

Okou no longer deletes a deleted account's browser or Desktop local data. The
API removes `POST /api/account-erasure/status-capability` and
`GET /api/account-erasure/status`; the App no longer issues or stores status
capabilities, polls deletion status, or purges account-scoped IndexedDB,
voice-draft or onboarding bytes. Server-side account erasure is unchanged.

An older App bundle or Desktop renderer keeps its detached lifecycle: its
capability request and status polls now receive 404. Both calls already
suppress error toasts; the capability failure is settled and a status 404 is
skipped, so the old client simply stops purging. Its saved
`account-erasure-status-capability:*` localStorage entries remain inert and
are not migrated. A new App against an older API makes no such calls. Rollback
is safe; an older API resumes serving the routes with the same signing key.

## Sandbox-hosted artifact covers (#36205)

Hosted deployment requests may include a separately uploaded private preview
when the default-off `artifactPreviews` switch is enabled. The same switch gates
CLI capture, generation guidance and server prepare/complete admission.
When disabled, capture is a silent no-op and supplied previews are ignored;
hosting continues normally. Prepare/complete use `previewSkipped: true` to
acknowledge an ignored cover, including disabling between those requests.
Published covers remain readable after disabling the switch.
Deploy and drain API readers before the new CLI/generation instructions; a
mixed completion fleet must not ignore the preview requirement. Old requests
retain backend screenshots until the separately planned retirement. The
manifest's optional preview metadata and existing file/catalog image reference
need no database migration. See [the publishing, storage and rollout contract](sandbox-artifact-previews.md).

## Artifact and hosted-site link layouts (2026-09-25)

The retired VM0 brand survives only as the read-only _legacy link layout_
(#36766). `LinkLayout` (`packages/api-contracts/src/contracts/link-layout.ts`)
is `current` or `legacy`; every new publication, upload, generated artifact,
conversation snapshot and preview grant uses `current`. The layout is resolved
only from stored data and is never a product identity. Records derived from
legacy content, such as a share, owner preview or pointer update of a legacy
site, inherit that content's layout so previously issued links keep resolving.

The persisted layout marker keeps its historical spelling; renaming it would
break stored objects and deployed Workers:

| Layout    | Segment / marker | Hosted origin                                             | Artifact CDN                     | Pointer namespace    |
| --------- | ---------------- | --------------------------------------------------------- | -------------------------------- | -------------------- |
| `current` | `okou`           | `OKOU_HOST_SCHEME`://…`OKOU_PUBLIC_HOST_DOMAIN`           | `OKOU_PUBLIC_ARTIFACTS_BASE_URL` | `sites/brands/okou/` |
| `legacy`  | `vm0`            | `ZERO_HOST_SCHEME`://…`ZERO_HOST_DOMAIN` (`sites.vm0.io`) | `PUBLIC_ARTIFACTS_BASE_URL`      | `sites/`             |

The segment appears in R2 keys (`artifact-shares/<segment>/`,
`artifact-delivery/<segment>/html/`, `shared-thread-artifacts/<segment>/`,
`shared-artifacts/<segment>/`, `private-sites/<segment>/`,
`private-previews/<segment>/`, `shared-previews/<segment>/`), in the
`publicBrand` field of stored R2 policies, delivery records, preview grants,
pointers and manifests, in the `public-brand` object metadata, in the
`publicBrand` key of `run_uploaded_files.metadata` and chat attachment
metadata, and in the `link_layout_segment` column (named `public_brand` until
the [public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25)) of `hosted_sites`,
`hosted_deployments`, `private_hosted_deployments` and `artifact_shares`.
Where a marker is absent — V1 artifact objects, V2 objects and canonical assets
stored before the marker, pointers and manifests written before it, and
historical public delivery writes — the layout is `legacy`. Present unknown
values fail. The host Worker (#36766 slice G) uses the same segment names.
Conversation snapshots are addressed through
`shared_threads.link_layout_segment`, which remains their layout marker.

Writers therefore keep emitting the `okou` marker on every current-layout
object: deployed Workers and an older API treat a missing marker as legacy.
The API no longer accepts or passes a brand for uploads, generations, hosted
deployments, integration input files or conversation attachment copies.
Legacy-layout hosted sites keep serving and keep their names reserved; a new
publication never redeploys a legacy site and, as before, receives a fallback
name in the current layout when a legacy site holds the requested name. Artifact
preview images are new objects and use `current`. Video poster extraction is
[retired](#video-poster-extraction-retired-2026-10-08); existing poster objects
retain their original layout.

Migration `1235_hosted_artifact_link_layout_okou_default` sets `DEFAULT 'okou'`
on the four `public_brand` columns, so any writer that omits the column
records the current layout. The API still writes the segment explicitly on
hosted sites, deployments, shares and shared threads, using the same layout that
selects their URLs and keys, so rows do not depend on the migration having run.
Old API/new DB and rollback remain compatible. The columns, the
`(site_id, public_brand)` foreign keys and their unique key stay: they are the
per-row layout marker for roughly 13.4k sites and 22.5k deployments. The
[public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25) renamed the column, its unique key and foreign keys to
`link_layout_segment` with unchanged values.

Built-in generation jobs no longer read a brand. New job requests kept writing
`__builtInGeneration.publicBrand = "okou"` until the
[public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25), so an older API that completed the job during rollout or rollback
did not publish its result in the legacy layout. Stored requests that still carry any `publicBrand` value parse and the
value is ignored.

Environment names are unchanged because renaming deployed secrets is not safe
in one release: `OKOU_*` configures the current layout and
`PUBLIC_ARTIFACTS_BASE_URL` / `ZERO_HOST_*` configure only legacy-link
reconstruction.

## Host-worker storage layouts replace public brand (2026-09-25)

`apps/host-worker` no longer models a public brand (#36766). It resolves hosted
sites, previews and artifact shares through two read-only storage layouts: the
**legacy** layout served on `HOST_DOMAIN` (`*.sites.vm0.io`) and the **current**
layout served on `OKOU_HOST_DOMAIN` (`*.okou.app`). The persisted path segments
`vm0` and `okou` remain layout constants, so every R2 key the Worker reads is
unchanged: `sites/` and `sites/brands/okou/` pointers, `private-sites/`,
`shared-artifacts/`, `private-previews/`, `shared-previews/`, `artifact-shares/`,
`artifact-delivery/` and `shared-thread-artifacts/` prefixes, the
`artifact-delivery/{segment}/registration.json` markers, and the
`/__artifact-content/{segment}/` content-cache keys.

Stored pointers, manifests, grants and registry records keep their historical
`publicBrand` field. The Worker reads it only as the stored layout segment;
pointers and manifests without it remain in the legacy layout permanently
(#28449). Wrangler routes, domains and environment variable names are
unchanged, and legacy `sh-` shares and the #32492 registration-marker fallback
keep their existing behavior.

This is a Worker-only refactor with identical request behavior, so it has no
ordering requirement against the API, and a Worker rollback is safe in either
direction. The API writers of these objects are retired separately; they must
keep writing the same key layout and stored segment values until a planned
storage migration replaces both sides.

## GitHub and workflow automation public brand retirement (2026-09-25)

Okou is the only product brand (#36766). The API no longer reads or writes
`github_installations.public_brand`, `github_installations.setup_public_brand`,
`chat_github_context.public_brand` or `chat_automation_context.public_brand`.
Every value the API wrote there was already `okou`, and no reader changed
behavior based on it: the setup brand selected by
`findGithubInstallationByInstallationId` was unused, queued automation
launches only required a non-null value, and queued GitHub launches now use
the fixed `okou` run brand, as AgentPhone does. The GitHub webhook and manual
"Run now" paths no longer pass a brand into workflow automation admission.

Migration `1230_github_automation_public_brand_okou_default` sets the default
to `'okou'` on `github_installations.setup_public_brand`,
`chat_github_context.public_brand` and `chat_automation_context.public_brand`
(previously `'vm0'`); `github_installations.public_brand` already defaulted to
`'okou'`. An old API therefore reads `okou`, including the non-null automation
brand its queue drain requires, from rows the new API inserts. Old API/new DB
and rollback remain compatible. The columns and their Drizzle declarations
stayed until the [public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25).

GitHub App install state no longer carries `publicBrand` / `publicBrandSig`.
The callback-redirect and requested-scope HMACs no longer include a brand and
use new `v2` payload tags; the identity signature is unchanged. States that
omit a brand are no longer treated as a signed `vm0` brand, and brand keys in
a state are ignored. A GitHub install started on one API version and
completed on the other fails signature validation and shows the existing
"Invalid OAuth state" error; the user restarts the install. These states only
live for one GitHub install round trip, so no compatibility path is kept.
State-less callbacks (`setup_action=update`, provider errors) are unchanged.

The `workflow-automation:result-email` callback reader no longer declares
`publicBrand` and strips it instead of rejecting it, so callbacks persisted by
earlier APIs still parse. The `github:chat` reader ignores the field in the
same way. Writers still emit `publicBrand: "okou"` in the result-email payload
because earlier APIs require the key in their strict schema; the generic
`chat` callback brand and the `github:chat` writer belong to the run-level
brand cleanup. The [public brand retirement contraction](#public-brand-retirement-contraction-2026-09-25) removed these writes and raised the rollback
floor past the APIs that require them. No App, CLI or public contract changes.

## Discord canonical Chat sources (2026-09-24)

The default-off Discord integration adds `discord` to the canonical Chat context,
public source annotation, Run trigger, input-asset provenance, and billing source
contracts. The schema migration expands existing CHECK constraints and updates
`billing_usage_source` without rewriting historical events or billing identities.
Every existing source remains legal for an older API after migration. New
Discord writers require the provider tables and these expanded constraints, so
the normal migration-before-promotion order applies.

The new `discord_chat_deliveries` and `discord_gateway_receipts` tables also
require the C ownership inventory. Older erasure workers, including workers with
only the Discord foundation inventory, reject these unknown catalogue tables
even when the feature is disabled. During the migration-to-compatible-API window,
affected deletion jobs remain durable and retry after 60 seconds. Promote workers
with the complete C inventory after migration and keep them available to drain
the backlog. An API rollback below that inventory stalls those jobs until
compatible workers return; do not weaken the catalogue guard.

The delivery outbox binds an event to its canonical thread with a composite
foreign key. Build its supporting `chat_events` unique index concurrently in a
separate nontransactional migration. Attach a `UNIQUE` constraint with
`USING INDEX` to reuse that index, then add the outbox foreign key. Expand the
existing context and billing checks with `NOT VALID`, then validate them in
a later transaction so scans do not hold the expansion's exclusive table locks.

Discord thread creation uses the preparation API runtime mapping, so its implicit
INSERT remains legal after the separately authorized legacy allocator contraction.
The chat event contraction later removed that column and bridge. Discord
input claims, required per-message context, canonical events and durable ingress
completion stay atomic; the active mode moves weak thread activity updates after
commit. Terminal callback replay repairs missing Discord outbox registration.
The existing bounded late-content sweep also includes Discord context through its
retained thread ownership.

Discord's private context snapshot is stored separately from the immutable
user-message document. Public event and snapshot projections carry only
`{type:"source",kind:"discord",href?}`; binding IDs, authorization material and
captured channel history are not public source fields. Existing messages keep
their existing source and attachment shapes. Opaque application/message receipts
commit with admission and survive connection or Chat deletion, preventing a lost
ACK from launching the same task after reconnect. Separately namespaced guild
removal receipts prevent replay from deleting a newer installation. These
receipts retain no raw event, account identity, channel history or credential.

Older strict public ChatEvent readers in the API and App do not recognize the
new source literal. The CLI raw-history sync already preserves opaque
`userMessage` payloads and string context types without projecting them.
`discordIntegration` and the Gateway remain disabled by default; no production
Discord records or activation are authorized by this implementation. Fixture
validation uses matching current readers. Enabling the integration later requires
compatible public ChatEvent readers and a reviewed activation/rollback plan; a
rollback to an API that cannot parse Discord source annotations is not supported
once such events exist. The new feature has no existing production users and
adds no compatibility fallback or historical backfill.

## Runner claim first-body-chunk timing (2026-09-24)

The Runner records two optional, successful-claim-only operation durations: time after
response headers until the first non-empty application-visible body chunk, and
from that chunk until the full body is collected. Their sum is the existing
`runner_claim_response_body_read` duration; they do not represent a server
flush or physical wire-byte measurement. The claim request and response,
including context and auth, remain unchanged. An older Runner emits neither
operation; the new Runner uses the existing generic operation stream, which an
older API accepts without a claim-contract change. Missing observations during
a staggered rollout are not zero-valued timings. Compare deployed cohorts by
Runner/API version, size, host and time before interpreting a shifted total
read distribution, because the new observation reads an initial chunk before
collecting the rest.

## Native Morning Brief execution retirement (stage 2)

Stage 1 removed Native admission in migration 1215 and the public API; the
2026-09-24 production handoff check found all 456 Native schedule rows in `legacy`, zero
personal `simpleMorningBrief: true` overrides, ten settled occurrences and
current Official schedules for each enabled former Native member. Stage 2
removes the Native cron, internal worker, debug trigger and preview endpoints,
plus the Native generation/delivery entrypoints. It does not drop or rewrite
historical tables, messages, email receipts or in-flight source collection rows.
The two historical source collection attempts still marked `running` had expired
leases and settled occurrences; their upstream outcomes and billing are not
inferred and are never replayed by this change.

The old App's Native-only Debug card or a caller of an old preview API may
receive 404 after API promotion; a new App no longer renders that card. The
Official Workflow preference, installation and scheduler APIs are retained.
An older API still in flight can read the persisted `simpleMorningBrief` key;
new API writes of `true` remain rejected even though the registry key and
Native collection entrypoints are removed. Historical email admission still
recognizes the distinct Native template and fails closed; it is not gated by
the feature switch. No migration drops Native columns or contracts needed by
retained historical cleanup and scheduling services. Do not remove their fail-closed outbox admission merely because the
scheduler is gone. Releasing this PR needs a separate authorization and normal
release/production checks; PR creation is not deployment approval.

## Morning Brief Official-only storage authority (2026-10-07)

This code stage removes all API consumers of the seven retired Native relations.
`workflow_automations` owns the enabled choice, recurrence and next-run anchor;
Official automation identities retain dormant choices and stable IDs. Enrollment,
canonical installation selection, Official schedule claims and result email remain.
Installation, reconciliation, toggles, timezone edits, admission, completion,
expiry and lifecycle cleanup neither read nor mirror Native schedules, occurrences,
collections, generations, deliveries, skips or installed preferences.

Morning Brief expiry is enabled independently of general workflow expiry. A bounded
lane moves an unclaimed anchor older than 30 minutes to the next future occurrence,
without creating a Run, incrementing failures or mailing a missed brief. Exact
Official row predicates and the claim journal fence concurrent admission, edits,
settlement and expiry. An unsettled Official claim or pending queue input is held;
reconciliation preserves its empty in-flight slot for completion. Admission holds
a republished anchor until the current claim settles. Pre-journal callbacks can
advance only a lineage without any Official claim records.

The distinct historical `morning-brief-result` outbox template is terminally rejected
before parsing, rendering or provider replay, including a previously committed
provider request. Its body and rendered request are scrubbed; its provider key and
an explicit unresolved-outcome error remain until ordinary outbox retention removes
the failed record. Owner lifecycle cleanup also purges globally retired Native
unsent intents directly from the outbox, without the former delivery association;
completed mail and other templates are untouched. Rejection does not imply a previous provider attempt was never
accepted. `official-automation-result` keeps its existing result callbacks,
unsubscribe, suppression, retention and idempotent delivery contract.

No database migration accompanies this code stage. Keep all seven tables and their
columns while the outgoing API drains: old API writers can still require them, and
old expiry/callback paths may fail to advance an anchor after the new API stops
mirroring Native state. The new API can recover an unclaimed expired Official anchor
on a later tick. Neither version re-enables Native execution; old clients continue
to use the same Official preference and workflow APIs. Rolling back to the previous
API restores its Native mirror dependency and may restore the stuck-anchor behavior;
prefer a forward fix. Do not restore an API older than Native execution retirement.

Before removing the Native generation retention worker in production, confirm the
retired generation store has no remaining content that needs its bounded retention
and no admitted producer can still write it. Later table contraction requires its
own release after every outgoing API and worker has drained and the rollback floor
excludes Native readers. Recheck historical content and Native outbox intents, purge
as needed, and drop only the seven retired relations. Preserve the anonymous
`morning_brief_platform_generation_receipts`, Official schedule claims, enrollment,
workflows, chat events and ordinary email lifecycle. This stage is a code contract,
not evidence of deployment or production recovery.

## Native Morning Brief storage contraction (2026-10-07)

Migration 1342 drops only the seven retired Native relations: schedule skips,
occurrences, schedules, deliveries, generations, collection occurrences and
installed preferences. Child tables are dropped before their parents without
`CASCADE`; an unexpected dependency aborts the migration transaction. Anonymous
platform generation cost receipts keep their existing schema and records.
Official automation identities, claims, enrollment, workflow schedule skips,
chat history and the ordinary email lifecycle remain authoritative.

The reader/writer retirement in #37874 shipped in API 1.712.4 via #37878. Before
preparing this contraction, production API 1.712.6 (commit
`ad381f5bb282aa433ec34ae894a16ed8f4bb4896`) had completed promotion at
2026-10-07 12:20:41 UTC. The 13:44:55–13:59:55 UTC trace window contained 48,797
API spans, all on that commit; the API function maximum duration is 300 seconds.
The existing production rollback floor for migration 1338 is commit
`a9c3270099034c0f7ee73f6c730b07efa7d1d733`, which includes #37874 and excludes
APIs that depend on Native storage. Keep that floor when deploying or rolling back.

The production preflight found zero Native generation rows, all 10 Native
occurrences settled, all 808 schedules in the legacy phase, and no unsent email
outbox records. Two historical collection rows still say `running`, but their
leases expired on September 20–21; they are not an active producer. These are
observations at preparation time, not proof that migration 1342 has run. The
contraction ships in a separate release; if deployment is delayed or producers
change, recheck the drain, content, outbox and rollback gates before applying it.
An API predating #37874 is incompatible with the contracted database; deployed
retirement APIs and the new API both operate with or without these seven tables.

## Morning Brief settings status and collection account retirement (2026-09-24)

`GET`/`PUT /api/preferences/morning-brief` no longer return `nextRunAt`,
`timezone`, `lastDeliveredAt` or `lastRun`. The App does not validate API
responses outside tests, so an older App bundle reading the new API sees the
fields as absent and renders no next-run or delivery badge; a new App reading
an older API ignores the extra fields.

The `morningBriefChanged` realtime topic is retired: the API no longer
publishes it and the App no longer subscribes to it, nor refetches the
preference on `connector:changed`, `slack:changed` or a timezone update. The
Settings card reflects server state when it loads. An older bundle keeps its
subscription and simply receives nothing; an older API's publishes reach no
subscriber in a new bundle. `connector:changed` and `slack:changed` are still
published for their other consumers.

Native Morning Brief execution no longer computes or writes the per-occurrence
collection account, whose only reader was `lastRun`. The
`morning_brief_native_occurrences.collection_facts` column is left in place
because an older API may still write it during rollout; the new API neither
reads nor writes it. Mixed versions are compatible: the column is nullable and
nothing reads it. Rollback is safe; an older API simply resumes writing it.

This API version still declares the column in Drizzle and uses full-row
`select()`/`returning()` on the table, so the drop follows "Drop a Column as a
Two-release Contract": first remove the Drizzle declaration in its own release,
then drop the column in a later migration once every API that declares it has
drained.

Migration `1274` later dropped the column; see
[Retired preference and occurrence columns dropped](#retired-preference-and-occurrence-columns-dropped-2026-09-28).

## Discord verified foundation (2026-09-24)

The Discord foundation adds seven new relations, their ownership constraints,
and an additional unique key on the already unique chat-thread ID plus owner.
Existing non-erasure API reads and writes remain legal after migration.
The chat-thread ownership key also makes existing KEY SHARE locks retain the
thread user until commit. No production writer transfers a thread between users;
ordinary title, draft and other non-key updates remain legal. Race tests now
exercise owner changes before the initial pin and observed blocking after it.
New cleanup/export readers require the migration before API promotion, following
the existing production release order. There are no historical Discord rows to
backfill. `discordIntegration` remains disabled for every organization by
default, and no Gateway or OAuth onboarding is activated by this change.

Old account-erasure workers do not ignore the new relations: their catalogue
coverage guard rejects tables absent from their compiled ownership inventory,
even while Discord is disabled. During the migration-to-compatible-API window,
affected deletion jobs remain durable and retry after 60 seconds; they require
workers with the Discord inventory to progress. Promote compatible API workers
after the migration and keep them available to drain this backlog. Rolling back
to an API with the old inventory stalls those jobs until compatible workers
return. Do not weaken the catalogue guard or treat feature-off state as erasure
compatibility.

Status/preferences are new API contracts. No existing client or Runner protocol
changes. Gateway version 1 carries only Discord event data; the API owns Okou
identity resolution. Gateway handler/relay implementations land in their own
slices before activation.

Account exports add a bounded Discord source phase only when owned Discord rows
exist. Once an opted-in development/test account has a durable export checkpoint
in that phase, an older API cannot resume it; finish or restart that export with
the new API. This is a non-GA, default-off surface and introduces no compatibility
reader or rollback fallback. Application credentials remain environment-owned
and are never exported or revoked by guild removal.

## Chat search user keyword GIN index (2026-09-24)

Migration `1214_chat_search_user_tsv_gin` installs `btree_gin` and builds
`chat_event_search_messages_user_tsv_gin_idx` on `(user_id, tsv)` with
`CREATE INDEX CONCURRENTLY`. It does not block chat search reads or projector
writes. The build waits for older transactions database-wide, so the migration
raises `lock_timeout` to 10 minutes and disables `statement_timeout` for its
own session, then resets both. A failed build is retried from the start: the
migration drops any INVALID index concurrently before rebuilding it.

The new index keeps `fastupdate`, like `chat_event_search_messages_tsv_idx`.
The search projector's GIN maintenance now drains both indexes from one shared
30-second tick budget, so a foreground 4 MiB pending-list flush does not land
inside a projection transaction. The API role must own the new index for
`gin_clean_pending_list`, as it does the existing one.

Old API/new DB remains compatible: the old projector does not maintain the new
index, but the old API only serves until promotion. New API/old DB is not a
serving combination, because maintenance resolves the new index by name. The
release must complete the migration before API promotion. Rollback keeps the
extension and index and rolls back only the API. The search query and its
responses are unchanged; the planner chooses the new index. The existing
`chat_event_search_messages_tsv_idx` stays until production plans confirm it
is unused.

## AgentPhone public brand retirement (2026-09-24)

AgentPhone is Okou-only. Production rows in `agentphone_connection_codes`,
`agentphone_user_links`, `agentphone_messages` and `chat_agentphone_context`
were set to `public_brand = 'okou'` before this change (#36650).

The API no longer reads or writes those four `public_brand` columns. Queued
AgentPhone launches and file materialization use the fixed `okou` brand, and
`GET /api/integrations/agentphone/link` no longer returns `publicBrand`. No App
reads that response field, and the App does not validate responses.

Migration `1223_agentphone_public_brand_okou_default` sets the column default to
`'okou'` on `agentphone_user_links` (previously `'vm0'`), `agentphone_messages`
and `chat_agentphone_context` (previously no default), matching
`agentphone_connection_codes`. An old API therefore reads `okou` from rows the
new API inserts, including the non-null brand that its queued-launch path
requires, so old API/new DB and rollback remain compatible. The columns and
their ORM declarations stayed in place until the separate drop below.

The connect link no longer carries `publicBrand` / `brandSig`, and the connect
request contract no longer declares `publicBrand` / `publicBrandSignature`.
`app-v0.958.0` (tag commit `9a3f9b6429d1b9d0a1c1400ed49e703038501735`) is the
first App that neither reads nor posts them; production `app/production` was
deployed at `66a534132b49` on 2026-09-24 13:24 UTC and later at `63ad2eed786e`,
both descendants of #36651. App builds `0.954.0` to `0.957.x` still require
`brandSig` to show Connect, so this change raises the identified-App minimum
version to `0.958.0`; those bundles receive `426` on their next API request and
refresh into the live App. Links expire after ten minutes. A body that still
carries the brand fields is not rejected, because undeclared keys are stripped. An App rollback below
that release also requires rolling back the API below this change, because the
older connect page requires `brandSig`. An API rollback below the expand change
(#36651) also requires rolling back the App, because the older API requires the
brand fields.

### Column drop (contract step, #36729)

Migration `1228_drop_agentphone_public_brand` drops the four `public_brand`
columns and removes their Drizzle declarations. Gate evidence: API release
`api-v1.673.0` (release commit `11339e527110e22cc5c2e2a45a96464af283e0b3`)
applied `1223` and promoted `api/production` at
`c6495e1927c69bf5479300e841a9805df59d0a77` on 2026-09-24 23:49 UTC. Every
earlier production API predates #36722; that deployment and its successors
contain it.

APIs after #36722 no longer read the value, but they still declare the columns.
Drizzle names every declared column in `insert` column lists and in bare
`select()`, so those APIs still reach `public_brand` on all four tables. As with
`1107` and `1123`, `test:migration-consistency` requires the declaration and the
physical schema to agree, so declaration removal and the drop ship in one
release. Migrations run before API promotion. In the window before the previous
API drains, its AgentPhone connect, inbound-message, user-link and chat-context
statements receive `42703`. Release this change alone at low traffic; the
`api-v1.673.0` promotion measured about 20 seconds from migration completion to
deployment finish.

Rollback promotes artifacts without restoring schema. The production rollback
resolver therefore rejects API targets that predate the canonical main commit
that added `1228_drop_agentphone_public_brand.sql`. Recovering past that commit
requires a forward-fix migration that restores the columns, not an artifact
rollback. The Slack, Feishu, Teams, Telegram and other `public_brand` columns are
unaffected.

## Voice input model selection retirement (2026-09-24)

Voice input always uses Gemini 3.1 Flash-Lite on Vertex AI. The Debug
preferences picker and the OpenRouter and fal transcription paths are removed;
`POST /api/voice-io/transcribe/segment` no longer reads a member preference.

`voiceInputModel` is removed from the user preferences contract without a
compatibility window. Its only producer and consumer was the Debug picker behind
the staff-only `_debug` switch, and the App does not validate API responses. An
older bundle therefore only shows the default in that staff picker, and a staff
update that carries nothing but this field is rejected as empty. The
`org_members_metadata.voice_input_model` column is left in place: the new API
neither reads nor writes it while an older API may still do so. Drop it in a
separate migration after older API deployments drain.
Migration `1274` later dropped it; see
[Retired preference and occurrence columns dropped](#retired-preference-and-occurrence-columns-dropped-2026-09-28).

## Guest storage batch timing attribution (2026-09-24)

Runner storage batch operations now include optional Guest-server duration, a
nonnegative Runner-minus-Guest residual when the pair is consistent, and a
fixed timing state. The API explicitly validates and forwards these fields to
the sandbox operation log. An older Runner omits them and remains accepted by
the new API. An older API strips the new optional fields; storage application
still works, but the extra timing is unavailable until the API is promoted.
Deploy the API before the Runner to retain the new samples. Mixed-version
production comparisons must report field coverage and Runner version mix;
missing timing is never a zero duration. The Guest protocol and storage apply
behavior are unchanged.

## Guest decoded-storage input attribution (2026-09-27)

A Guest helper with input-phase attribution emits fixed `guest_storage_apply_input_*`
operation rows only for `--storage-files-stdin`: stale-manifest cleanup, bounded
stdin read, frame split, manifest parse, combined file decode/validation, and
mount-binding validation. Each attempted decoded input also emits one zero-time
`guest_storage_apply_input_payload_bytes_*` row, classified from the framed
**binary payload**, not the manifest JSON or whole envelope; failed cleanup,
read or framing yields `unavailable_or_inconsistent`, not zero. A size row has
`success: true` for the observation even if the input failed; use phase results
and `download_total` to determine apply success. Later phases are absent after
an earlier failure. Ordinary manifest modes emit no decoded-input rows.

The actions are additive to the sandbox operation log: older Guest helpers emit
no input rows, and a failed best-effort log write can also omit a row. Never
interpret missing data as a zero duration, a zero-byte payload or a successful
phase. Times are whole milliseconds; the decode phase combines copies and
validation, not isolated copy time. Row emission itself is not included in the
preceding phase timer. Pair versions and per-run ordered batches before
comparing distributions; do not add independently aggregated phase percentiles
or treat the remaining helper residual as removable decode time. No storage
protocol, authorization, limit, cleanup or batch-order change is introduced.

## Chat event split-write contraction (2026-09-25)

Release 2 of [the two-release chat event rollout](chat-event-split-write-rollout.md)
removes the legacy write mode. Production activated split writes at
2026-09-25 00:06:25 UTC. Migration `contract_chat_event_sequence_bridge` locks
`chat_threads` and `chat_event_write_control`, fails with SQLSTATE `55000` unless
the control row is activated, and then drops the allocation bridge trigger,
its function and `chat_threads.last_chat_event_seq_id`. A database without
chat threads is activated by the migration. Every other database, including a
shared preview parent, must run the documented control write first.

Release 1 APIs remain compatible with the contracted schema only in active
mode: their runtime mapping already omits the column. The rollback resolver
refuses targets that predate the split writer; the activation marker is
irreversible, so it no longer reads the database. Never null the activation
marker or restore a pre-Release-1 binary. Those APIs still read the control row
on every write, so the table stays until they leave the rollback window.

## Chat event split-write preparation

See [the two-release chat event rollout](chat-event-split-write-rollout.md) for
the temporary allocation bridge, inactive global control, reader/writer drain,
activation prerequisites, late-content maintenance, and postactivation rollback
floor. That release retained the legacy column and bridge; the contraction
above removes them after activation.

## Codex 0.156.1 OAuth workspace routing

The API supplies the selected workspace ID as `CODEX_OAUTH_ACCOUNT_ID` for
Codex OAuth runs. The guest writes that ID into `auth.json` and both placeholder
JWT claims. Access and refresh tokens remain placeholders; the firewall still
injects real credentials into outbound requests.

The API retains the existing placeholder `CHATGPT_ACCOUNT_ID` for the firewall
and Pi. PR #36402 deployed the additive selected-ID field before #36422 upgraded
the Runner to Codex 0.156.1. The guest now requires a non-empty
`CODEX_OAUTH_ACCOUNT_ID` in OAuth mode: missing, empty, or whitespace-only values
fail setup before creating or replacing `auth.json` or the runtime model catalog.
It no longer substitutes a fabricated workspace identity. API-key, no-auth, and
Pi behavior is unchanged.

An API containing #36402's writer works with both the previous and new guest.
An older API or persisted context without the selected-ID field remains
unsupported with Codex 0.156.1; the new guest rejects it before auth publication
instead of attempting workspace discovery with a placeholder. The existing
production rollback resolver requires targets to descend from
`45b537a596a153a91b76c3bc7223187840f52775` (#37242), which contains the selected-ID
writer at `422349af6b60adf89b7719a440b89ba76c10e25f` (#36402). This cleanup adds no
rollback restriction or data migration. Any separately authorized rollback
before #36402 would also need the older compatible Runner.

Removal evidence recorded for #36420 on 2026-09-30 at 16:54 UTC:

- Read-only MaskDB queries returned zero Codex OAuth runs created before
  `2026-09-24 00:30:00` in `queued`, `pending`, or `running`, and zero persisted
  `runner_job_queue` rows before that cutoff across all providers. The cutoff
  conservatively follows the API writer's recorded 00:18:51 UTC deployment.
  Execution-context JSON was not retrieved; these are old-row inventories, not a
  direct field-presence census.
- Production API deployment `6764085091` at main
  `12bf1328f729cb92261515cb20331d0d49023a77` succeeded at 16:04:04 UTC and contains
  the writer. GitHub ancestry comparison confirms the enforced rollback boundary
  above also contains it.
- #36422 recorded the owner's confirmation that old Runners and claimable old
  contexts were drained, plus a successful real Codex OAuth run on local-11.
  Those are historical upgrade receipts, not a new host-version inventory or a
  live run of this cleanup head.

Recheck these conditions before merge/release if serving or rollback state
changes. This cleanup does not change the provider credential-rotation policy
or claim a workspace-switch fix.

## Chat thread archived flag (2026-09-24)

Migration `1208_chat_thread_archived` adds `chat_threads.archived` (default
`false`) and the `archived` / `unarchived` thread event kinds. It does not
backfill: chats whose title starts with ✅ stay unarchived, and archiving no
longer rewrites titles. Snapshot, metadata and replay readers treat an absent
`archived` field as `false`, so snapshots compacted before this migration and
responses from an older API remain valid. Those tolerant reads are rollout
fallbacks tracked for removal by #36551.

Old API code after the migration stays legal: the column has a default and the
enum values are additive. New API code must not be promoted before the
migration, because thread metadata, snapshot compaction and user export read
`archived` unconditionally; the normal migration-before-promotion release order
covers this.

Only the new archive routes append the new event kinds, and those routes, the
CLI commands that call them and the Web archive controls are all behind the
`ChatThreadArchiving` switch. Web bundles, CLI builds
and iOS builds from before this change parse thread event kinds strictly and
fail to read a stream that contains an archive event until they update. A
rollback of the API below this change leaves already appended archive events in
the stream for those older readers; roll forward instead.

## Chat thread snapshot R2 handoff (2026-09-23)

Historical rollout record; the current header-less inline branch has since
been retired as described at the top of this document.

Migration `1204_chat_thread_snapshot_r2_pointer` adds a nullable R2 object key to
`chat_thread_snapshots`. Existing rows continue to carry the legacy
`chat_threads` JSONB and the API returns the same inline snapshot for them.
The new API can return a short-lived,
scope-checked download URL for a row with an object key; the new App and CLI
materialize that object before caching or replaying its paired event cursor.

The global compaction cron writes R2 snapshots as soon as this API deploys.
Production promotes the API before the App, and previously loaded App bundles
can remain open. The API therefore reads the R2 archive and serves the legacy
inline response to clients that do not send `X-Chat-Thread-Snapshot-R2: 1`.
The new App and CLI send that capability header and receive the short-lived R2
URL. Package versions alone cannot identify the capability because older
deployments use the same versions. This compatibility read does not access the
retired JSONB payload.

The compaction job writes a compressed,
content-addressed JSON snapshot to R2 and publishes its object key together
with the event cursor. It stores an empty JSONB array instead of the retired
projection. Rows without an object key remain readable through the legacy
JSONB response until the job backfills them. A failed upload or a losing
conditional database update leaves the prior snapshot and cursor intact.

The hourly job also removes unreferenced snapshot objects older than seven
days in bounded hash partitions. It retains objects referenced by a current
snapshot or a user export. Rolling back to an API that only understands inline
JSONB after the first R2 write would leave R2-backed snapshots unreadable;
the production rollback resolver enforces the canonical main commit that first
introduced `chat-thread-snapshot-object.ts` as the API reader floor. Recovery
must stay at or above that floor or roll forward.

The legacy JSONB read and the Web App/CLI inline fallbacks described above
were removed on 2026-09-25. See "R2 chat thread snapshot rollout fallbacks
removed" at the top of this file.

## Artifact catalog API handoff (2026-09-23)

The API now enqueues file catalog work in the same transaction as its ordinary
upload, private-file completion, canonical publication, and preview writes. An
awaited immediate sync keeps the usual response path current; the durable row
lets the bounded reconciliation cron recover when that later sync fails. Catalog
list requests repair at most 20 caller-owned rows and no longer drain an entire
backlog. The cron processes at most 100 rows or 20 seconds per tick.

The `run_uploaded_files_queue_artifact_catalog` trigger remains for older API
instances during this handoff. Both the trigger and new API may enqueue the same
file; the primary key makes that one pending task. Replayed catalog writes retain
the existing logical-key conflict and projection ordering rules. New API with
the old schema is supported, and an API rollback remains supported while the
trigger exists. Do not remove any of the eleven artifact/chat triggers in this
release. Their removal requires the remaining file writers, parent-deletion
paths, event and computer-access writers to use explicit operations, followed
by evidence that all old API instances and rollback binaries have drained.

Run deletion now locks its files and deletes file/image/video catalog rows in
the same transaction before the Run cascade removes their source entities.
Agent deletion uses the same operation before its Session/Run cascade. Repeated
deletes coexist with the old triggers because deleting an absent catalog row is
idempotent. The direct hosted-site and account-erasure paths need their own
source-scoped cleanup before the delete triggers can be retired.

## Artifact and chat trigger retirement (contract step)

Migration `1206_retire_artifact_chat_triggers` removes the eleven triggers named
in #33749 and their six unreferenced functions. It is a **contract step**, not
an API expand step. It cannot ship while any serving API instance or supported
rollback binary still relies on trigger-owned catalog writes/deletes, chat event
seq or snapshot cursor derivation, append-only rejection, or computer-host/browser
normalization. An old API against the contracted schema is not supported.

Before applying this migration in production, confirm the explicit API paths from
#36258, #36294, #36301 and #36304 have deployed to **all** serving instances.
Any further production writer fixes discovered in this Draft PR must also ship
before contraction; the migration cannot be its own expand release. The
production rollback resolver rejects API targets before canonical
main commit `065f970bbb8c21c10ef709495d5824d0a6183e50` (#36301, the last
preparation to merge): the first supported rollback release is
`3a2a331d50503a73407029ed9074e7d6930778da` (API 1.664.0). Older entries
in the rollback dashboard remain visible but are rejected before artifact or
host access. Record serving deployment and rollback evidence with the release.
Verify the migration and its permanent inventory against a
replayed database, plus API no-trigger integration coverage for ordinary file
writes and deletion cascades, hosted-site/presentation deletion, chat event and
snapshot concurrency/retries, and computer host selection on create/update.
Do not infer production readiness from a merged commit or a passing isolated
test. Preserve the shipped historical SQL migrations.

This document focuses on three independently deployed surfaces that have
cross-version API or persisted-state compatibility boundaries:

- **Frontend**: browser-delivered web application code.
- **Backend**: API service code in `turbo/apps/api`, plus any intentional
  web-origin rewrites that forward selected `/api/*` paths to the API service.
- **Runner**: long-running runner processes plus the guest binaries shipped
  with that runner.

Other release artifacts, such as the desktop app and host-worker deployments,
have their own release paths and are outside this compatibility model unless
they interact with these frontend, backend, or runner boundaries.

New versions are normally deployed together, but they do not become active at
the same instant. Code and tests must account for periods where different
surfaces are on different versions.

## User preference initialization (2026-09-23)

`GET /api/user-preferences` now returns `409 USER_PREFERENCES_UNINITIALIZED`
when the member lacks either a valid timezone or a locale. The App accepts that
response, then calls `POST /api/user-preferences/initialize` with browser
timezone and the locale selected during initial resource loading. It uses the
POST result directly. An invalid or unavailable browser timezone falls back to
`America/Los_Angeles`; an unsupported browser locale falls back to `en-US`.
The App also initializes if an older API returns `200` with a missing field.

The App Worker prefetches a successful GET into the HTML, which the App consumes
without another browser GET. Prefetch is best effort, bounded to 500 ms, and
does not embed `409`; the client GET remains the fallback when prefetch misses.

The new API continues to accept the older App's optional timezone-only POST.
An empty body fills missing timezone and locale with Pacific Time and English.
Initialization preserves each already stored field independently, so a member
missing only locale keeps their timezone and vice versa. Concurrent writes to
missing fields remain last-writer-wins without a transaction. Against the old
API, a new App may receive an initialize result with no locale; it then uses
the regular preferences update to save locale before returning preferences.
An old App that reads preferences before its startup POST against the new API
can temporarily receive `409`; its existing POST then initializes the member.

The automatic Morning Brief enrollment side effect described by the original
rollout is retired by #36270; see the explicit-installation cleanup below.
Preference initialization still fills missing fields and initializes member
memory, but no longer prepares or installs Morning Brief.

## Morning Brief automatic enrollment retirement (#36270, 2026-10-08)

Remove the historical timezone/no-enrollment admission scan, enrollment cron
worker, lease/backoff commands and automatic installer. Preference initialization,
timezone updates, onboarding completion and Clerk membership creation no longer
start automatic installation or record membership-based enrollment intent.
Explicit user installation and preference toggles, timezone synchronization for
existing installations, and scheduled execution remain supported. An explicit
choice whose prerequisites are unavailable requires another user enable request;
there is no background enrollment retry.

This is an API-only policy change with no new request/response shape or destructive
migration. Existing enrollment rows retain selected-workflow ownership, choices
and cleanup/claim semantics; their schema is not dropped. Old App/new API and
new App/old API still use the same preference and onboarding protocols. An older
API serving, draining or restored by rollback can still auto-install/retry until
it exits; source removal does not prove production drain. Deployment must promote
and drain the API before automatic enrollment is declared stopped. The historical
gap and old preference rollout are accepted as converged per Ethan's explicit
cleanup decision; CLI authentication is not an enrollment entry point.

## Pi 0.87.1 model admission (2026-09-23)

The API and commit-addressed CLI now pin Pi 0.87.1. Its native catalog contains
`claude-opus-5-5`, `gpt-6-sol`, and `gpt-6-luna`, so the Pi admission table can
route those models through Pi when their existing product policy allows it.
This change does not make a model newly addable to an
organization. GPT-6 Sol and Luna continue to use the global OpenRouter
endpoint.

New Pi starts require the matching commit-addressed CLI artifact. Older CLI
artifacts pinned to Pi 0.86.1 cannot resolve these three catalog models. Queued
and active runs keep their captured CLI URL and model configuration; do not
rewrite those contexts during rollout. The 0.87.1 SDK also adds
`context_edit` session entries. Older readers can parse their JSONL but do not
apply those edits when reconstructing context, so a rollback to a 0.86.1 CLI
must wait until affected sessions have drained or use a forward fix with an
explicit reader compatibility check.

## Chat unread endpoint retirement (2026-09-23)

API 1.662.0, App 0.948.0, and CLI 9.356.0 added unread timestamps to the
shared `GET /api/indicators` response. The follow-up removes
`GET /api/chat-thread-unreads` and requires `unreadAt` in that response.
`POST /api/chat-thread-unreads/mark-read` and the unread query used by read-state
writers remain available.

The API force-upgrades App versions below 0.948.0 before route matching, so an
older browser bundle cannot call the removed GET. CLI has no minimum-version
gate; `okou chat list --unread` on CLI versions before 9.356.0 can fail against
the new API. This compatibility loss was explicitly accepted for this cleanup.

New App and CLI builds no longer fetch timestamps from the old GET when an API
omits `unreadAt`. Rollback targets for the API must therefore include the
shared indicators response introduced in API 1.662.0. Rolling the API back
below that version requires restoring the clients' fallback first.

## Thread draft child table, phases 1 and 2a (2026-09-23)

`chat_thread_drafts` holds one row per thread whose composer draft has been
written since the table existed. Phase 1 of #36230 only adds the table and
writes it. `chat_threads.draft_user_message` and `chat_threads.draft_attachments`
remain the values every reader serves, and the draft `PATCH` writes both in one
transaction, so an API version that predates the table is unaffected and keeps
serving the same drafts.

Rolling the API back is schema-compatible, and the table then simply stops
receiving writes. It does not stay correct: an older API still clears and
rewrites the legacy columns, so the child row becomes stale rather than merely
missing. The phase-2 cutover therefore cannot assume the child row is current
for a thread that already has one. Its backfill has to reconcile existing rows,
not only insert missing ones, and it must run after phase 1 is serving
everywhere.

A cleared draft is stored as a retained row with null draft values, never a
deleted row. Phase 2 reads the child row first and falls back to the legacy
columns only when the row is absent, so absence has to keep meaning "never
written" — deleting on clear would resurrect a cleared draft.

Phase 2a (#36297) makes message sends that clear the legacy draft also clear
an **existing** child row in the same transaction. A missing child remains
missing; the legacy clear makes a later missing-row fallback return null. The
send first locks the authorized parent `FOR UPDATE`, before any weaker thread
lock, parent write or child write. Its original parent UPDATE must match before
it updates the child. A child error rolls back the parent clear, event and
sequence reservation. MCP replay and automation sends that preserve drafts
still skip the clear. The older phase-1 PATCH keeps its B1 admission and
`KEY SHARE` -> child -> parent order. The strong send entry lock serializes
these orders even while old phase-1 API processes remain active; `FOR NO KEY
UPDATE` would not conflict with the PATCH's `KEY SHARE` and is insufficient.

This bridge cannot make historical child rows current. Sends from phase-1 or
older API instances may already have left stale children; an API rollback can
do so again. Before child-first reads, all pre-bridge writers must drain and a
separate bounded, resumable reconciliation must repair both missing **and
stale** rows while legacy remains authoritative. Reader cutover needs its own
release gate and rollback design. Later contraction requires a verified cutover
and final completeness check. This slice does not add a send producer fence,
historical backfill or child-first reads.

These phases change no read, contract, or response, and perform no historical
backfill. They do not remove the `chat_threads` row contention in #36173: the
draft `PATCH` still updates that row and can still fail with 55P03 while
another transaction holds it.

## Browser user-action retention (2026-09-23)

Browser user-action requests have no independent expiry. Their active lifetime
continues to come from the exact `browser_session_instances` row: active status,
absolute `timeout_at`, and renewable `idle_expires_at`. The existing Browser
reconciliation worker now converts requests after actual closure, using the
instance's persisted `finished_at`: `pending` becomes `stale`, `applying`
becomes `uncertain`, and existing terminal outcomes remain unchanged. This
database-only work runs independently of the `BrowserNativeInput` switch and
does not call Browser Use or CDP.

Terminal requests remain available for callback recovery for seven days. A row
is cleanup-eligible only when both its `completed_at` and the Browser's
`finished_at` are at least seven days old, which anchors retention to the later
timestamp. Conversion and deletion each process at most 20 rows in ascending
token-hash order per Browser reconciliation tick. Ordinary inactive-Browser and
stopped-instance cleanup retains the instance while any associated action row
remains, so `finished_at` cannot disappear between those phases. Thread
deletion and explicit user or organization erasure remain immediate and are not
delayed by callback retention.

This rollout changes API queries and worker ordering only. It needs no schema
migration or backfill, and new API code is compatible with the already-shipped
action and Browser tables. During a mixed API rollout, older workers do not have
the action-existence guards. Do not treat the retention invariant as active
until the new API version is serving everywhere.

Rolling the API back is schema-compatible but not lifecycle-safe for retained
actions. An older worker can delete the only instance `finished_at` after its
ordinary Browser retention window. A nonterminal action that was not yet
converted can then no longer converge, and a terminal action whose later
completion extended recovery can no longer be selected by the bounded cleanup.
Those rows remain removable by thread/account erasure, but a later forward
deploy cannot reconstruct the lost closure timestamp. Prefer a forward fix; if
a rollback is unavoidable, restore the guarded worker before any affected
instance reaches ordinary Browser cleanup.

## Onboarding model preference

> **Superseded.** Organization model policies and the onboarding model seed
> were retired with the fixed platform Auto model (#37746, #37856). Onboarding
> completion no longer reads a Codex or Claude Code choice or writes any model
> policy; personal subscriptions are connected per member. The text below is
> kept as history.

New organization seeds use GPT-6 Luna as the Built-in default for both Free and
paid workspaces. Existing organizations keep their stored default, including
GPT-5.6 Luna. The new API also recognizes an untouched GPT-5.6 Luna seed from
an older API when completing a Codex or Claude Code onboarding choice. Migration
`1199_gpt_6_luna_policy_admission` enables new GPT-6 Luna organization policies
before the API starts serving the new default; it does not rewrite existing
policies. The GPT-6 Luna runtime route and pricing must be available before this
default is deployed. Remove the old-seed recognition after old API writers drain
and no incomplete-onboarding organization retains the untouched old seed; #36167
tracks the production inventory and removal.

The source-first App sends its optional Codex or Claude Code choice as a query
parameter on `POST /api/onboarding/complete`. An older API ignores that parameter
and completes onboarding with the existing model seed; a newer API accepts older
App requests without it and keeps the same seed. No database migration is needed.
On first completion, the newer API replaces only an untouched default model seed
with the chosen subscription models in the same transaction as the completion
marker. A repeated completion or an already customized model policy leaves the
policy unchanged. A member's onboarding flow does not call this admin-only route.

## Slack ingress failed status retirement (2026-09-20)

Migration `1179_retire_slack_ingress_failed_status` rewrites every
`slack_chat_ingress` row still held at the legacy `failed` status to `terminal`
with `last_error_class = 'legacy_terminal_failure'` and a cleared `retry_at`,
then re-adds `chk_slack_chat_ingress_status` without `'failed'`. The conversion
runs inside the same migration and before `ADD CONSTRAINT`, so the validating
scan has no row left to reject and any row written during the deploy window is
absorbed. `slack_chat_ingress` is not exposed through the masked production
gateway, so the residual count cannot be measured in advance; the in-migration
conversion removes that dependency. `retry_count`, the `attempts_exhausted`
conversion, the constraint name and `idx_slack_chat_ingress_retry_sweep` are
unchanged.

Old API/new DB is compatible. #35193 removed the last writer of `'failed'`; the
serving API classifies failures into `retryable` and `terminal` only, and it
reads the converted rows as ordinary terminal rows. New API/old DB is also
compatible: the new API neither writes nor reads `'failed'` and does not require
the tightened constraint, so it is safe before the migration is visible to it.

**API rollback floor: `29dfab0ba2bdc20979635596ccfa5c78809426c0`** (#35193's
merge commit). An API artifact that predates it still writes `'failed'`, and
after this migration that write fails with SQLSTATE `23514` instead of being
handled — worse than the bounded-retry behaviour it replaced. Rolling the API
back does not restore the previous constraint. Every rollback target must
contain that commit; verify with
`gh api repos/okou-ai/okou/compare/29dfab0ba2bdc20979635596ccfa5c78809426c0...<artifact-sha> --jq .status`
and require `ahead` or `identical`.

The floor was established before merge from `api_commit_sha` in the
`vm0-sandbox-op-log-prod` Axiom dataset: all 17 distinct production API
artifacts observed from 2026-09-18T07:37:39Z, when #35193 first reached
production, through 2026-09-20T11:57:25Z report `ahead`. No production artifact
has been able to write `'failed'` since that first appearance.

## Durable Pi inference table retirement (2026-09-20)

Migration `1180_retire_durable_pi_inference` drops `agent_run_inference`,
`agent_run_sandbox_intent`, `agent_run_sandbox_lease`,
`agent_run_inference_objects` and `pi_inference_objects`. It must ship in a
**later release than the code removal**, not alongside it. Migrations run
before API promotion, so a combined release would have executed this migration
while the previous backend was still serving. In that backend, run creation
reached `checkRunConcurrencyLimit` → `loadOrgConcurrencyAdmissionState`, which
cross-joined `earlierDeferredDemandTotals` into its admission aggregate in a
single statement. That subquery read `agent_run_sandbox_intent` and
`agent_run_inference_objects` with no `schemaVersion` or feature-switch gate,
so every run creation would have failed. The remaining three tables were
reached only by the durable surface itself and by the conversation-history
erasure path, both removed by #35559.

The writers were removed by #35559 and are live in `api-v1.642.2`. Before this
migration ran, only `3ba83ad99700` and `b96c4458caa2` had served since
11:53:45Z, and both contain that removal; the pre-removal commit
`26f1b0acf73a` last served at 11:47:47Z. Old backend/new schema is therefore
not a serving combination for this contraction, which is the only reason the
drop is safe. New backend/old schema remains compatible: the current API never
references these tables.

**This contraction sets a rollback floor.** Once the tables are gone, the API
cannot be rolled back to any build at or before `api-v1.642.1`, because run
creation in those builds reads `agent_run_sandbox_intent` and
`agent_run_inference_objects` unconditionally. A rollback must stay at or above
the release carrying #35559.

The tables held only internal test records: 24, 16, 16, 91 and 90 rows
respectively, measured directly against production on 2026-09-20 before this
migration shipped, matching the 24 durable-inference runs recorded on
2026-09-17 and 2026-09-19. `piDeferredSandbox` shipped `enabled: false` with no org hashes and
never carried real traffic. No backfill is performed and none is required; the
migration comment records that as a decision. There are no browser, Runner, or
API response changes.

## Chat search GIN maintenance (2026-09-20)

Apply `1178_chat_search_gin_statistics` before promoting the API that calls
`public.pgstatginindex`. The migration only installs `pgstattuple` in `public`;
it does not change indexes, drain the pending list, or backfill messages. The
API database role must be able to execute `public.pgstatginindex(regclass)`
and own the search index for `gin_clean_pending_list`. The Neon branch
experiment verified these operations with the branch's database owner.

Old API/new DB remains compatible. New API/old DB is not a serving combination:
the release must complete the additive migration before API promotion. Rollback
keeps the extension installed and rolls back only the API. There are no browser,
Runner, or search-response changes. The existing cron `deferredThreads` count
now also includes statement deadlines and candidates postponed by GIN maintenance.

Maintenance runs before the first candidate and between committed per-thread
transactions, under a nonblocking index-specific advisory lock. It drains at
512 KiB while retaining `fastupdate` and the default 4 MiB foreground threshold.
One tick shares a 30-second maintenance budget and a 1-second lock timeout;
exhaustion or a maintenance deadline defers untouched candidates to the next
tick. A projection statement timeout rolls back just that thread and continues
with other candidates. User cancellation and unrelated failures still propagate.

Branch experiments covered 4,400 synthetic messages across 316 INSERTs with
at most 14 messages per INSERT, plus 22 successful cleanups. This does not bound
a production-sized 1,000-event thread batch or a cold cache. A pre-existing
4.3 MiB backlog exceeded the 30-second cleanup budget in the branch; rollout
must inspect pending size and arrange a separately authorized initial drain if
needed. This migration performs no such drain. Monitor pending-list growth and
cron convergence after release; a deferred watermark is never advanced.

## Pi stable-context schema rollout and rollback

Status: retired by migration `1343_retire_pi_stable_context`; see
[Pi stable-context tables retired](#pi-stable-context-tables-retired-2026-10-07).
The history below describes the original rollout.

Migration 1168, following retained main migrations through
`1167_private_artifact_absolute_urls`, adds
`pi_stable_context_erasure_fences`,
`pi_stable_context_generations`,
`pi_stable_context_publications`, `pi_stable_context_heads`,
`pi_stable_context_artifacts`, and `pi_stable_context_artifact_resources`. It creates empty tables only: it does
not enumerate users, Agents, sessions or Storage and performs no materialization
or production backfill. Deploy the additive migration before an API that writes
these rows. Existing Runner, Sandbox, CLI and persisted Pi resource-snapshot
wire readers are unchanged.

Legacy Clerk user and organization deletion no longer writes
`pi_stable_context_erasure_fences`, and no writer or reader consults it:
membership-cache refresh, generation initialization, demand registration,
publication, and connector, permission and Workflow writes proceed after
deletion. Migration `1254_drop_account_erasure` drops the table. Keep
stable-context activation on hold until migration 1168 is present on every
serving API instance.

Mixed-version API operation is safe by construction. A new reader with no
generation/head treats the exact variant as missing and uses canonical
exact-version discovery. An old writer that does not publish demand likewise
causes a later read-time repair; this is compatibility and recovery, not the
normal invalidation path. Current writers lock the complete existing
affected-head set in canonical UUID order and update only that exact snapshot in
batches of 256. The 16-head worker
batch bounds post-write demand recapture, not lock coverage; a concurrent new
head is excluded from the frozen update set. Writers recapture the exact
post-write semantic source and dynamic skill mounts for that bounded demand set;
they leave a head missing when a referenced immutable artifact is not yet
published. A pending multi-stage source generation is never read as ready.
Source-keyed publication obligations allow independent Workflow writers to
coexist while a replacement supersedes only the same source. Old API code
ignores the additive tables and continues the canonical path. Rollback
therefore consists of rolling API code back while retaining the
tables; do not drop them until all new writers/workers and rollback binaries
have drained.

The optional repair/backfill command is bounded by a cursor and limit, is dry-run
by default, and reports missing/pending/ready/unindexable/failed cardinality. A
mutating pass only records demand for currently known owner/variant heads; it
does not synthesize credentials, sessions or a production-wide cross product.
Establish real cardinality and receive separate production authority before
running it. No release, activation, feature-switch write or backfill is part of
the schema migration.

Ready heads own immutable artifacts, and artifact-resource edges retain exact
Storage/version rows. A source deletion locks/deletes its Workflow and exact
Storage/version parents before retiring generations and invalidating heads in
the same transaction (`Workflow → Storage/version → generation/head`). The
Storage deletion cascades retention edges so normal Workflow/account erasure is
not blocked. Cleanup can remove only an artifact
older than seven days that no head references. Agent/account erasure removes
heads/artifacts through owner edges and explicitly removes generation fences and
publication obligations. A failed or rolled-back source transaction cannot
advance its generation; a stale builder cannot attach
to a newer head. These rules keep rollback and erasure safe without treating
the seven-day legacy snapshot cache or run-only inference objects as live
configuration retention.

## Deployment Model

### Frontend

Frontend deployments publish new browser assets, but users who already have an
app page open keep running the JavaScript that page loaded until the page
navigates or refreshes. The app does not poll for a newer build or automatically
reload an open page.

The current force-upgrade mechanism is driven by API responses. Standard app
API clients send `X-Client-Type: App` and a build-time `X-Client-Version`. Before
route handlers run, the API rejects an app request whose parseable advertised
version is below the floor in
`turbo/apps/api/src/lib/web-client-compatibility.json`. The general floor does
not reject a missing or unparseable `X-Client-Version`.

An incompatible request receives `426 Upgrade Required` with `Cache-Control:
no-store`. The shared contract client and fetch wrapper turn that response into
a global UI state that displays a non-dismissible update dialog. The dialog's
only action calls `window.location.reload()`. The app therefore forces the user
to choose a refresh before continuing; it does not force the reload without
user action, and an idle page does not discover the requirement until it makes
a handled API request.

The shared database Worker reports the same response to its connected tabs as
a `worker-unavailable` event with reason `force-upgrade-required`. Tabs route
that event through the same update dialog instead of reloading automatically.
Worker load and transport failures reject pending requests with their original
error. The Worker reports no separate connection status: tabs observe transport
health through the outcome of their own requests and subscriptions. Queries and
computed reads have no time limit and remain cancellable through their owning
lifecycle. An IndexedDB version change closes the affected connection and
reports it as unavailable.
These failures propagate through the normal error handling without reloading
the page.

The platform app also registers a service worker. Service-worker code is a
browser-resident deployable surface, so changes to its behavior must account for
old controlled clients during rollout. The current service worker calls
`skipWaiting()`, but it does not intercept fetches or reload clients on a
controller change, so it is not the force-upgrade mechanism.

Raise the minimum supported web-client version only after the corresponding app
build is live. Production promotes API traffic before it promotes the app. If
one release both introduces the replacement frontend and raises the API floor
to that new version, the new API can start returning `426` while the frontend
origin still serves the previous build. A user can then accept the prompt,
reload the same unsupported build, and receive another `426`.

Treat a floor increase as a later cleanup boundary, not as the initial rollout
mechanism. First deploy an API that accepts both protocol versions and a
frontend that starts using the new version. In a later release, after the
replacement frontend is live, raise the floor and remove the old API contract.
This ordering also keeps already-open pages working until the API can direct
them to refresh into a build that is actually available.

The backend must therefore tolerate requests from the previous frontend version
after a backend deployment. When changing an API used by the frontend, keep the
old request shape working until old browser clients can no longer reasonably be
active, or introduce a versioned/new endpoint and migrate the frontend first.

#### Artifact share names and short references

Organization share status returns the same short reference in `url` and
`shortUrl`; it no longer produces a 32-character share-level URL. The `url` field
remains available to clients that consume only that field. New Apps prefer
`shortUrl` and fall back to `url` when talking to an older API. An older policy
without a short reference returns null for both fields until an explicit share
action allocates the alias; opening the menu does not mutate a share. Previously
copied organization references retain their membership and policy checks.

The R2 policy fields `organizationReference` and `publicSlug` are optional, so
old policies remain readable. The immutable reference index and public alias
registry survive an older writer dropping those optional fields. Current APIs
reuse the same organization index and retain the legacy public-token registry
entry. Named public sites use the existing generic Worker publication reader;
they require no database migration or new Worker routing format. Current APIs
must serve short-reference resolution before Apps begin copying those links.
Serving and rollback APIs must support the reference formats emitted by the
enabled writer.

The compatibility scope preserves the explicitly requested existing links;
`privateArtifacts` being non-GA does not independently require a rollback bridge.
Issue [#32492](https://github.com/vm0-ai/vm0/issues/32492) owns later retirement:
the optional response reader can be removed once older APIs leave serving and
supported rollback targets. The long organization URL writer is retired by
the explicit short-reference change. Durable-link readers and aliases remain
until a separate retirement decision accounts for the stored references; a
deployment or App floor alone cannot invalidate links already copied by users.

The iframe loading correction spans the App's explicit first-party iframe
referrer policy and the host Worker's same-origin resource policy. Both must be
deployed to verify full HTML resource loading against the hosted-domain WAF.
The viewer and sharing use the existing `privateArtifacts` rollout switch.

#### Artifact sharing controls and public references

The App separates permission changes from copying and retains the existing
`privateArtifacts` switch. Owner status is read from the existing owner-only
endpoint; a resolved recipient with status 404 copies the original reference
without writing a grant. Existing share responses and public delivery URLs
remain supported for older Apps.

The additive, unauthenticated `GET /api/artifact-references/:reference/public`
returns a currently published delivery URL and `preview: { filename, contentType }`.
Private, organization-only, revoked, missing, and unselected version references
return 404 without metadata. Public copies use the same App reference as
organization copies. The App renders public previews inside that address and
shows its access page on 404; sign-in is an explicit action on that page.

Deploy the API with preview metadata before the App that consumes it. The
existing `url` field remains unchanged for older Apps. This is an iteration of
the non-GA `privateArtifacts` feature, so the new App does not carry a tolerant
reader for an API lacking the preview metadata. No database or host Worker
protocol change is required. Previously copied URLs remain valid under their
existing policy. Owner resolution of an old organization alias continues after
switching it to Only me; recipients lose access.

#### Hosted-site publication identity

`--site` names a site, and a site accepts repeated publications. A prepare first
looks for a live site in the caller's organization, chat scope and publication
brand whose `requestedSlug` matches, and redeploys it. Redeploying replaces what
a site serves, so only the site's creator may do it; organization membership
alone never carries that authority, and another user receives an actionable
`409 CONFLICT` instead of taking the name. A name owned at organization scope
stays unavailable to a chat, as before.

Without a match the allocator creates a site: the first candidate keeps the
preferred name in `slug`, `publicSlug` and `requestedSlug`, and later candidates
add a four-character hash and own that resolved name. A conflicting insert is
re-read by requested name and then by resolved name, so the retry adopts the
site this scope already owns instead of creating another one. A name reserved by
a deleted site therefore resolves to one stable suffixed site rather than a new
site per publication. Atomic inserts and the existing unique indexes arbitrate
concurrent requests; an exhausted bounded retry returns an actionable
`409 CONFLICT`. No database migration or historical data rewrite runs here.

Each publication is still immutable. It owns its deployment ID, its
`dpl-<deployment-id>` URL, its storage prefix and its share policy, and it
allocates the site's next `manifest.deploymentVersion` under the locked site
row — the version columns retired by #35240 are not reintroduced. The site alias
and the catalog follow the newest ready publication, so uploads that complete out
of order never replace newer content. Completion retries for the same deployment
remain idempotent, and existing authorization checks still govern reads and
completion.

Hosted sites are public publications and no longer take part in private
artifacts. `okou host` always returns the site's public alias, a prepare that
requires a private artifact is refused, and no new `private_hosted_deployments`
row is written. The site alias is therefore the durable address a redeploy
preserves. The App viewer offers a hosted site's link instead of an artifact
permission control, and sharing a conversation keeps a public site URL as a link
rather than copying its bytes into a snapshot. This matches the behavior the
`privateArtifacts` switch already produced when it was off, so an older API or
App serving beside this one stays consistent. Existing private hosted
deployments keep their rows and readers.

Historical named HTML snapshot aliases can be converted to the same rolling
public-site model. A new public upload may replace its own site's `publication`
alias after validating the database owner, site, brand, source deployment,
policy and retained token alias. It publishes the active pointer before changing
the named registry record to `legacy-site`; conditional writes and site/share
row locks preserve unrelated aliases and make interrupted completions retryable.
An older completion also retains a newer R2 pointer if a previous database
transaction failed after publishing it. The named URL and its download both
follow the active deployment; `dpl-<deployment-id>` URLs remain immutable.

The HTML delivery registry now bypasses the Worker's former 24-hour cache,
including entries warmed by an older Worker. Deploy that Worker and the API
writer change, and drain older serving API instances, before running the
[bounded historical pointer migration](../turbo/packages/db/scripts/migrations/018-hosted-publication-pointers/README.md).
The migration bootstraps the currently public snapshot without changing its
bytes or presentation kind, verifies one canary before the remaining sites,
and has no schema migration. Production execution uses an explicit reviewed
site list and a private saved plan; public Actions artifacts contain only
aggregate results. Deployment of this code does not run the migration.

Old HTML share writes to Public or Organization return an actionable `400`;
owner revocation remains supported. Snapshot policies lose only their named
`publicSlug` during conversion, so the retained token still reads that snapshot
and can be revoked independently of the public site. A fresh owner upload may
replace its own revoked snapshot alias without reviving the token, but the
historical bootstrap refuses revoked snapshots. File sharing is unchanged.
Do not restore the older HTML snapshot writer after conversion: it can claim
the named alias again or reject a redeploy. Roll forward with these ownership,
token-reader and registry-cache fixes retained; never revert a migrated alias
after its site has accepted a newer publication.

Delivery caches accordingly. HTML documents are served `no-store` on public
aliases, private previews and shared snapshots, because a redeploy replaces them
under one address. Every other path keeps its existing policy, so prepare rejects
a non-HTML file whose name carries no content hash, and rejects a path that an
earlier publication of the same site published with different bytes. Both
rejections return the rename instructions in their message. Protocol-fixed root
paths such as `/robots.txt`, `/favicon.ico` and `/.well-known/*` are exempt from
the name rule. Historical publications are not revalidated; the rules apply to
new prepares.

Older pinned CLIs can consume the allocated `publicSlug` and URL through the
unchanged response shape. The CLI retains the legacy `--slug-suffix` request field
for older API servers; the new API assigns suffixes automatically. An older API
serving beside this one publishes new sites for a reused name instead of
redeploying, which produces extra sites but never replaces existing bytes. Issue
[#35240](https://github.com/vm0-ai/okou/issues/35240) owns later removal of the
site-version model after preserving existing links and metadata.

The [version-retirement preparation](database/hosted-publication-retirement.md)
removes version operations from the current CLI and version comparison from App
sharing. It replaces new-publication counter allocation with fixed compatibility
values and binds immutable public content by deployment ID. Legacy API history,
selectors, old upload completion and schema fields remain until the documented
consumer, data and rollback gates; no physical schema cleanup runs in that step.

The subsequent runtime cleanup reads retained historical versions from manifest
metadata and derives the active version through the fixed public deployment ID.
Its runtime Drizzle mappings omit the four relational version fields from every
implicit selection and insertion. A guarded SQL migration normalizes the
metadata from the old authoritative columns, rotates changed manifest CAS hashes,
and keeps outgoing API readers working with temporary defaults and a pointer
projection trigger. IDs, stored byte paths and share policies do not change.
See the [runtime retirement matrix](database/hosted-publication-retirement.md#runtime-version-column-retirement).
The separately gated physical-drop migration removes the four columns, their
two old indexes and the projection trigger/function. It verifies the retained
manifest versions, public bindings and persisted SQL dependencies before
dropping anything, and preserves content rows and share identities. This
contraction remains draft until the runtime cleanup has shipped in its own
production release and its predecessor has drained. The contraction installs
that runtime transition's canonical main commit as the API rollback floor in
the main-owned resolver before the physical drop deploys. Its API-only floor
does not constrain the independently retained Runner tag. A migration journal
entry cannot prove this serving/rollback boundary.

The earlier query-parameter checksum design was not deployed: development R2
accepted different bytes under that signed URL, so it did not establish byte
immutability. The root `/manifest.json` path is reserved for the server's
delivery manifest. Database manifests may carry `immutableContent: true`, which
the API copies into server-issued preview grants, but the marker does not
prevent a holder of a still-valid direct PUT URL from replacing object bytes.
Do not infer storage immutability from cache eligibility; see #37241 above.
Completion of older drafts does not add the marker.

The host Worker uses the shared `PRIVATE_ARTIFACT_CACHE_CONTROL` for successful
private previews of marked deployments and immutable organization snapshots.
It retains `private, no-store` for unmarked deployments, authorization errors,
and standalone publication responses that must recheck the current share policy.
New APIs with older Workers remain conservatively uncached; new Workers with
older API grants likewise retain `no-store`. The optional manifest field is
preserved by older completion readers without a schema migration. Immutable
delivery derives HTTP headers from the manifest, so replayed upload credentials
cannot change presentation through unsigned object metadata.

Retiring the unmarked-deployment path belongs to #35240: legacy content must
first become immutable through migration or sealing after its last upload
credential expires, older writers must leave serving and supported rollback
targets, and old preview grants must finish their lifetime.

Thread HTML cards, links and attachment viewers reuse the existing preview
signals as images do. No expiry-driven re-resolution or retry is added. A
48-hour credential controls new network access; the browser may keep already
cached bytes for the configured cache lifetime. Iframe remounting still restarts
the document, and catalog reload behavior is unchanged.

#### CLI artifact content reads

`GET /api/artifact-references/:reference/read` requires `artifact:read` and
authorizes content using the same owner, current organization membership,
public publication, revocation, and selected-version rules as the App viewer.
It returns `{ url, filename, contentType }` for the authorized delivery. The
existing typed owner resolver and sharing-management endpoints retain their
owner checks.

The additive `GET /api/artifact-references/:reference/download` uses the same
`artifact:read` and visibility boundary. It returns either
`{ kind: "file", url, filename, contentType }` or
`{ kind: "html", site: HostedSiteFilesResponse }`. The latter includes the full
authorized deployment manifest and per-file delivery URLs. Shared sites use
the selected version's immutable snapshot, rather than the owner's latest
deployment. Standalone HTML uploads remain file downloads.
Conversation references selecting a non-HTML hosted file also retain their
single-file bytes and MIME type; HTML/page references return the full site.

`okou artifact download` and `okou web download-file` use the download endpoint
for short and long artifact references, including same-origin App URLs. For
sites, `--out` now names a new or empty directory and the JSON result adds
`fileCount` and `entrypoint` to `{ path, mimetype, size }`; `path` denotes that
directory and `size` totals all downloaded files. They fetch delivery URLs
without forwarding the agent token. Raw file IDs and authenticated web download
URLs keep their existing `file:read` path and output shape.

`okou host clone` uses the additive
`GET /api/artifact-references/:reference/files` for artifact references. This
returns `HostedSiteFilesResponse` through the same visibility resolver and
retains the existing `host:read` capability; it rejects standalone files.
Hosted URLs and slugs continue to use the existing `host:read` files endpoint,
whose authorization now follows current site visibility rather than requiring
ownership. An optional `hostname` query disambiguates public aliases against
the configured hosted domains. The existing files response remains compatible
with older clients. Version requests never bypass the selected shared version.
Public conversation resources follow their live shared-thread policy and
independent snapshot, including after the original artifact changes.
Bare canonical slugs preserve owner/latest-version cloning; explicit public
URLs follow the selected publication, including for owners and after revocation.
Owner-only management and version-listing endpoints remain unchanged.

Deploy the additive API endpoint before selecting the matching CLI artifact.
Older pinned CLIs retain their existing download behavior against the new API;
the existing read endpoint continues to return entry-page delivery metadata.
The new CLI needs the download endpoint and the existing `artifact:read` capability,
issued under `privateArtifacts`. No tolerant reader for an older API, new
capability, database migration, visibility change, or Worker protocol is added.
Keep the endpoint in serving and supported rollback APIs while runs pinned to
the new CLI remain active.

#### Private attachment uploads

Private artifact URL fields and API creation responses use the configured
`APP_URL` origin. Production stores and returns
`https://app.okou.ai/artifacts/<reference>` for generation, upload, hosting,
media-download and preview-image records. Integration upload completion (Teams,
Telegram, Feishu/Lark, AgentPhone and GitHub), Slack canonical publication and
the Artifact Catalog therefore carry that same complete URL. Public CDN,
hosted-site and external URLs retain their original bytes, including query
strings.

Migration `1167_private_artifact_absolute_urls` prefixes the production App
origin onto hostless private URLs in the canonical file, hosted deployment,
generation, Social and catalog projections, including catalog logical keys and
thumbnail URLs. It changes only values beginning with `/artifacts/`; public and
external URLs are unchanged. `privateArtifacts` remains staff-only, so this is a
direct data cutover rather than a dual-write or rollback bridge.

The CLI retains its idempotent normalization at the presentation boundary for
older APIs: complete URLs pass through unchanged, while a hostless response is
qualified with `OKOU_APP_URL` (or the existing API-to-App origin mapping). Image
batch waits apply the same presentation rule without rewriting batch files.
CLI download, generation-input and clone readers continue to accept hostless
references and absolute references from the same App origin. Existing App thread
readers likewise resolve both forms through the authenticated artifact endpoint;
new stored and emitted values use only the complete form.

New private artifact creation allocates a ten-character version-2 R2 reference
index and stores the reference in file metadata or the hosted deployment URL.
Organization sharing reuses that version reference. Readers retain the existing
32-character owner URLs and version-1 organization indexes. These are durable
links, not a rollout cache; #32492 owns retirement only after accounting for
stored and previously copied links. Files without `metadata.artifactReference`
retain their original long URL, and no bulk rewrite or database migration runs.

CLI owner resolution adds optional `kind=file|html` to the existing reference
endpoint. Each mode requires its existing read capability and denies recipient
access; generation inputs, owned-site cloning, and older pinned download
commands use these modes. Current download commands use the content-read
endpoint described above. Deploy the matching API and CLI before relying on
short references. Existing file IDs and deployment IDs remain valid.
An older API cannot resolve new version-2 indexes; keep capable readers in
serving and rollback targets once the new writer is enabled.

Thread resource records and policies accept both new ten-character tokens and
persisted 24-character tokens. New registry records also bind `targetId` before
publication; old records continue to resolve through their parent policy. Deploy
the host Worker with the tolerant schemas before the API emits short snapshot
links. An older Worker rejects the new records, failing closed. Original files,
snapshot bytes, revocation policies, and rollout-switch defaults are unchanged.

The API accepts the previous attachment prepare request without `purpose`, and
selects private storage from the existing `privateArtifacts` switch. The current
App completes a private single PUT before exposing a ready attachment; multipart
completion finalizes the ownership record on the API. Older composers omit the
single-upload complete call, so authenticated reference resolution verifies the
owned object with HEAD before signing it. An incomplete multipart upload has no
readable object. This previous-App bridge can be removed only after a later App
floor excludes those composers; #32492 owns that retirement.

Storage reads are independent of the rollout switch. Historical public objects
and canonical `accessLevel: private` records without a versioned storage marker
remain public objects; new private IDs never fall through to public storage.
This is a durable-data compatibility boundary, with no bulk migration in this
change. Template records select storage from their persisted source/page key
namespace, and Social job snapshots use an optional `privateArtifacts` field
(absent means the historical public mode). These readers must remain until the
corresponding persisted records have been migrated or explicitly retired.

Integration upload and Social responses use the existing stable `/artifacts/`
reference format for new private files. API, App and CLI consumers must support
that format before enabling the cohort; existing public response values are
unchanged. Signed provider/preview URLs are issued on reads and are not stored as
the durable file identity. No database migration, force-upgrade floor, Worker
protocol change, or infrastructure change is introduced here.

#### Connector App retirement

The first singleton-free connector App release is `0.843.1`, built from
`3795939e97660ef4228122a57e3f6425b1e413c2` and promoted on
2026-09-05 at 04:24:28 UTC after #29773 / #31780. Issue #29775 raises the API
App floor to that version in a later release. Verify the deployed artifact,
not only the GitHub deployment's moving-main SHA: the preceding `0.843.0`
release deployed `30aadb42008af91a999faac6170262dd1de881cb`, which predates
the connector producer cleanup.

Older identified App bundles receive `426` before route handling and use the
existing update dialog to refresh into the supported App. This applies to
all handled App API requests, not only connector actions; idle pages are not
automatically refreshed. No passive browser-expiry window or rollback gate
is required for #29775.

The floor does not retire CLI, unidentified, or missing/unparseable-version
requests. Keep singleton request and persisted authorization-state decoding
until their independent gates pass. The later API artifact
`9def066b4f04898a173da14407a10dc6a0cf66e1` (`api-v1.548.1`) enforced the App
floor on 2026-09-05 at 05:52:29 UTC. The pre-cutoff production request evidence
on #29775 is not proof that account mutations were exercised or stored callbacks
have drained.

For #29776, the explicit retirement decision on 2026-09-05 invalidates all
remaining `single-account` authorization attempts, without waiting for natural
completion or requiring a terminal status. Migration `1078` deletes only rows
with that mutation intent from `connector_oauth_states`,
`connector_oauth_device_authorization_sessions`, and
`connector_external_code_sessions`. It preserves explicit `add` / `reconnect`
attempts and does not delete connected accounts, credentials, or permissions.
An old callback or poll that can no longer find its state uses the existing
missing/invalid response; the user must start a new connection attempt.

Deleting a row does not universally cancel requests that already loaded it or
revoke an account they already created. Keep current request and stored-state
decoders in the cleanup release. The normal migration transaction and timeouts
apply; a failed cleanup blocks release and rolls back. #29777 removes the
remaining singleton contract only after this migration release succeeds.
Investigate unexpected new singleton writes rather than adding a cleanup loop.

#### Slack connector OAuth rollout cleanup

The combined Slack integration and user OAuth flow from
[#33421](https://github.com/vm0-ai/vm0/pull/33421) first shipped in App `0.887.0`
and API `1.584.1`, release
`9ce193854ab828baeec40579a6d36cdf2d4dbf73`. Its
[API promotion](https://github.com/vm0-ai/vm0/actions/runs/34578216432/job/103198883138)
completed on 2026-09-11 at 08:30:58 UTC, followed by
[App promotion](https://github.com/vm0-ai/vm0/actions/runs/34578216432/job/103199718280)
at 08:33:05 UTC. App `0.886.0` still omitted `requestUserScopes`.

On 2026-09-15, production App HTML identified App `0.899.2` from
`05af5a0fe3cdbd9188a9b3d66545bab2dab2a834`. Its
[API promotion](https://github.com/vm0-ai/vm0/actions/runs/34940290360/job/104290489082)
completed at 07:25:09 UTC with API `1.603.2`, followed by
[App promotion](https://github.com/vm0-ai/vm0/actions/runs/34940290360/job/104291320762)
at 07:27:07 UTC. The canonical rollback resolver already requires
`PREPARED_DOMAIN_TRIGGER_RELEASE`
`eb2f211a9af41450d0d5dad10c0c8ad12fac0a24`, which contains #33421. Pre-OAuth
APIs are outside the supported production rollback boundary without adding a
new rollback restriction.

Cleanup [#34306](https://github.com/vm0-ai/vm0/pull/34306) raises the App floor
from `0.873.0` to `0.887.0` in this later release, after the replacement App is
live. Identified App versions below that floor receive `426` before route
handling and must refresh on their next handled API request. Idle pages are
not reloaded automatically. This affects all handled App API requests. An App
rollback must also remain at or above `0.887.0` while this floor is enforced.

Slack Connect requires `requestUserScopes: true` and returns only
`202 { authorizationUrl }` on success. The App follows that URL; connection
binding and notifications happen after the existing OAuth callback verifies
the grant. The direct-connect branch, its response shape, and rollout-only
tests are removed. Existing callback identity, workspace, membership, and
single-use-state checks remain in force.

The floor does not exclude non-App callers or missing/unparseable versions;
they can use the same canonical OAuth request. Authenticated requests without
`requestUserScopes: true` receive the contract's `400` validation response.
Current repository production code has one caller, the App, which already
sends that field; no CLI caller was found. The complete retained 72-hour
request-log query ending 2026-09-15 at 07:14:20 UTC contained one POST: App
`0.893.2`, response `202`. It found no non-App or unidentified POST; this is
bounded caller evidence, not a guarantee about every external client.

#### Organization member display queries

`GET /api/org/members?view=members` retains the existing organization summary
and current-member profile shape while omitting invitation and membership-request
data and their provider reads. The Agents page uses this view; organization
management keeps the full default response. Membership authorization, profile
cache lifetime, batching, and missing-creator presentation are unchanged.

Old Apps omit `view` and receive the full response from a new API. New Apps can
also consume an old API: its query-less route ignores `view` and returns the
same member shape, with the previous management-read cost until the API updates.
No temporary fallback, App version-floor increase, migration, or Runner protocol
change is required.

### Backend

The backend is the compatibility boundary for both frontend and runner traffic.
In the production release workflow, app promotion starts after the API
production lifecycle completes, including any required migration and API
traffic promotion. Newly loaded frontend code therefore follows API promotion,
while already-open browser pages can keep running the previous frontend against
the new backend. Runner promotion still waits for API promotion when the same
release also changes the API. Old runners keep draining against the new backend,
and traffic promotion is not an atomic process visible to every client at the
same instant.

Production database migrations are part of the API release lifecycle and run
before the new API deployment is promoted. Old backend code can therefore
briefly run against the migrated schema. Migrations must be backward-compatible
with the currently deployed backend until that backend is no longer serving
traffic.

Migrations marked with `-- vm0:non-transactional` run one statement at a time
outside a transaction. Successfully executed statements are not rolled back
after a later failure, and the entire migration runs again on retry, so every
statement must be idempotent under a full retry from the beginning. Migration
`0778` demonstrates the required pattern with
`DROP INDEX CONCURRENTLY IF EXISTS` followed by `CREATE INDEX CONCURRENTLY`.

This is a traffic-promotion guarantee, not a guarantee that no deployment
preparation has happened yet. Staged Vercel builds, runner rootfs/snapshot
builds, host provisioning, and other non-serving preparation jobs may complete
before migrations run. API traffic promotion must wait until the required
migrations have completed. App promotion waits for the API production lifecycle,
including its migration and traffic promotion. Runner promotion waits for API
promotion when the same release changes the API.

Backend changes must be safe with:

- old frontend -> new backend
- new frontend -> old backend
- old runner -> new backend
- new runner -> old backend, if traffic propagation or non-production
  deployment order can expose that pairing

#### Pro-suspend plan retirement

Migration `1177_retire_pro_suspend_tier` rewrites persisted `pro-suspend`
organization tiers, pending cancellation targets, and entitlement snapshots to
`limited-free-1`. The entitlement rewrite applies the complete canonical
limited-free capability set and active status while preserving balances,
subscription and period fields, source metadata, and other billing provenance.
Validated constraints prevent the retired value from being persisted again.

The outgoing API already writes `limited-free-1` for cancellations and can read
the migrated state, so it remains compatible while the migration runs before
API promotion. The current App emits only `limited-free-1`, and current API
responses never expose `pro-suspend`. Three input-only compatibility aliases
remain. A new API still accepts the previous App's cancellation request literal
and normalizes it before service execution; Stripe setup completion applies the
same normalization to checkout metadata created before the rollout; and the
replacement App normalizes a `vm0:billing:downgrade-payment-pending`
sessionStorage entry that the previous build wrote before redirecting to
Stripe. None of them is an organization tier or a stored plan value.

Remove the App-request alias only after the replacement App is live and the
web-client floor excludes the previous build. Remove the Stripe metadata alias
only after every setup Checkout Session created by the previous build is
terminal or expired. Remove the sessionStorage alias only after every tab
session started on the previous build has ended; sessionStorage cannot outlive
its tab, so that window closes once the replacement App is live and no
pre-rollout tab remains open. No alias permits the retired value to pass the
persistence constraints.

### Version-addressed CLI artifacts in the runner rootfs

Every CLI package carries mandatory `okouBuildIdentity` schema 1 in its packed
`package.json`: Pi runtime version, Pi SDK version plus the first-party patch-set
digest, and session-construction digest. The existing package `version` identifies
`@okouai/cli`. The artifact producer derives `manifest.json` identity from those
packed bytes, not a later workspace read. Native verification and Runner
compilation reject missing identity or disagreement with the external identity;
there is no legacy-package reader or compatibility fallback.

A release additionally publishes the release commit's artifact at
`okou-cli/v<versions.cli>/`. That path is immutable: the publish step fails the
release when the version already exists with different bytes. New package bytes
require a new CLI version through the existing CLI-to-Runner release dependency;
never overwrite a versioned object or redirect a historical package URL.

A Runner compiled with an embedded CLI bundle installs its verified
`package.tgz` into the rootfs customize layer at
`/usr/local/lib/okou-cli/<version>/`. A build-only native module inside Runner
validates the external inputs and generates installed metadata through the
existing `guest-contracts` schema. Compilation snapshots the exact verified
package buffer and generated `installed.json` into embedded resources, with SHA
and version from that same buffer; it does not embed a subsequently reread input
path. `runner build` only stages those trusted compiled bytes alongside the
embedded Guest binaries. It does not reparse the archive, compare identity,
rehash or recheck size, or regenerate installed metadata. The installer writes
`/usr/local/bin/okou` and `/usr/local/lib/okou-cli/installed.json`. No new CLI
package crate or runtime decoder is needed. The CLI contributes only its actual
build-verified package SHA-256 to the local rootfs hash. Installed metadata remains
determined by that package and the fixed installation recipe; `verify-rootfs.sh`
and exact cached-sidecar comparison still validate it. Local rootfs cache version
3 isolates this recipe. Changes to fixed installed schema, serialization or paths
must rotate that version; shared template and snapshot versions are unchanged.
This hash change does not remove installed metadata or change guest launch selection.

New Runner binaries no longer accept `--okou-cli-artifact DIR`, and current
release/preview orchestration does not stage a separate host CLI artifact. A
local Runner compiled without embedded resources can still build a CLI-free
rootfs with explicit Guest binary paths; Pi then uses the task's captured
`CLI_PKG_URL` through `npx`. Already-deployed older Runner binaries retain their
historical host-artifact option until replaced. Neither that old binary behavior
nor the Guest's commit-addressed runtime fallback is removed retroactively.

Compatibility is negotiated per run rather than by deployment order:

- The captured execution context carries `piInstalledCliRequirement`, forwarded
  by the Runner to the Guest. Its runtime version, minimum CLI version and
  session-construction digest are separate from the strict `piLaunchConfig`.
- `PI_SANDBOX_INSTALLED_CLI_MIN_VERSION` remains `9.370.3`. The Guest uses an
  installed CLI only when its manifest satisfies the captured launch-payload
  floor and runtime/session identity; otherwise it uses the run's
  commit-addressed `CLI_PKG_URL`. New releases do not automatically raise the
  compatibility floor.
- `requiredPiSessionConstructionDigest` is a build-time SHA-256 over the
  code-determined session construction that `@okouai/pi-agent-runtime` commits
  in `session-construction-digest.json`. CLI artifact manifests carry it as
  `sessionConstruction.digest`, and Runner builds copy it into the installed
  manifest. It changes when session-construction inputs change, independently
  of dependency-only runtime version bumps. The current rollback resolver's
  independent floors already exclude APIs predating this context contract.
- Official Runner binaries embed the source-bound CLI package alongside their
  Guest binaries. A local full rootfs build without a bundled CLI remains
  possible; neither preview nor production image preparation downloads a
  separate CLI artifact onto the Runner host. Production Runner compilation
  reuses the release target's verified canonical Turbo CLI package and manifest
  retained by the versioned publisher; it does not rebuild CLI independently.
  The guest agent execs only the installed CLI on a parity match at or above the
  CLI floor. When the launch config carries
  `requiredPiSessionConstructionDigest`, parity means the installed manifest's
  `sessionConstruction.digest` is identical, and an installed CLI without a
  digest fails parity; otherwise parity means the installed `piAgentRuntime`
  equals `requiredPiAgentRuntimeVersion`. The installed `cli` must be at or
  above `minCliVersion` in both cases. Missing or incompatible installed
  metadata selects the existing `npx` path using the task's API-captured
  `CLI_PKG_URL`, not a moving latest package. A missing package URL on that
  path still fails the run explicitly.
- The runner advertises the installed versions as an optional `installedVersions`
  field of the claim body. Older backends ignore it; the current backend records
  it in claim telemetry as `runner_installed_cli_version` and
  `runner_installed_pi_agent_runtime_version`. The optional
  `piSessionConstructionDigest` member is advertised when the installed
  artifact has a digest. The backend records it as
  `runner_installed_pi_session_construction_digest`; older installed artifacts
  omit it.
- Parity is checked by the Guest before spawning the CLI. A parity miss selects
  the task's captured package rather than changing the restored session or
  executing the incompatible installed bundle. The sandbox CLI opens the
  restored session through the official RPC host; no digest-based H0 restart
  is performed by that CLI path.

An old backend that omits the installed-CLI requirement keeps using the
captured `CLI_PKG_URL` through `npx`. Queued contexts requiring a newer or
otherwise incompatible CLI also retain this path rather than executing the
incompatible rootfs install. The installed CLI is a parity-checked fast path,
not an admission requirement; retaining the existing fallback avoids failing
runs solely because API and Runner releases differ. Network/package failures
on the fallback can still fail a run, and production rollout verification is
still required. Continue raising `PI_SANDBOX_INSTALLED_CLI_MIN_VERSION`
whenever a launch-payload or handoff field becomes required.

### Commit-addressed CLI artifacts

The private CLI used inside supported runs is published as an immutable,
commit-addressed package. When the backend creates run execution context, it
records the configured package URL in `CLI_PKG_URL`. A queued run therefore
keeps the CLI artifact selected at context creation even after a later backend
deployment starts selecting a newer package.

Treat the package commit as the release identity for protocol compatibility.
The package's semantic version may remain unchanged across artifacts and must
not be used as a compatibility floor unless the release process guarantees that
it advances for every relevant artifact change.

When removing a backend response or request variant consumed by the CLI:

1. Deploy a backend that still supports both variants and starts selecting the
   canonical commit-addressed package.
2. Wait through the maximum queue lifetime plus the maximum claimed execution
   and finalization lifetime for contexts created before that deployment.
3. Confirm that no queued or active pre-deployment context, and no explicitly
   supported external caller, can still use the old variant.
4. Remove compatibility in a later backend release.

Presentation runbook content is independent of the CLI release after the
current-template download route is deployed. Current CLIs send only the
resource id and receive the canonical storage HEAD; older CLIs keep using the
existing digest-pinned route and its immutable archive. Publish new template
HEADs only after the current-template route and CLI are in production.

This drain is separate from runner binary drain: a current runner can execute an
older CLI package retained by an older execution context. If the same cleanup
raises the frontend compatibility floor, rolling the frontend below that floor
also requires rolling back the backend floor. Rolling the backend back to the
dual-protocol preparation release remains safe for canonical clients.

#### Instagram nullable views

Instagram stats preserves provider `views` as a nonnegative integer, null, or
omitted for every caller, without capability-header negotiation. Zero is a
verified count; null is unavailable and is never converted to zero. Engagement,
author data, extensions and the existing provider-identity redaction boundary
remain unchanged. The optional `requireViews` input requests the provider's
bounded recovery. Its documented missing-view HTTP 503 returns without managed
billing or automatic retries.

The [#34047 retirement receipt](https://github.com/vm0-ai/vm0/issues/34047#issuecomment-5676398885)
records the first capable API release, `api-v1.597.0`, promoted on September 14,
2026 at 13:54:04 UTC. That release selected the immutable CLI artifact
`1c1d6963d034592bc9b3ca671f5f9475c2314234`. On September 15, after the queue,
execution and finalization window, the operator explicitly confirmed both queues
empty, all pre-cutoff runs finished, and no supported independently pinned older
CLI caller. This is operator-confirmed drain, not an automated database census
or an inference from runner versions alone.

- Capable pre-cleanup CLI -> canonical API: nullable results remain readable;
  the old capability header is no longer needed.
- Headerless CLI -> canonical API: null, omitted, zero and positive views stay
  distinct.
- Headerless CLI -> capable bridge API: null is temporarily omitted but remains
  readable; strict lookup remains supported. This also applies to rollback to
  the bridge API until the canonical API serves again.

Pre-reader CLI artifacts are outside the confirmed supported caller set. This
cleanup changes no persisted format, Runner protocol, or other social operation.

### Instagram search collection limits

Instagram Reels Search exposes one anonymous batch of up to 12 results. The
request accepts only page 1 and a query of at most 100 characters after trimming.
Keyword, hashtag and encoded leading-hash inputs share normalization. The CLI's
request preserves case because Unicode case folding can expand a validated
100-character input; the provider performs its documented lowercase conversion.
The CLI's `--limit` truncates returned items locally; it does not request more
source coverage or forward the OpenAPI's unbounded `limit` parameter.

Search responses retain the existing `provider_limited` collection state and
`provider_ceiling` reason, adding optional
`sourceLimit: { kind: "single_batch", maxItems: 12 }`. Empty and short batches,
including `hasMore: false`, do not establish exhaustive search. The provider's
`count` describes the batch and is not a reported global total.

Retained CLI response schemas accept these existing discriminants and ignore
the new optional field. The API owns source-limit normalization; public projection
preserves its canonical metadata. Aggregate and streamed terminal output preserve
the source limit; `callerLimited` independently
records whether the fetched batch was trimmed. `status: complete` still means
the caller's requested count was satisfied, while collection state describes
source completeness. Unsatisfied source-limited requests remain partial.

The old-API metadata projection is retired by
[#34053](https://github.com/vm0-ai/vm0/issues/34053), using the following
production and supported rollback evidence from 2026-09-15:

- Writer commit `e43a677e7508192b61801356f234dbcf231a0fbe` (#34067) first
  shipped in API 1.596.0. The [API 1.603.2 production promotion](https://github.com/vm0-ai/vm0/actions/runs/34940290360/job/104290489082)
  checked out and built `05af5a0fe3cdbd9188a9b3d66545bab2dab2a834`, which
  contains that writer, and published the production alias at 07:24:43 UTC.
- The existing rollback resolver requires
  `eb2f211a9af41450d0d5dad10c0c8ad12fac0a24` (API 1.600.1) for prepared
  domain writers. That release already contains the Instagram writer, so every
  supported rollback target emits canonical source-limit metadata. The rollback
  workflow loads the resolver from current `main`.

No response variant is retired and no CLI drain, schema migration, or additional
release floor is required. Old CLI -> current API remains readable. New CLI ->
supported rollback API preserves the same single-batch metadata. Pre-fix APIs
are no longer repaired by the new CLI; historical fixed deployment URLs or a
manual bypass of the official rollback workflow are outside this boundary.

### Social download accounting and media metadata

Social download admission uses the caller's maximum duration rounded up to
started minutes and the requested format/quality tier: audio and SD video use
one provider credit per minute; 720p/1080p video uses four. TikTok ready jobs use
the delivered tier, capped at the requested tier, so a 720p request delivered at
576p uses the SD rate. The default request remains 720p. These are **provider
usage units**; managed usage applies the separately configured Okou retail
price to the validated actual `creditsCost`, once per download job.

The [provider API overview](https://docs.socialkit.dev/api-reference#credit-costs)
documents a 30-day legacy-account pricing transition. Admission conservatively
uses current published tiers, while settlement accepts only the exact current
cost or the prior one-credit-per-minute cost from the authenticated ready job.
It does not assume the production account's transition date or bill the
preflight maximum. Remove the legacy allowance only after verifying the managed
account's transition and that no recoverable historical jobs need the old rate.
Parent [#34056](https://github.com/vm0-ai/vm0/issues/34056) retains these
unverified provider-account and historical-job gates. Its response-only child
[#34320](https://github.com/vm0-ai/vm0/issues/34320) removes the separately
drained old-API normalization described below; it does not remove legacy rates.
An explicitly unbilled ready response is rejected. Polling headers may report
zero new usage on a paid-link refresh; the original job cost remains authoritative.

The response fields distinguish media intent from delivery evidence:

- `quality` and `format` remain request aliases for older CLI artifacts;
  the required `requested` block explicitly contains those same values.
- `provider.quality` and `provider.format` preserve the accepted ready metadata.
  Provider-reported resolution accepts renditions such as `576p`, independently
  of the finite request-quality choices. It is not a byte-level resolution
  measurement.
- `artifact.format` records the byte-sniffed MP4, M4A or MP3 type, or null when
  unrecognized. `delivered.format` uses only that evidence. Existing filenames
  and content types may be request-derived and are not used to infer it.
- `delivered.quality` uses stored provider reporting and is null for audio.
  The `delivered` block is required, but both members remain nullable. Missing
  historical delivery metadata remains null. New artifact recovery can establish
  a sniffed format without fabricating missing original quality.

No relational migration or stored-job rewrite is required. Old JSONB writers
legitimately omit the new optional media fields; new readers keep their original
usage and return unknown delivery metadata. Interrupted settlement and paid-link
refresh keep the same job and usage idempotency key. Refresh metadata must match
the original accepted duration and cost, rather than reprice a paid download.

The response-envelope retirement was verified on **2026-09-15**:

- [#34070](https://github.com/vm0-ai/vm0/pull/34070), merge
  `9c55bc983c52f37369576d36eb32fbb0aec94994`, first shipped the unconditional
  create/get/list writer in API **1.598.0**.
- The [API production promotion](https://github.com/vm0-ai/vm0/actions/runs/34940290360/job/104290489082)
  checked out and built `05af5a0fe3cdbd9188a9b3d66545bab2dab2a834`, API
  **1.603.2**, and published `api.vm0.ai` at **07:24:43 UTC**. This is the
  build's release SHA, not the moving GitHub deployment metadata SHA.
- The [rollback resolver](../.github/scripts/resolve-production-rollback-target.sh)
  already enforces `eb2f211a9af41450d0d5dad10c0c8ad12fac0a24`, API **1.600.1**,
  which contains that writer. The [rollback workflow](../.github/workflows/rollback-production.yml)
  loads the resolver from `main`, so a historical target cannot replace the guard.
  No additional rollback floor is introduced.

APIs without these blocks are therefore outside supported canonical serving and
rollback targets. The CLI passes through the API's redacted response without
synthesizing missing blocks. This receipt retires only absent response blocks:
it proves neither a provider-rate transition nor an old-CLI drain, and does not
replace the independent MP3 compatibility requirements below.

| Pairing                      | Supported behavior                                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Old CLI, new API             | Existing request aliases remain valid for mutually supported formats; additional blocks can be ignored.                    |
| New CLI, supported old API   | Writer-capable APIs already emit both blocks, including explicit nulls. No CLI normalization is needed.                    |
| Supported old API, new JSONB | Additive media keys preserve existing required values for mutually supported formats.                                      |
| New API, old JSONB           | Completed jobs remain readable; pending settlement and artifact recovery preserve original usage and unknown media fields. |

#### Explicit MP3 social downloads

`social download --format mp3` requests audio through the existing download
lifecycle. MP4 remains the default, M4A remains supported, and both audio
formats use one provider unit per started minute regardless of video quality.
The provider's ready format must match the request. Artifact bytes still
determine the delivered extension and MIME: detected MP3 is `audio/mpeg`, and
a different detected type is reported truthfully. For unrecognized bytes, the
filename and MIME are request-derived hints (MP3 uses `audio/mpeg`) while
`delivered.format` remains null. Sniffing does not validate an entire media file.

MP3 requests become available when the capable API is deployed, using the
existing authentication, capability, credit and active-task checks. MP3 extends
values inside existing response and JSONB fields. Older API and CLI schemas
reject those values, including when listing tasks that contain an MP3 request.

Coordinate MP3-capable serving, reconciling and rollback API artifacts with
compatible commit-addressed CLI selection and the incompatible queued, active
and finalizing context drain described above. Upgrade supported external
callers that may list or resume MP3 tasks. These compatibility conditions must
be addressed as part of deployment because the new API accepts MP3 immediately.

| Pairing                            | Behavior                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Old CLI, new API, MP4/M4A jobs     | MP4/M4A requests, polling and discovery retain their existing contract.                                                           |
| New CLI, old API                   | MP4/M4A keep working. Explicit MP3 is rejected by the old API; never silently substitute a format or resubmit.                    |
| New API, old JSONB                 | MP4/M4A tasks remain readable/resumable; missing historical delivery metadata stays unknown. No migration or rewrite is required. |
| MP3-capable CLI/API, new MP3 JSONB | Creation, listing, polling and same-job recovery use the widened format contract.                                                 |
| Old CLI/API, new MP3 JSONB         | Unsupported; exclude this pairing from supported deployment and rollback combinations once MP3 tasks exist.                       |

After the first MP3 task is created, rollback must retain MP3-capable readers
for as long as MP3 tasks remain readable or recoverable.

### Pi Gen1 wire-field retirement

[#33966](https://github.com/vm0-ai/vm0/issues/33966) removes only the optional
Gen1 `piModelConfig.api` field. Slice 1
[#32632](https://github.com/vm0-ai/vm0/pull/32632) stopped writing it while keeping
readers tolerant. The [September 14 controller receipt](https://github.com/vm0-ai/vm0/issues/31085#issuecomment-5660026283)
accepted the writer-cutoff release, supported rollback targets, executable
context census, retained callers and Runner/Sandbox/CLI drain. Its
[dispatch admission](https://github.com/vm0-ai/vm0/issues/33966#issuecomment-5660179289)
reconciled all 17 Pi runs among 50 nonterminal runs and both empty queues. These
are dated complete observations, not current counters.

Old cutoff-safe writers and new readers share the field-absent Gen1 shape;
new writers remain readable by the retained cutoff-safe readers. Strict
TypeScript boundaries reject a Gen1 object containing `api`. Rust keeps its
existing general unknown-field policy, discarding unknown fields during decode;
the generated Gen1 DTO no longer represents, emits or retains this key. Gen1
itself, Gen2/3/4, active subscription dialects and upstream Pi `Model.api` are
unchanged. No stored context rewrite, migration, backfill or rollback-floor
change is required or included. Parent #31085 still owns independent acceptance,
release and final production verification.

### Pi native session history

Pi checkpoint persistence shares the Runner's 128 MiB raw and encoded history
bound. The API-first execution budget remains 16 MiB. Before resource loading or
provider ownership, a larger saved checkpoint selects sandbox-first execution
from blob metadata. A V4 ownership-transfer manifest carries a presigned history
reference; only the sandbox downloads and decompresses H0 for the next turn. The
API still validates complete H2 history at checkpoint time, so its peak memory
and validation work can exceed the raw file size. Like Claude and Codex, a
Guest with Pi compact-generation selection attempts to select a 64 MiB-or-less
native JSONL generation when the source exceeds 64 MiB, preserving the session
ID, active context and latest native session name (including an optional name
that clears an earlier title). A compact with no kept pre-compact entries can
start that selected path itself. The Guest replaces its live file only after the
API accepts the checkpoint. If selection or replacement staging fails while the
original still fits within the 128 MiB upload bound, the Guest uploads the
original instead. When the original exceeds that bound, selection
failures (including unknown native record kinds, unsafe opaque extension state,
globally visible labels or retained references) and replacement staging
failures cause the new Guest to fail explicitly rather than send a missing H2
hash. A late bounded-read size failure during a success checkpoint likewise
fails locally. An older Guest can still fail the existing H2 hash check on
oversized Pi files until its running jobs drain. New and old APIs read the
selected native v3 H2 through the existing blob/hash contract; no wire change or
migration is introduced. Rolling back the Guest restores the old oversized-file
failure for new runs, but committed bounded native histories remain readable.

V3 manifests remain the active format for API-produced H1 and small
sandbox-first H0. The CLI accepts both formats and retains the same V2 Guest
boundary control; Runner job and launch-config schemas are unchanged. API and
CLI changes must ship through the same commit-addressed CLI artifact selection.
Previously captured contexts retain their package and history reference; new
contexts select the new reader. Old Runners already support 128 MiB history.

Eligible routes use Pi. Rolling the API back below this change
restores its 16 MiB validation and resume limit: larger saved histories stay in
storage, but continuing those sessions requires the fixed API and CLI again.
That API rollback adds no stored-history rewrite, migration, or alternate reader.

### Pi debug tracing retired (single-release cutover)

The owner requested abandonment of `_langfuseTrace` and complete removal of
its implementation. The originating changes were #33756 (admission, terminal
observation and plugin), #34158 (authenticated relay), #34148/#34215 (trace
links) and #34326 (bootstrap retirement). No debug trace is exported by the new
API or CLI. Ordinary Pi session validation, native tools, memory, model usage,
terminal commits and Axiom/Sentry telemetry remain authoritative and unchanged.
The independent Langfuse connector and immutable release/migration history are
not part of platform debug tracing.

New Platform builds neither render the action nor create its per-run detail
registry. Old Platform builds tolerate the missing optional run-detail URL.
Previously captured CLIs may still attempt the removed relay, receiving 404;
the patched exporter isolates those failures from agent execution. New CLIs
ignore old tracing environment entries and do not load the plugin. Previously
stored switch overrides pass through ordinary registry-key filtering. This
retirement does not delete remote project traces, provider credentials, queued
execution contexts or user-owned connector accounts.

**Database and accepted release boundary.** Migration `1345_outstanding_the_hood` drops
`agent_runs.langfuse_trace_enabled` without rewriting historical migrations.
Migrations precede API promotion. Outgoing APIs explicitly name that column
in launch inserts, run detail reads and completion selections; generic Drizzle
selections/returning can name it too. Disabling the switch does not make those
APIs column-independent. Applying this migration during an ordinary rolling
release would break run creation, reads and completion until they drain.

The owner explicitly accepted this interruption on 2026-10-08 and requested
complete removal in one release rather than a preparatory column-independent
API release. No compatibility branch or outgoing-writer drain prerequisite is
required for this accepted cutover. This is not rolling-compatible: outgoing
API request, cron and completion paths can fail with an undefined-column error
between migration and their retirement. The duration is not asserted to be zero
or bounded by the migration's runtime. Acceptance of that risk permits this PR
to proceed through review, CI and the protected merge queue; it is not an
instruction to execute a production release or any manual production mutation.

The repository rollback resolver rejects commits before this contraction's
first-parent main commit; a rollback below it requires a reviewed forward
migration restoring the column before an older API serves. This floor protects
rollback only; it does not make outgoing APIs compatible with the migration.

### Runner

#### Pi maintenance usage journal retirement

Producer retirement in [#32787](https://github.com/vm0-ai/vm0/issues/32787)
removes the CLI's private usage journal and Guest forwarding. The existing
runner proxy remains the accounting authority established by
[#32639](https://github.com/vm0-ai/vm0/pull/32639). The independent private
checkpoint validation marker remains required for publication.

The API ACK and journal-only contract are retired by
[#32788](https://github.com/vm0-ai/vm0/issues/32788), under delivery parent
[#32783](https://github.com/vm0-ai/vm0/issues/32783). The parent's dated production
receipt records the endpoint-specific gate:

- Producer stop shipped in Runner 0.189.0 / Guest 0.86.22 and CLI artifact commit
  `82d1a6ff154c9ca81fd8e08d6764290733eb324d`. API and Runner promotion completed
  at 07:00:31 and 07:02:02 UTC on 2026-09-09, respectively.
- The 09:05–09:09 UTC fleet inspection found only Runner 0.189.0 and 0.189.1
  services running on prod-11, prod-12 and prod-13. All older services were
  stopped with no active runs or idle/blank sandboxes. The last old reporting
  service exited at 09:00:56.020 UTC.
- Shutdown destroys owned tasks and stops runtime workers. The old Guest's
  awaited journal retries were process-local, with no durable replay queue.
  Deployed Guest versions no longer read or forward journals, and the serving
  API/Runner versions include the proxy-only accounting prerequisite.

New run contexts select the latest deployed CLI. Although a queued context can
retain its creation-time package URL, that cannot restore forwarding in a new
Guest. Once report-capable Guests and their finalization have exited, waiting
for older CLI URLs adds no endpoint-specific protection. The receipt uses
artifact/source/process evidence, not a database queue census or a claim of zero
endpoint traffic; elapsed time and missing telemetry are not the proof.

Rollback to a journal-reporting Guest is explicitly outside this retirement's
approved compatibility boundary. Such a Guest may fail completion against the
removed endpoint. This cleanup does not change rollback workflows or authorize
production operations.

The 122-minute private binding retention starts at terminal settlement to
protect late proxy usage. It remains unchanged, along with ordinary
pending-usage/callback cleanup blockers, provider-result usage, lifecycle
observation and private checkpoint validation.

#### GPT 6 Luna native model readiness

A Runner advertises `X-Native-Gpt-6-Luna: 1` only when its bundled Guest accepts
native `gpt-6-luna` and `openai/gpt-6-luna` work. This capability is separate
from `X-Native-Gpt-6-Sol`: a Sol-capable artifact predating Luna must leave Luna
jobs pending. The API excludes unsupported Luna jobs before the bounded poll
lookup and rejects an unsupported direct claim with `404`, without changing the
queued job. New Runners send both headers, while older APIs ignore the new
header. No stored selection changes; the model is available only through a
member's personal Codex subscription route.

#### GPT 6 Sol native model readiness

Poll and claim requests advertise `X-Native-Gpt-6-Sol: 1` only from Runner artifacts
whose bundled Guest supports GPT 6 Sol and its reasoning efforts. The API checks
this capability after authorizing and validating the stored context, before
claiming native `gpt-6-sol` or `openai/gpt-6-sol` work. A claimant without the
exact capability receives the existing claim `404`; the job stays pending for
a capable Runner. This covers personal subscription routes without changing any
stored selection.

Poll excludes unsupported Sol jobs before applying its candidate limit, so old
Runners can still discover existing models behind a Sol job. Claim repeats the
capability check to cover direct notifications and previously discovered work.

The header leaves the strict claim JSON unchanged, so a new Runner can still
claim existing work from an old API, which ignores the extra header. During
API-first promotion, or a Runner rollback, old Runners can continue executing
existing models but cannot consume Sol jobs. Sol work waits until a supporting
Runner is available. The capability remains necessary while an incompatible
Runner is a supported rollback target; no database migration is involved.

#### Claude Opus 5.5 native model readiness (retired)

The `X-Native-Claude-Opus-5-5` Runner capability and its poll/claim guard were
removed with the expired compatibility cleanup (#37056); every serving and
rollback-eligible Runner accepts Claude Opus 5.5. No API capability guard keys
on `modelUsageProvider`, so a route pricing alias cannot bypass one. A future
model capability guard must key on the run's actual model or captured route,
never on the pricing identity.

#### Runner process drain

Runner deployment is draining, not instant. The production promote playbook
starts the new runner service, verifies it, and then sends a soft-drain signal
to old runner services. Promotion observes a bounded acknowledgement from the
same live process and status generation: Draining/Stopping, or service/process
exit. This acknowledgement does not wait for active runs to finish. Discovery,
signal, status, identity, or acknowledgement failures for an old runner are
reported as promotion warnings while a healthy new runner remains promoted;
promotion does not force-kill the old runner. Before the signal arrives, there
can be a short overlap where both old and new runners are running. After old
runners enter draining, they stop claiming new runs but keep executing already
claimed runs until those runs finish. During that drain window, old runners
continue calling backend APIs with the old protocol.

The backend must support old runner requests until old runners have fully
drained. Runner changes that require backend support must be staged so a new
runner can also survive briefly talking to an old backend.

Rootfs locks are also a host-local cross-version boundary. Every supported
Runner release coordinates through `rootfs-{hash}.lock`, and callers acquire
all rootfs locks before any snapshot lock. A canonical-only release can overlap
and roll back with bridge-capable predecessors through that shared identity.
Keep the rollback floor bridge-capable. Delivery parent vm0-ai/vm0#30478 remains
open until the canonical-only artifact is promoted, bridge processes drain, and
the final fleet verification completes.

Rootfs build scripts retain those same flock descriptions in an external
`unshare --fork` waiter until their private PID namespace has terminated. The
waiter starts in a separate session so owner death cannot orphan a stopped
process group and send it a job-control `SIGHUP` before cleanup completes. The
owning runner's death or cancellation closes a process-local control channel;
namespace init then exits and the kernel terminates its descendants, including
workers behind `sudo`. The waiter must not be killed as a cancellation shortcut:
lock availability is the boundary that allows another builder or GC to touch
staging. In-process shared ownership also keeps the flock and extracted scripts
alive until the blocking spawn-and-wait task finishes. Existing builders and GC
need no new lock file or persisted metadata to respect this exclusion.

This containment applies to scripts launched by the new runner, not orphaned
workers already launched by an older artifact. PID values are namespace-local;
shared build caches must use independently unique temporary filenames instead
of treating a script's PID as a host-wide unique attempt identity. Debootstrap
cache staging uses `.tmp.mktemp.<random>.tar`; new GC recognizes both that format
and the previous `.tmp.<pid>.tar`. Older GC still respects the shared cache lock,
but counts leftover new-format staging files toward stable-cache retention until
it is upgraded (potentially causing a cache miss, not exposing an active build).

Runner and guest binaries are deployed as one runner artifact. Compatibility is
not required between a runner binary and a guest binary from a different version.

Runner archive-size mismatch diagnostics add an optional object to an existing
failed headers operation. New APIs accept old operations without it; older APIs
strip the unknown object while retaining the failed operation. Either deployment
order remains functional, but observing exact byte/source fields requires both
updated artifacts. Byte counts use bounded decimal strings to preserve u64
response lengths through JavaScript. No storage schema, Guest protocol, archive
acceptance or retry policy changes; see [host archive diagnostics](host-archive-phase-diagnostics.md).

The extracted storage cache is a separate, host-local cross-version boundary.
New readers use `storages/<name-hash>/decoded-v1-<version-hash>/` containing an
identity/content index and real files. Existing compressed readers continue to
use their original hashed version directory and `archive.tar.gz`; neither
reader interprets the other format. Selection validates and pins usable extracted
files before archive prefetch, so an admitted hit does not download or publish a
missing compressed entry. New entries use the existing name/version-key flock,
including the final-version lock for `.tmp` staging, so both old and new storage
GC recursively account and evict them with the existing best-effort byte and
entry targets. These targets are not hard disk-usage limits. Directory admission
also bounds each extracted entry's inode footprint.

Unsupported-archive admission records use separate
`decoded-v1-rejected-<version-hash>/` keys under the same GC and lock rules.
Only post-spawn background work reads these records; foreground lookup probes positive
file entries only, so unsupported archives do not pay a rejection-record lock
and read on every startup. Each reader validates its expected entry kind.

For an eligible archive hit, optional decoded warming is omitted when this
plan's existing foreground lookup already validated positive decoded contents,
even if mount or payload admission did not select them for delivery. Eligible
consumers are ordinary storage downloads and fresh, non-empty artifact downloads
with complete storage name, storage ID and version identity plus an archive
source. Instructions, reused paths, empty entries and artifacts without that
complete identity retain archive delivery. This observation belongs only to that
prepared plan and adds no lookup or retained file contents. A missing compressed
archive still selects its required fill; later plans perform their own positive
lookup, so GC eviction cannot become a permanent warming exclusion. Unobserved
positive entries retain the existing background checks.
When one name/version group also contains an instruction or another archive-required
target, eligible storage and fresh artifact mounts may still use decoded files.
The archive continues through its normal delivery path for the other target and
is not retired while that target requires it. A missing decoded entry can still
be warmed from an archive hit or fill for a later plan.

Artifact decoded selection has the same fail-closed boundary as storage:
missing, busy, rejected, conflicting or capacity-ineligible optional cache work
keeps the original archive path, while malformed present data, cache I/O,
cancellation or direct-write failure is explicit failure. Once Guest mutation
starts, the retained archive URL is metadata and is not replayed as recovery.

After Agent spawn, ordinary warm-source candidates can pass through one
runner-owned classification batch of at most 16 keys before queue admission.
Classification shares the existing decoded worker/memory budget, never waits
for a permit, and owns no waiting queue or remembered negative state. It omits
warming only after validating a current rejection record and a still-present
compressed source under their existing locks. Missing fills and archive-required
consumers keep normal admission. Busy, missing, invalid or unavailable
classification retains the ordinary background path, including its errors.
The coordinator owns classification completion and reporting through shutdown;
dropping its last owner closes admission before any delayed classification can
submit. Foreground lookup still probes only positive entries. Neither persisted
format, GC, nor the four-worker/32-queued admission bounds change.

Readers hold that lock while validating the bounded index, identity, file types,
sizes and content digests, then pin owned bytes through Guest apply. GC can evict
the disk entry afterward without invalidating an in-flight delivery. Orphaned
lock GC may remove an unlocked lock while retaining its data; a reader recreates
and revalidates the lock only for a present entry, then reopens the directory
under the lock. Missing, busy or unsupported entries keep ordinary delivery;
malformed present cache data is an error, not an unverified hit.

Before omitting archive staging, a ready decoded mount must individually fit
the existing 64 KiB canonical manifest bound. Other mounts' signed URLs or
cleanup metadata do not reject that ready mount. Miss-only runs do not serialize
entries to decide whether an unused binary input would fit. The selected files
still share the 15 MiB payload and 1,024-mount limits across the entire run.

After source resolution, a combined manifest that fits uses one Guest operation.
An oversized combined manifest is composed into bounded existing-format
requests: ordinary storage, unselected artifacts, reused paths and all cleanup
run first; decoded storage and artifact batches follow without repeating cleanup.
The Runner validates decoded bindings against the complete manifest before
partitioning, and the Guest validates each binary request. Decoded artifact
batches preserve the canonical artifact storage ID, archive source, writeback,
fingerprints and missing-root policy fields; only their bytes arrive through the
private decoded-files input. Every batch retains the existing 64 KiB manifest
and 15 MiB payload limits, real source URLs and file/path validation. All batches
are encoded before the first storage-apply operation, and a failure stops later
batches and prevents Agent spawn. The existing non-transactional partial
filesystem-change semantics remain; multiple requests do not imply rollback.
Oversized ordinary JSON retains its existing manifest-file transport. No API,
wire shape, persisted cache format, archive eligibility or generic stdin limit
changes. Split runs can emit multiple Guest storage-apply operations inside one
enclosing Runner storage-apply stage; per-helper entry indices are not globally
unique within such a run.

Lookup windows admit at most 128 identities with 128 KiB of owned key bytes,
retaining the per-key limits. Non-admitted keys retain ordinary delivery;
this bounds metadata even when a plan contains unusually long identities.
Ready-file read-ahead stops after reaching 15 MiB of content, with at most one
additional storage's size in that last read; the wider miss-probe window does
not increase the former 16-MiB content read-ahead bound.

First-fill extraction belongs to the existing bounded background-fill owner and
starts only after Agent spawn. Before that point, selected work owns no task,
cache lock or open file. Publication uses private staging and atomic rename;
this is a disposable cache, not a power-loss-durable source of truth. Runner
shutdown joins background work and extracted-cache blocking tasks. The binary
final-file input is private to the bundled Runner/Guest storage operation;
ordinary HTTP downloads, API manifests and generic exec-stdin limits do not
change. No backend reader-first deployment is required for that bundled input.

The Runner-wide owner admits at most 32 waiting identities and runs at most four
workers. Missing-archive observations and maintenance (warming an observed archive
hit or retiring its compressed source) each leave four waiting positions for the
other class; the remaining 24 positions are shared. Pure-class bursts can therefore
be rejected at 28 waiting entries. Admission never waits, evicts an accepted task,
or retains rejected work for retry. Queued same-key archive demand supersedes
retirement, and missing demand promotes warming without losing its decoded-cache
consumer. Such promotions retain accepted ownership even above a class quota,
while the total queue bound remains unchanged.

Dispatch is FIFO within each class. While both classes wait, at most three missing
fills start before one maintenance task; an empty class does not idle workers.
This gives every accepted warming and retirement task finite dispatch progress
provided active operations finish, not a wall-clock deadline or guaranteed
admission at mixed saturation. Classification uses existing preparation outcomes
only: workers still validate actual cache state under the original locks, so an
evicted warm source can be downloaded and a newly filled miss can be reused. No
new foreground lookup, network request or maintenance barrier is introduced.

After a run actually selects extracted-file delivery and successfully spawns its
Agent, that same bounded background owner may retire the corresponding compressed
archive. Retirement never downloads data. It takes the old archive's exclusive
lock without waiting and validates the complete positive replacement under its
own lock, retaining both locks through deletion. Busy, missing or non-admitted
replacement work is skipped; malformed data is reported as a background error.
It removes only the regular archive and an empty version directory, not unrelated
files. GC can independently evict either format after those locks are released.

Conversion alone does not delete an archive: a never-used converted entry may
retain both formats until direct use or GC. Old Runners, rollback, instructions,
ineligible artifacts and other archive-required consumers keep their original
delivery and may refill a compressed cache miss. Queued archive-fill demand takes
precedence over queued retirement for the same identity. This is use-driven
best-effort cleanup, not a guarantee of exactly one representation across mixed
consumers.

Positive lookup includes a metadata-only archive-existence hint for maintenance
admission. Already retired entries do not consume the background queue again,
so a decoded prefix cannot repeatedly displace later warming or retirement.
The hint neither reads compressed content nor authorizes deletion: retirement
reopens and validates under locks. Metadata errors are left to that background
validation rather than failing an otherwise valid extracted-file delivery. An
orphaned source lock is recreated only for observed archive data, following the
same lock repair rule as cache readers.

Use **sandbox** for provider-neutral runner lifecycle, ownership, status,
network-policy, and operator concepts. Use **VM** only for concrete
Firecracker/KVM implementation details such as the Firecracker `/vm` API, VM
pause and resume, snapshots, vCPUs, VMGenID, KVM, and Firecracker processes.
Product brand names, the established environment-variable namespace, and fixed
paths are not lifecycle terminology and remain unchanged.

Each runner version's `status.json` is a host-local persisted cross-version
boundary. Current runner maintenance commands can inspect status files written
by previous runner versions, rollback can expose an older command to a newer
status writer, and the independently deployed host monitoring collector scans
every versioned runner directory. Status schema changes must cover those
old/new combinations rather than treating the file as process-private state.

Current status writers publish exact inventory in `idle_sandboxes` and ready
blanks in `blank_sandboxes`, omitting each collection when empty. Exact entries
contain `reuse_key` and `sandbox_id`; blank entries contain only `sandbox_id`,
never a run ID or tenant reuse identity. Both collections are captured from one
pool revision and applied together, including preparing/running ownership
transitions. The migration tracked by
[#32071](https://github.com/vm0-ai/vm0/issues/32071) separates these identities
without changing shared pool lifecycle rules.

Internally, the same `IdlePool` owns exact reuse-key and blank sandbox-ID
indexes. They share capacity limits, budget ownership, parking gates and a
mutation revision; they are not independent pools. Exact lookup, exact-first
restoration, blank-first pressure eviction and conditional exact aging retain
their existing policies. Heartbeat reuse inventories contain exact entries only.

Doctor and the host collector read `blank_sandboxes: [{"sandbox_id": "..."}]`
directly. Missing collections default to empty, including exact-only historical
statuses without `blank_sandboxes`; malformed present collections are invalid.
Blank identity is never inferred from an idle reuse key. Explicit blank IDs
suppress same-file idle mirrors, and duplicate blank IDs count once. Doctor lists
exact reuse keys under Idle and sandbox-ID-only entries under Blank, recognizes
both as owned processes, and never treats an unclaimed blank as an active job.
Active mappings take priority over duplicate blanks.

The collector exports `vm0_runner_sandboxes{state="blank"}` (including zero).
`state="idle"` now counts exact inventory only; total parked inventory is the
sum of `idle` and `blank`. Active, preparing and unknown counts keep their meaning.
Use `sum by (instance) (vm0_runner_sandboxes{state=~"idle|blank"})` for a per-host
parked total; replace/group additional host identity labels as needed. Summing
all states gives total recorded sandbox inventory. UUID deduplication across
non-stopped version files uses `idle > active > preparing > unknown > blank`:
an active/claimed record supersedes a duplicate old blank, preserving the existing
priority between non-blank states. Stopped files are excluded. Sandbox IDs, run
IDs and reuse keys are never metric labels. Existing Grafana panels selecting
only `idle` will now show exact inventory; this change does not edit dashboards.

The collector is installed by host provisioning, independently of Runner
releases. Both its systemd timer and Alloy textfile scrape run every 15 seconds.

The reader-first rollout delivered doctor and collector support in
[#32092](https://github.com/vm0-ai/vm0/pull/32092), followed by the explicit writer in
[#32269](https://github.com/vm0-ai/vm0/pull/32269). The first explicit-writer release
is `runner-rs-v0.188.0`, commit `f4b9a172cf76e04b845f2337c14cf87831c82adb`.
Legacy blank input recognition is retired by
[#32084](https://github.com/vm0-ai/vm0/issues/32084), based on read-only production
verification on 2026-09-07 at 14:20 UTC:

- `prod-11.gcp.vm3.ai`, `prod-12.gcp.vm3.ai` and `prod-13.gcp.vm3.ai` each had
  `v0.188.3` running and `v0.188.2` draining. Both releases contain explicit-writer
  commit `bd9cddcf6719c90848ed4ec497baca8cfd3191ea`. The remaining draining release
  therefore does not require legacy input recognition.
- The legacy writers were stopped. All 18 retained versioned status files parsed
  successfully and contained no synthetic blank entries.
- Each installed collector matched repository SHA-256
  `560cb9b86e29357249582273253716f48be63df93cd6f04f12dabb4ffa499f42`, and each
  collector timer was active. This is the pre-cleanup, bridge-capable collector
  checksum, not the checksum of the retired-reader implementation.

The explicit retirement decision excludes rollback compatibility with legacy
writers; this cleanup does not change rollback resolution or promise that those
writers remain readable as blank inventory. Current explicit writers work with
both bridge and post-cleanup readers during deployment. No production process or
status file was modified to establish the evidence. Verify the final doctor and
independently provisioned collector rollout before closing delivery parent
[#32071](https://github.com/vm0-ai/vm0/issues/32071); a merged PR alone does not
establish that deployment.

The proxy registry and embedded mitm-addon are also a runner-private contract.
The runner binary embeds the addon sources, recreates the addon directory and
registry at startup, and keeps them in its version-specific base directory.
Their registry schema and process-local flow metadata can therefore change
atomically in one runner release without fallback keys or cross-version readers.
This exemption does not extend to registry data persisted outside that runner
artifact or consumed by an independently deployed component.

Each sandbox is owned exclusively by the runner process that created it. A
different runner never adopts that sandbox, and stopping the owning runner also
destroys its sandboxes. Sandbox-local runtime files are therefore private to one
runner artifact and one sandbox lifetime. They do not need schema versions or
cross-version readers; this includes metadata exchanged only between the runner
and its bundled guest binaries, such as final session-history identity metadata.

Workspace caches have a different lifetime. A cache image, its metadata, and
its session-history sidecar can outlive the runner process that produced them
and be consumed by a later runner artifact. Treat workspace-cache formats as a
persisted cross-runner compatibility boundary. A format change must either keep
older cache entries readable or explicitly invalidate and purge incompatible
entries before a new reader depends on the change.

## What Requires Compatibility

Compatibility is required across deployable boundaries:

- Frontend -> backend API requests and responses.
- Runner -> backend poll, claim, heartbeat, log, artifact, completion, and other
  runner-facing APIs.
- Backend data written by one version and read by another version during a
  rollout.
- Database schema migrations applied before every backend instance is running
  the new code.
- Queue, persisted job payload, and run/session state consumed by runner or
  backend code from different versions.
- Workspace-cache images, metadata, and sidecars that can be written by one
  runner artifact and read by a later runner artifact.

Compatibility is not required inside one deployed artifact:

- Frontend package-to-package internals inside the same browser build.
- Backend package internals that are deployed as one API build.
- Runner internals shipped in the same runner binary.
- Runner-to-guest binary internals shipped in the same runner artifact.
- Sandbox-local files and state that exist only for one runner-owned sandbox
  lifetime.

## Required Change Patterns

Prefer additive changes at cross-version boundaries:

- Add optional request fields before making them required.
- Add response fields without requiring old clients to read them.
- Keep accepting old enum values while old clients can still send them.
- Keep old endpoint paths or add a forwarding/versioned path during migration.
- Make readers tolerant of missing newly added persisted fields.
- Keep migrations additive or otherwise compatible with the old backend during
  the rollout window.
- Write data in a format that the previous deployed reader can ignore or safely
  process during the rollout window.

An optional response or persisted field is not automatically compatible with
strict readers. When retaining the same protocol version, deploy tolerant
readers first while writers omit the field. Activate writers only after every
old strict reader and rollback target has drained or is excluded by an enforced
compatibility floor.

Chat Event V7 failure reasons use this pattern. Reader commit
`c093e0ffdab988d2a8a071809f90d87fa3e79f20` shipped in release
`89c6a521944e2ac8550da424f164db08f4f80f0c` before writers were enabled. App
builds below `0.830.0` are excluded by the API client floor, commit-addressed
CLI contexts must drain through queue, execution, and finalization, and the
production rollback resolver rejects targets that do not contain the reader
commit. The reason is stored outside strict payload JSON so old API instances
remain compatible during the additive database migration and traffic overlap.

Balance failures keep `insufficient_credits` for vm0 credit admission and add
`provider_insufficient_credits` for upstream model-account balance. Completion
stores that real failure reason for both personal-subscription and built-in runs. Public presentation
uses persisted run ownership to display a platform-owned balance failure as
"The current model is unavailable." and omit its billing reason from public chat
metadata. Model unavailability is presentation, not a completion failure reason.
The webhook and Chat Event V7 schemas accept all valid reason tokens; older readers
use generic failure copy for an unknown token instead of rejecting the run or
showing the vm0 recharge card. The token addition required no schema migration.

The #34219 cleanup follows the reader/writer rollout in #34251. The production
read on 2026-09-16 found API `1.607.0`, App `0.902.2`, and all three running
Runners on `0.194.6`, containing the owner-aware reader and structured writer
commit `0367d976a87fe1251fcb9b6cfe545a8b24e4f2b6`.

Historical errors remain as stored, including missing or misclassified failure
reasons. No data migration or repair is required. The user accepted that those
records may display raw errors or the old incorrect credit classification after
terminal text inference is removed. Terminal readers use the persisted cause.
Current failed provider-event detection and network-export redaction remain.
The production rollback resolver enforces the commit above for both the API
target and its independently resolved Runner tag, preventing an older writer or
public reader from returning for new runs.

This change does not certify alert delivery. #34219 remains open for actual
built-in/personal-subscription production samples, Axiom monitor configuration and delivered-alert
verification. Runner INFO events are below the Axiom upload threshold, and the
investigation token could not read monitor configuration.

Pi queue expiry adds `provider_queue_timeout` under the same open-token
contract. Prefer API/App readers and terminal policy before the patched CLI;
Guest and Runner typed contracts ship as a supported pair. An old API's
transient allowlist excludes the new token. Old Guests may ignore the optional
runtime diagnosis but preserve failure; a new Guest can refine an old CLI's
generic server/overload evidence from exact terminal text. It cannot undo
retries already performed by an old SDK. No new protocol, database column or
session format is introduced, and local-deadline handoff is unchanged.

Codex access-program rejection adds `codex_access_program_unavailable` under
that same open-token contract. The API accepts and persists future snake-case
tokens, so a new Runner talking to an older API remains functional but receives
generic failure presentation and the older unknown-token warning policy. An old
Runner talking to a new API omits the reason and keeps its existing behavior.
With both artifacts updated, the exact trusted terminal
`access_programs.cyber` rejection receives specific guidance, Runner INFO
telemetry, and no API WARN/ERROR. The run remains failed and retains its original
error. There is no schema migration, historical backfill, replay, retry,
credential change, rollout switch, or production-observation authorization.

Queued or active commit-addressed contexts can retain the old CLI. Release
acceptance must record API SHA, CLI package SHA and Runner/Guest versions, run
the controlled fixture against that artifact, and observe a fixed 24-hour
window for unique affected runs, actual statuses/attempts and built-in warning
visibility. No occurrence means no observed exposure, not proven recovery.
Rollback can restore old retry behavior; retained reason tokens stay readable.

Avoid one-shot protocol flips:

- Do not require a new request field from frontend or runner in the same PR that
  first adds the client sender.
- Do not remove a response field while old frontend or runner code may still
  read it.
- Do not delete runner-facing endpoints or payload variants until old runners
  have drained in production.
- Do not persist data that the previous backend or runner version cannot parse
  unless the old reader is no longer active before the writer is deployed.

When an incompatible change is unavoidable, split it into phases:

1. **Prepare**: backend accepts both old and new protocol; readers tolerate both
   old and new persisted data.
2. **Migrate**: frontend or runner starts using the new protocol.
3. **Clean up**: remove compatibility logic only after the old deployed version
   is no longer active.

Before a destructive clean-up migration, verify that the replacement version is
healthy and every reader that needs the old schema has drained. After the
cleanup, rolling back to a version that requires the removed schema is unsafe;
recovery must restore compatibility first or roll forward.

Compatibility code should be temporary and explicit. Include a short comment
with the rollout reason and the condition for deletion, or track the cleanup in
a follow-up issue when the deletion cannot happen in the same PR.

### Okou Goal retirement rollback floor

The production rollback resolver requires the release/API target to contain
Goal retirement commit `6d391117e4fead19e2105136fb2792a6e77801d8`. The first
compatible release is `1f68f182a2457ec3aea52d8063be2bd2d2263abd` (API 1.571.1).
This permanent floor prevents canonical rollback from restoring Goal creation,
reactivation, or continuation. It rejects pre-boundary targets before API or
Runner artifact resolution and output publication, even if the rollback
dashboard still lists those historical releases.

S5 additionally requires **both** accepted consumer-removal commits:
`2c231766e383b651867893852cfb47dcc78af0bd` (original S4) and
`077a9a644986e13bed4750796f91e55c4a876aad` (ordinary-write repair).
The first independently verified compatible release is
`4a4881bf84cb1d79723fd38c83e00f2215bb1e31` (API **1.580.0**),
[accepted in production](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5618238710).
S1/S2/S3-only targets and original S4 without the repair fail before API or
Runner artifact resolution or output publication. The S1 retirement floor and
all unrelated reader, main ancestry, release-tag and artifact checks remain.
This stronger resolver was effective from current main before physical
contraction shipped.

Apply these API floors only to the release/API target: the first compatible release
retained an older Runner tag. All independent Runner ancestry, reader, host
architecture, and release-asset checks still apply. The rollback workflow loads
the resolver from current `main`, so merging the guard constrains future
canonical executions without a release or test rollback.

The accepted S1 gate verifies the currently serving normal production version
rejects Goal creation/reactivation and cannot continue Goal work. Historical
Vercel/fixed-deployment inventory is outside that gate under the
[user decision](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5595137042);
this does not claim those deployments were disabled. Keep the rollback floors and
permanent [history/accounting contracts](goal-retirement-archival.md) in
[EPIC #32653](https://github.com/vm0-ai/vm0/issues/32653).

S4 [#33061](https://github.com/vm0-ai/vm0/issues/33061) removed application Goal
schema consumers while preserving physical state; its ordinary-write repair was
also required before contraction. **The S1 floor alone remains insufficient.**
Never select an S1/S2/S3-only target or unrepaired S4 after contraction.

**S5 was independently production accepted on 2026-09-10.** The
[acceptance record](https://github.com/vm0-ai/vm0/issues/32653#issuecomment-5623079780)
distinguishes #33253's failed production DDL (`40P01`) from Ethan's successful
#33307 at `9c777819776d2bed0cfdb110653e46dcaffc0e8b` (API 1.582.0 / App 0.884.1).
Actual production 1106 DDL, helper cleanup/timeout resets and the awaited journal
INSERT preceded `Migrations complete` at **17:21:49.5878347 UTC**. The controller
byte-verified that path and fresh physical metadata with unchanged masking policy;
MaskDB exposes no journal or constraint/procedure catalogs, so no direct SELECT
of those rows is claimed. This closes the physical-schema transition under
[the migration retirement gates](../turbo/packages/db/MIGRATIONS.md#retired-goal-transition-validators-2026-09-10).

S6a removes the expired Goal validators and pre-contract fixture variants, while
retaining permanent current-schema SQL, literal history, accounting, race and
security coverage. The [S4 record](goal-retirement-archival.md#s4-application-consumer-removal-33061)
still documents historical/security references and bounded captured contexts.
Numbered 014 remains a completed historical operation, not a current execution
path. Both rollback floors remain unchanged; this cleanup authorizes no release,
rollback, production operation or official resource/workflow disposition.

### Computer Use host client_product rollback floor

The production rollback resolver requires the release/API target to contain
`669d0befc9a181e44e3f1f9e39093efddabcc0f8`, which removed the
`computer_use_hosts.client_product` ORM declaration and dropped the physical
column in migration `1107`. Drizzle builds column lists from the declaration
rather than from usage, so the declaration removal and the physical contraction
had to ship in one release. That release is therefore a rollback barrier.

Canonical rollback promotes App, Runner, and API artifacts and does not restore
an older database schema. Once `1107` has run, an earlier API build still names
the dropped column in every insert, bare select, and bare returning, failing
with `42703` and taking out host registration, heartbeat, host stop, and
host-command claiming until a forward fix. This permanent floor rejects
pre-drop targets before API or Runner artifact resolution and output
publication, even while the rollback dashboard still lists those releases.

The floor is effective from `main` as soon as it merges, and no tagged release
satisfied it at that point. Canonical production rollback is therefore
unavailable by design until the release carrying `1107` is promoted: the
resolver rejects every target as predating the drop, and recovery in that
interval is roll-forward. Promoting that release closes the interval.

The first compatible release is the one carrying migration `1107`; record its
tag here once that release ships. Apply this floor only to the release/API
target: the independent Runner ancestry, reader, host architecture, and
release-asset checks are unchanged. The rollback workflow loads the resolver
from current `main`, so merging the floor constrains future canonical
executions without a release or test rollback.

### Plan capability snapshot rollout compatibility

> **Historical record.** The BYOK plan capability described here was retired
> with organization BYOK (#37746, #37856); only the concurrency values remain
> current.

Migration `1187_expand_free_concurrency_byok` backfills only product-managed
`org_plan_entitlements` rows for the Free concurrency/BYOK and Pro concurrency
changes. Manual entitlements remain explicit operator overrides, and
`pro-suspend` and nonstandard product-managed values are left untouched.

The backfill is the only correction. Because the normal production path runs
migrations before promoting the new API, an outgoing or retained rollback API
can write its old complete entitlement snapshot over a backfilled row during the
rollout or a rollback. Such a workspace keeps the old Free/Pro concurrency and
BYOK capabilities until its next entitlement write from the new API, which
restores the current values from the tier table. No database object enforces the
new values, so tier policy stays owned by the API rather than becoming a
permanent database constraint.

### Usage pack visibility compatibility retirement

`showUsagePack` has an explicit API writer and billing response starting with
commit `65ac0518bde2310887470cb0874aeae06c0c0397`, first released in
`api-v1.570.0` (`22c62b9e92f42078ae314e505b983a62eda35dac`). Its
[API production promotion](https://github.com/vm0-ai/vm0/actions/runs/34227208941/job/102068385804)
completed on 2026-09-08 at 12:54:51 UTC. The later `api-v1.572.1` artifact
(`561b7d6bf0da6ccca2542c0f9cd053d67151ba31`) also completed
[API production promotion](https://github.com/vm0-ai/vm0/actions/runs/34297728653/job/102298538957)
on 2026-09-09 at 01:11:34 UTC.

Migration `1092` removes the temporary legacy-writer trigger and function after
this rollout. The billing response now requires the flag, and the frontend
reads it directly. The existing Okou Goal retirement rollback floor requires
commit `6d391117e4fead19e2105136fb2792a6e77801d8`, which descends from the
explicit usage-pack writer commit. Its first compatible release is API 1.571.1,
so every permitted rollback target also contains the required writer and
response. The resolver runs from current `main` and rejects older targets before
artifact resolution, including entries still retained in the rollback dashboard.
Keep this enforced boundary when retiring the usage-pack compatibility bridge;
all other deployment and Runner rollback checks continue to apply.

The cleanup retains existing visibility values, the physical
`member_invite_usage_pack_required` column and its ORM declaration, and all
existing admin requirements. It does not change usage-pack balances or purchase
eligibility. Further legacy-column retirement remains tracked in
[issue #32575](https://github.com/vm0-ai/vm0/issues/32575).

#### Invitation and Free-member contract cleanup (2026-09-14)

The Free-member API and App shipped in commit
`b8b18c4aed6a054791b7a3a5209ad7a6112c4217` (#32573). Release
`3d58eaa4609967a4f655f7cd61d0d7cd454ba2a1` contains that commit and promoted
API 1.575.2 at 2026-09-09 09:48:46 UTC and App 0.873.0 at 09:50:38 UTC.
The [App promotion log](https://github.com/vm0-ai/vm0/actions/runs/34335229479/job/102417989571)
verifies that exact artifact SHA, rather than a moving deployment SHA. App
0.873.0 uses billing `status` for invitations and accepts an empty all-Free
migration configuration. It ignores `memberInvitationAllowed` when `status`
is present.

The later [API promotion](https://github.com/vm0-ai/vm0/actions/runs/34794788803/job/103826080723)
and [App promotion](https://github.com/vm0-ai/vm0/actions/runs/34794788803/job/103826582194)
of `826d131351049b7f35f45cad577618e01b231544` succeeded on 2026-09-14 at
01:11:42 and 01:13:20 UTC. The App log verifies the 0.893.7 artifact at that
SHA. Both the serving release and the existing enforced API rollback floor
`669d0befc9a181e44e3f1f9e39093efddabcc0f8` descend from #32573. Those API
readers use `status` and `show_usage_pack`, and their catalog and management
responses always advertise `supportsFreeMembers: true`.

This cleanup raises the App floor from 0.857.0 to the already-live 0.873.0,
removes the derived `memberInvitationAllowed` response alias, requires explicit
Free-member support, and removes paid-only catalog/management fallbacks. The
API returns all-Free migration configuration without requiring an opt-in. The
App's existing migration query opt-in remains necessary when it reaches a
supported rollback API; keep the query and its contract until every supported
API returns configuration unconditionally. The general floor's existing
handling of missing/unparseable versions and other client types is unchanged.

All application entitlement access now uses `runtime/org-plan-entitlement`.
That mapping excludes both old invitation columns from INSERT, SELECT and
RETURNING, and the canonical writer stops mirroring `show_usage_pack` into
`member_invite_usage_pack_required`. The migration-only schema declarations,
physical columns, status-mirror trigger/function and transition validator stay
in place. Removing them in this same release would break outgoing API SQL
between migration and promotion. No schema migration or rollback-floor change
is part of this preparation release.

Migration 1132 below subsequently handles the three entitlement triggers and
enforces the canonical-only rollback artifact. Its production completion and
the remaining #32575 column/client contraction are recorded next.

#### Legacy invitation column contraction (2026-09-15)

The [API 1.603.1 production job](https://github.com/vm0-ai/vm0/actions/runs/34936717500/job/104278924406)
checked out and built `caa4352ddba6ef4b1912cbbb7838afb94ac4aa82`. Its **Run
Production Migrations** step records the real production 1132 receipt at
2026-09-15 06:38:10.5347961 UTC: eight matched/retired triggers, eight matched
functions and zero audited invariant violations on PostgreSQL 17.10. This is
separate from the preceding smoke-clone receipt. `Migrations complete` follows
at **06:38:10.7737004 UTC**. The shipped migration runner and entry point are
byte-identical to this change's base: the runner awaits the transaction including
the journal insertion before the entry point reports completion. This establishes
the 1132 journal frontier, `when=1789448024786`; no direct production journal
SELECT is claimed.

The 2026-09-15 serving-alias read resolves both `api.vm0.ai` and `api.okou.ai`
to READY production deployment `dpl_i8s7vaEvyqeKFD7m2hTa2W2CAKYW` at that same
artifact. It descends from the enforced API 1.600.1 rollback floor,
`eb2f211a9af41450d0d5dad10c0c8ad12fac0a24`, which in turn contains #33909's
canonical-only mapping and unconditional all-Free migration response. The
resolver continues to load from current main and reject earlier artifacts.
Current and supported rollback APIs therefore neither name the old columns in
SQL nor require the App's migration query opt-in.

Drizzle-generated migration `1137_retire_legacy_invitation_columns` removes
`member_invite_usage_pack_required` and `member_invitation_allowed`. It locks
only `org_plan_entitlements`, checks the predecessor journal frontier, exact
column definitions, persisted routine bodies in user schemas, and all recorded
column dependencies before either drop. Only the columns' own defaults and
native NOT NULL constraints may disappear; unexpected indexes, checks, views,
triggers or functions abort the transaction. The normal 1s lock / 10s statement
limits and atomic journal insertion remain in force. Historical migrations and
1132's evidence remain unchanged.

The App removes `supportsFreeMembers=true` from the migration GET request and
its request contract. Catalog/management responses still explicitly advertise
Free-member support. Existing route coverage checks all-Free configuration
without a query parameter; invitation admission continues to use normalized
status and administrator authorization, and package controls use `showUsagePack`.

The final #32575 cleanup follows production release [#34303](https://github.com/vm0-ai/vm0/pull/34303),
which promoted API 1.604.0 and App 0.900.0 from
`8a391b88833ae0b075c4df194010641955d4f936`. That actual artifact contains
#34317. The release PR's earlier branch head does not contain #34317 and is
not the production artifact used for this verification.

The [API production job](https://github.com/vm0-ai/vm0/actions/runs/34957141130/job/104345191059)
checked out that exact artifact and completed **Run Production Migrations** at
**2026-09-15 10:31:12.0275988 UTC**. This is the real production completion,
separate from the preceding smoke clone's 10:31:09.4559442 UTC completion. The
artifact's final journal entry is 1137, `when=1789460587817`. Its 1137 SQL,
migration runner and entry point are byte-identical to #34317: the runner awaits
both column drops and the journal insertion in one transaction before the entry
point prints `Migrations complete`. That acknowledged execution establishes the
committed frontier and column contraction; no direct production journal or
catalog SELECT is claimed.

Fresh serving-alias reads resolve both `api.vm0.ai` and `api.okou.ai` to READY
production deployment `dpl_AFZ3enCuHEt768R3HaqanNg8ZxtH` at that same artifact.
The [App production job](https://github.com/vm0-ai/vm0/actions/runs/34957141130/job/104346013714)
verified the immutable App artifact and assets, then completed promotion at
10:33:12 UTC. The serving `https://app.okou.ai/` HTML reports that exact SHA and
version 0.900.0. Current main still loads the rollback resolver from main and
enforces API 1.600.1 at `eb2f211a9af41450d0d5dad10c0c8ad12fac0a24` as the
prepared-writer floor. Both that floor and the serving API use the canonical
entitlement mapping and return migration state without a query opt-in. The
serving/rollback compatibility cycle covered by the invitation validators is
complete.

The cleanup removes both invitation transition validators, the frozen outgoing
API projection, and the retained/trigger-free private-schema variants. Permanent
schema validation exercises the canonical projection on both replayed and freshly
generated schemas. Historical `showUsagePack` backfill checks remain. Current API
coverage retains infrastructure failure/transaction cases and verifies
persisted status normalization through the billing endpoint; existing invitation
and page suites retain Free, suspended, administrator, reactivation and explicit
`showUsagePack: false` behavior. Close #32575 after the final cleanup merges.

### Prepared billing, OAuth and hosting trigger contraction (2026-09-15)

Migration `1132_retire_prepared_domain_triggers` removes A–D's eight triggers
and functions from #33747. The supported rollback floor is API 1.600.1,
`api-v1.600.1`, at `eb2f211a9af41450d0d5dad10c0c8ad12fac0a24`; it contains
all four prepared writers, their webhook/cron paths and the canonical-only
invitation mapping. Its [production promotion](https://github.com/vm0-ai/vm0/actions/runs/34915532910/job/104212801721)
records checkout/build and alias publication at 2026-09-15 01:07:30 UTC.
A bounded Vercel read verifies exactly one READY production artifact for that
SHA. The 2026-09-15 02:56–02:57 UTC alias/deployment read resolved API 1.601.0 at
`3ace38cfefa54eb9df33715131a3ee8be1be3c27`, a descendant of that floor.
The rollback resolver enforces the floor before resolving API/Runner artifacts;
the workflow always loads the resolver from `main`.

The prepared API works on both schemas, so migration-before-promotion and an
API rollback to that floor preserve the explicit writes. Current route tests
run with all eight absent; private service suites preserve retained/outgoing
SQL controls until contraction has actually shipped. The migration keeps its
1s lock / 10s statement limits and validates catalog/data under locks before
any drop. Production smoke and production journal completion are distinct
release gates; no production deletion is asserted by this source change.

The invitation status-mirror trigger is included; its obsolete physical columns
and App query opt-in remain #32575 work. E's privacy trigger is excluded, and
the withdrawn feature remains withdrawn. See the
[writer inventory, repair rules and migration receipts](database-trigger-retirement.md#a-d-contraction-migration-1132).

### Withdrawn marketing privacy storage contraction (2026-09-15)

Migration 1139 drops the three withdrawn privacy tables and their trigger/function
under #33747. The old `user.deleted` cleanup still unconditionally names
`privacy_choices`, so preparation #34296 must be released and its old writers
drained before contraction can merge/release. The prepared cleanup handles all
three relations present or absent under the shared advisory lock also taken
exclusively by the migration. Current contraction code removes that temporary
helper and schema dependency entirely.

The rollback resolver derives the preparation's actual introduction from main's
first-parent history of `marketing-privacy-cleanup.service.ts`, preserving that
boundary after the file is deleted and across a squash merge. It rejects absent
history and targets predating preparation before looking up artifacts. The retained
target must also be a released READY artifact. The canonical preparation
introduction is `e98391290d01e88ece8bf1acfcfc258b3f1e3c13`. Record the immutable
production artifact and old-invocation drain on
[contraction #34305](https://github.com/vm0-ai/vm0/pull/34305) before it becomes
ready; this source guard alone does not prove serving or drain. See the
[explicit release and rollback gates](marketing-privacy-choices.md#required-release-order-and-rollback-boundary).
API rollback cannot recreate the retired rows. The withdrawn feature stays
withdrawn, and #33275 owns any replacement privacy design.

### Workflow automation connector-account projections

Connector-backed workflow event automations persist account authority in an
additive relational projection and, for providers with pre-existing strict
bindings, in provider-specific JSON. The workflow owner's automation chat
thread remains authoritative; persisted connector IDs are derived state for
provider registration, repair, matching, and exact run-source admission.

Gmail, Google Calendar, and Google Meet keep connector identity outside their
strict JSON config and use the nullable relational projection. Google Forms and
Notion retain a JSON connector mirror. Stripe retains its JSON connector,
external account, and mode binding. New writers converge these forms, while new
readers continue repairing legacy null or mismatched state during rolling
deployment.

Do not contract the nullable projection, JSON mirrors, or legacy repair paths
until production evidence shows both that supported old API/rollback versions
have drained and that persisted rows and durable provider work no longer need
the compatibility path. A current writer producing only converged rows is not
evidence that older readers, queued work, or existing rows have drained.

The complete authority, provider, lifecycle, ingress, and failure model is in
[Connector-account workflow automations](./connector-account-workflow-automation.md).

### Locale compatibility

Locale-capable clients receive a `supportedLocales` handshake derived from the
capabilities in their client version. The API projects a stored locale to
`en-US` when the requesting client cannot parse that locale and rejects locale
writes that the client did not advertise. Keep this compatibility layer until
stale browser clients and API rollback windows have closed.

### Retired Limelight color theme

`limelight` is removed from `COLOR_THEMES`, so the API no longer parses it in
either direction. Migration `1147_retire_limelight_color_theme` moves stored
selections to `citrus-spark`, which declares the same two colours; it must run
before the API that rejects the value, which is the normal migrate-then-promote
order. The App is promoted after the API, so between the two an already-open
bundle can still offer Limelight and receive `400` on that one write; every
other palette, and the member's stored selection, is unaffected. The palette was
only reachable under the `GradientColorThemes` rollout switch.

### Unchosen Blue horizon palettes withdrawn (2026-09-21)

Migration `1190_reset_unchosen_blue_horizon_color_theme` clears
`org_members_metadata.color_theme` for every member holding `blue-horizon`
without a `gradientColorThemes` key in `user_feature_switches`. App bootstrap
wrote those rows, not the member: between #30051 and #34556 the App's fallback
palette was `blue-horizon` and bootstrap persisted that fallback whenever the
column was null, ungated by a switch that stayed `enabled: false` for every
organization until #35645 released it.

Old App/new data is compatible, but not inert. An App bundle between #34556 and
this change reads a cleared column as "no palette chosen", renders the default
palette, and writes `default` back: the member sees the intended interface and
the column simply stops being null again. The App promoted with this migration
writes nothing back, so rows cleared after it is served stay null. An App bundle
from before #34556 would write `blue-horizon` back instead; that write happens
only during bootstrap, so it needs a session that loaded such a bundle before
the migration and bootstraps after it, and the member's recovery is to select
Default once on the current App.

No rollback restores the withdrawn values. A cleared column is indistinguishable
from one that was never written, which is the state the migration returns those
members to.

### Treat Database/API Transitions as a First-class Boundary

Schema changes have two independent compatibility directions:

- **Old code after migration**: the migration has changed the schema while
  previous API instances are still serving or draining. Every statement the old
  API can issue must remain legal, including columns that an ORM adds to
  `SELECT` or `RETURNING` lists even when application logic does not otherwise
  read them.
- **New code before migration**: the new API is serving before the migration is
  visible to it. New readers and writers must not require the new column, enum
  value, relation, constraint, or function until the migration is complete.

The normal production release enforces migration-before-promotion in
`promote-api-production`: it builds one API artifact, runs required migrations
against the Neon `production` database, and deploys that exact artifact only
after the migrations succeed. A failed migration stops the job before API
promotion.

For a successful normal release, this closes the new-code-before-migration gate
for its release target. Old code after migration remains a separate boundary:
outgoing, draining, and retained rollback API targets must stay compatible with
the current schema. The production rollback workflow promotes App, Runner, and
API artifacts; it does not restore an older database schema.

The ChatEvent schema-contraction releases from July 27-29, 2026 provide concrete
examples:

- [PR #23148](https://github.com/vm0-ai/vm0/pull/23148), migration `0697`,
  added `event_type`. From about 09:11 to 10:52 UTC on July 27 (102 minutes),
  new App reads, crons, and the automation poller queried it before the migration
  ran and received PostgreSQL error `42703` (`column does not exist`). An
  additive column still breaks a new reader when code wins the race.
- The [PR #23252](https://github.com/vm0-ai/vm0/pull/23252)-era migration
  `0700` added the `teams_user_message` enum value. From about 00:38 to 00:47 UTC
  on July 28 (10 minutes), new code used the value before the migration ran and
  received `22P02` (`invalid input value for enum`), including a 57% failure
  spike on `/chat-threads/:threadId/events`. Enum additions are schema changes,
  not data changes.
- [PR #23656](https://github.com/vm0-ai/vm0/pull/23656), migration `0722`,
  dropped `chat_messages.role`. From about 06:55 to 06:57 UTC on July 29 (two
  minutes), the draining previous API still included the declared column in
  `INSERT ... RETURNING` and received `42703`. Read-never and write-never are
  insufficient while the old ORM schema can still generate the column name.
- [PR #23451](https://github.com/vm0-ai/vm0/pull/23451), migration `0714`,
  at 12:42 UTC on July 28 and
  [PR #23741](https://github.com/vm0-ai/vm0/pull/23741), migration `0725`, at
  09:34 UTC on July 29 produced zero-incident releases. They used in-place
  renames with same-name auto-updatable compatibility views, including column
  aliasing in `0725`. Temporary no-op or mirror triggers from `0714` and
  [PR #23594](https://github.com/vm0-ai/vm0/pull/23594), migration `0719`, kept
  both versions' statements legal during the transition.
- [PR #23696](https://github.com/vm0-ai/vm0/pull/23696), migration `0723`,
  renamed the table. Its compatibility view protected old code after migration,
  but new crons queried `chat_events` before migration from about 08:42 to 08:53
  UTC on July 29 (12 minutes) and received `42P01` (`relation does not exist`).
  User chat routes remained clean. Migration-before-promotion ordering, or
  explicitly tolerant new code, is still required for the other direction.

Persisted database objects are also consumers of table names: PL/pgSQL
functions, triggers, and column defaults can retain references that no source
scan will find, so query the PostgreSQL catalogs before contracting a schema.
[PR #23816](https://github.com/vm0-ai/vm0/pull/23816) had to retarget
`queue_artifact_catalog_file()` in migration `0736`, while
[PR #23858](https://github.com/vm0-ai/vm0/pull/23858) demonstrates the broader
catalog audit required before removing a compatibility relation.

Use one of the following proven schema-transition patterns. Keep each
compatibility layer only until the release it protects has fully drained.

#### Nullable Transition Column, Then Backfill and Contract

**When to use:** A new required field must be populated for existing rows. Add
the nullable column before any code requires it, backfill it in a later release,
and add the constraint only after both old and new writers populate it. The
`0697` -> `0698` -> `0701` sequence followed these three phases; the `0697`
incident also shows why new readers cannot precede the first migration.

```sql
-- Release 1: expand.
ALTER TABLE messages ADD COLUMN event_type text;

-- Release 2: backfill while the column remains nullable.
UPDATE messages
SET event_type = 'message'
WHERE event_type IS NULL;

-- Release 3: contract after every writer supplies the value.
ALTER TABLE messages ALTER COLUMN event_type SET NOT NULL;
```

#### Drop a Column as a Two-release Contract

**When to use:** A physical column is no longer needed. In the first release,
remove it from the ORM schema declaration and from every explicit reader and
writer. Wait for the preceding API version to drain. Only a later release may
drop the physical column. Migration `0722` violated this rule because the
previous Drizzle declaration still changed the generated `RETURNING` shape.

```sql
-- Release 1 changes code only; the physical column remains.

-- Release 2, after the previous API has drained:
ALTER TABLE messages DROP COLUMN legacy_role;
```

#### Rename in Place and Preserve the Old Name with a View

**When to use:** A table or column needs a canonical name while old API
instances still use the old name. Rename the base object in place and create a
simple same-name view over it in the same migration. A single-table view with
direct column references remains auto-updatable; aliases can expose old column
names. Drop the view in a later release after old code drains. Migrations `0723`
and `0725` used this pattern.

```sql
ALTER TABLE old_messages RENAME TO messages;

CREATE VIEW old_messages AS
SELECT
  id,
  event_type AS legacy_type
FROM messages;

-- A later release, after old code drains:
DROP VIEW old_messages;
```

This pattern protects old code after migration. It does not make `messages`
exist for new code before the rename migration, so migration ordering or a
separate new-code fallback must protect that direction.

#### Build Temporary Compatibility Objects in the Migration

**When to use:** The outgoing release issues a narrow statement that a normal
rename view cannot satisfy, or temporarily writes both the legacy and canonical
shape. Create the smallest trigger or zero-row view that preserves that exact
statement. Mirror triggers can keep transition columns synchronized; a zero-row
view plus an `INSTEAD OF` trigger can retain a retired write target without
persisting the obsolete row. Migrations `0714` and `0719` used temporary no-op
and mirror triggers.

```sql
CREATE FUNCTION mirror_legacy_type() RETURNS trigger AS $$
BEGIN
  NEW.event_type := COALESCE(NEW.event_type, NEW.legacy_type);
  NEW.legacy_type := COALESCE(NEW.legacy_type, NEW.event_type);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mirror_legacy_type
BEFORE INSERT OR UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION mirror_legacy_type();

CREATE VIEW retired_messages AS
SELECT id FROM messages WHERE false;

CREATE FUNCTION ignore_retired_message() RETURNS trigger AS $$
BEGIN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ignore_retired_message
INSTEAD OF INSERT ON retired_messages
FOR EACH ROW EXECUTE FUNCTION ignore_retired_message();
```

These objects are contracts, not generic fallbacks. Verify the exact outgoing
SQL against them, record the release they protect, and remove the functions,
triggers, and views after that release drains.

## SSH general availability

SSH, including Direct and Cloudflare Access, is generally available. The
`sshAccess` registry entry, overrides consumer, UI gates and API/Run gates are
retired together. Existing registered-key filtering ignores retired overrides;
no migration, data deletion or rewrite is needed. Owner isolation,
[chat remote access](thread-remote-access.md) host permission, winning
Run/Runner authority, credential encryption and host trust remain required.
The Run-lifetime authority
cache and missed-notification window remain unchanged.

Promote the API before the App. An older API can still enforce its rollout switch;
the App retains its existing unavailable/error handling for that response, never
an authorization bypass. Older loaded Apps may hide SSH until refreshed. Already
created Runs retain their minted capabilities and prompt snapshot; create a new
Run to obtain SSH guidance and capabilities. Runner/guest/CLI DTOs and stored
hosts, credentials, pins and observations do not change. Source-level GA
does not attest deployment state or waive the protected-reader constraints below.

## Cloudflare Access for SSH

The #31996 delivery adds a protected transport to the existing SSH host domain.
#34077 is additive database/API authority preparation, including the minimal
current Runner contract reader and Platform diagnostic translations.
Direct and Cloudflare Access are generally available with no rollout switches;
the same [chat remote access](thread-remote-access.md) host permission applies
to both transports. The initial delivery used the
[pre-GA policy](fallback.md) and keeps one canonical contract:
no profile selector, duplicate old/new DTO, or legacy diagnostic projection.

Before the first protected configuration or binding is written in a deployed
environment, every serving API must understand protected authority, Runners from
#34080 must own new Run admission, and incompatible active Runs must have drained.
#34081 originally owned Access management UI; #34370 records integrated real-Run
acceptance and the owner-approved evidence boundaries at closure. #36038 added
the standalone `/connectors/cloudflare-access` entry after SSH and VNC, and
#36150 / PR #36152 removed the duplicate top-level management tab from
`/connectors/ssh`. Access is reusable owner configuration, not a separately
authorized Agent service. SSH remains its first consumer; current Run access
requires the chat's effective permission for the exact SSH host.
Native Service Auth interoperability must be verified; S1 contract tests are not
provider E2E evidence. Do not use a production feature override as a test fixture.

#36037 introduced `/api/cloudflare-access/configs` over the existing rows,
revisions and mutation service while temporarily retaining
`/api/ssh/cloudflare-access/configs`, its `hosts` projection and dual
`cloudflare-access:changed` / `ssh:changed` publication for the deployed App.
#36038 moved the standalone page and the retained SSH host form to the canonical
API, `sshHosts` response and canonical event. Both rollout phases operated on the
same encrypted records; there was no feature switch, schema migration, data copy
or Runner contract change.

Production `app.okou.ai` was verified at App `0.944.0`, commit
`3ffd0d5086a02cd8328cf60defab7a242b682273`. That commit contains #36038 and is
tagged `app-v0.944.0`. #36068 therefore raises the minimum supported App version
to `0.944.0` and retires the SSH-prefixed route, `hosts` projection, SSH error
adapter and Access-only `ssh:changed` publication together. Identified App
clients below the floor receive `426` before route matching. This floor increase
is deliberately separate from the release that first published the replacement
App, because production promotes the API before the App.

Standalone Access create, rename and delete publish only
`cloudflare-access:changed`. Effective Service Token replacement also publishes
`ssh:changed` to referencing host owners and invalidates Runner authority for
every referencing protected host. Actual SSH host writes continue publishing
`ssh:changed` and invalidating Runner authority; inline Access creation also
publishes `cloudflare-access:changed` because it changes both resources. Neither
browser event contains a token, configuration ID or host ID.

Unified host forms also accept inline Access creation in the host write request.
Existing `configId` selections remain valid; responses still return only the
resolved binding. Deploy API support before the App uses inline creation. An older
API rejects that write alternative;
clients should refresh after the current API/App deployment, without a second
save path or automatic fallback. Existing rows and older App requests remain
valid, and Runner versions do not need a new decoder for this management change.

Access management and protected host creation require no additional opt-in.
Already-bound hosts are never silently converted to Direct. Removing a binding
requires owner authorization and an explicit Direct selection. Changing owner
clears open secret forms and cancels their pending UI work. API authorization and
database ownership checks remain authoritative; frontend visibility is not an
access check.

SSH save retries (#34503) require a client-generated resource `id` on host creation
and standalone credential/Access creation. New resources return `201`; same-owner
existing IDs return `204` without mutation. Host edits retain their existing
`expectedGeneration` contract. There is no database migration or backfill, and
Runner/guest protocols are unchanged. Deploy the API before the App. This change shipped
under the staff-only pre-GA policy; stale Apps/APIs could reject the new/missing
field or fail to handle `204`. Refresh clients after deployment. Do not fall back to a
new-ID save or automatically replay it. Deduplication only covers the existing
resource's lifetime, not deletion or abandoned forms; see
[SSH access](ssh-access.md#save-retries).

| State                                                              | Required behavior                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Existing Direct data after the additive migration                  | Hosts, credentials, pins, grants and observations remain unchanged; bindings are null.                 |
| Current API and S1 Runner with protected handoff                   | Runner returns unavailable without dialing Direct SSH or forwarding the token.                         |
| Current API and S2 Runner with authorized protected handoff        | Runner uses native WSS/443, verifies gateway TLS and SSH identity separately, without Direct fallback. |
| Current API with an unauthorized host                              | Private authority and guest inventory remain unavailable under owner and Agent authorization.          |
| Pre-Access API with protected rows                                 | Forbidden: the old reader can interpret the row as Direct.                                             |
| Protected writes before the native carrier and real-Run acceptance | Forbidden outside controlled local tests.                                                              |

A rollout switch does not make a protected row safe for a pre-Access reader.
Do not deploy such a reader after protected writes exist; no automatic deletion
or conversion is part of deployment.

#34080 changes the Runner transport without changing guest CLI terminal enums or
the S1 private API contract. Existing Direct requests keep their behavior. A
missing/incompatible authority response fails closed; no pre-GA dual decoder is
introduced. The separate switch removal changes API eligibility and Platform
visibility only; Runner/guest wire contracts and stored credentials stay unchanged.
Old pre-removal APIs may still enforce their Access switch, and old App bundles
may hide Access until refreshed. Deploy the current API/App and refresh clients
rather than adding a compatibility alias or second decoder; see the SSH GA
boundary above. Retired switch overrides are ignored by the existing registered-key
filter; no database migration or destructive cleanup is required.

Run cache invalidations are best-effort and identifier-only. Token/SSH-grant changes
may leave cached authority usable for the remainder of an active Run if a notice
is missed. End those Runs when immediate revocation is required.

#34353 changes only Runner-local authority ownership, not the API, guest RPC or
persisted data contracts. New Runners preserve SSH authority and healthy work
across Ably connection loss, recovery and initial subscription unavailability;
draining old Runners retain their previous disconnect-eviction behavior. First
use/cache misses still authorize through the same API. Delivered invalidation,
failure eviction and Run/sandbox teardown remain effective. The accepted
Run-lifetime missed-notification window includes observed outages; this introduces
no reconnect grace deadline, periodic reauthorization or new TTL. No coordinated
API rollout or migration is required for this Runner change.

### Organization Cloudflare Access foundation (#36260)

Migration `1203` adds `scope` to the existing Access table and `needs_rebind` to
SSH hosts. Existing Access rows default to `personal`, existing hosts default to
`needs_rebind=false`, and their IDs, encrypted credentials, bindings and
generations are unchanged. An SSH Access reference must remain in the same
organization; a database trigger additionally rejects another user's personal
Access. Organization rows have no user owner. A host with a null Access ID and
`needs_rebind=true` remains a protected, unusable host with its 443/FQDN target
and host-key pin intact, not a Direct host. Runner resolution, pinning and
observations return unavailable before any token decryption. The old SSH
management response cannot represent this state and fails closed; no production
path creates it in this foundation release.

The outgoing API remains compatible with the migrated schema for existing
personal/Direct data: omitted columns receive their defaults, and its existing
`INSERT ... RETURNING` and update shapes remain legal. The new API requires
`1203`, so migration-before-API-promotion is mandatory. This release does not
expose organization creation, binding or conversion. Do not enable organization
writes until the foundation is deployed and every serving API authority reader
and Runner path has been verified; an older API or rollback target that joins
Access by user ID cannot safely serve shared bindings. Do not enable conversion
or write `needs_rebind=true` until the rebind-capable App is verified live and
the later App compatibility floor is raised. A rollback to pre-foundation API
after either new state is written is unsafe without first restoring a compatible
authority reader; rolling back code does not roll back persisted state.

### Scoped organization Cloudflare Access backend (#36265)

The canonical Access API accepts an explicit `view=scoped` query on list and
mutations. Without it, the list and mutation responses keep the exact
personal-only shape expected by the currently deployed App, and organization
rows cannot be managed through the old request shape. A scoped response adds
`scope`; organization rows are visible to current members, but only current
admins may create, rename, rotate or delete them. The discriminator is not an
authorization credential. Inline SSH Access creation remains personal, while
members may select same-organization shared rows for their own SSH hosts.
Shared responses contain only the requesting member's SSH host references.
Secrets remain write-only.

Effective shared token rotation advances every referencing SSH host generation
in the same transaction and publishes host-owner Runner/SSH invalidations and
an organization Access-list signal after commit. The organization signal uses
the org realtime channel, not a cached member list; the scoped App must
subscribe to that channel. These notices remain best-effort, so a missed
notice retains the documented active-Run cache window. Referenced deletion is
blocked across all members. Personal records still erase with their owner;
shared records survive a member erasure and are removed with the organization
after SSH references. This release adds no conversion or `needs_rebind=true`
writer.

**Activation gate:** migration `1203` must have run in production, and every
serving API authority reader and SSH Runner must include the #36260 foundation
before this API begins creating or binding shared rows. The first foundation
release reported successful migrations and Runner promotion, but its global
health step was non-blocking; promotion alone is not proof of the entire live
fleet. Verify actual serving versions before production activation. Once a
shared row is bound, rolling back to a pre-foundation API or Runner is unsafe
without first restoring a compatible authority reader. The temporary
personal-only projection is retired only after #36261's rebind-capable App is
live and #36262 raises the verified minimum App version.

### Organization-to-personal Access conversion (#36262)

PR #36449 (#36261) first shipped the rebind-capable App in `app-v0.954.0`.
That tag targets commit `c0cb8cd57d3575a3a82045b0d4bfe8993cdf14b1`;
the [production release run 35962027995](https://github.com/okou-ai/okou/actions/runs/35962027995)
successfully promoted its App Worker at 2026-09-24 06:15 UTC and recorded
version `0.954.0` on `app.okou.ai`. Production `app.okou.ai` was subsequently
verified serving App `0.955.0` at commit
`056f5ab8c347b116352f5353fb304b19796fa1c6`, a descendant of #36449's
merge commit `f129327db18170f2bf9f43fae9bc9ec2245a9cf5`. The production
App Worker promotion in [release run 35966963095](https://github.com/okou-ai/okou/actions/runs/35966963095)
completed successfully on 2026-09-24. The later #36262 release raises the
identified-App minimum version to `0.954.0`, so older identified Apps receive
`426` before route matching and can refresh into the already-live recovery UI.
It also retires the bounded personal-only Access response projection; current
App requests already use `view=scoped`.

Before #36992, the original conversion-preview endpoint contained only an
aggregate count of other owners' SSH hosts and an opaque impact snapshot. The
action requires a current organization admin, expected Access revision, and
unchanged impact. Before #37941, the transaction locked
the Access row before host rows. Conversion detaches other owners' references into
`needs_rebind`, advances effective generations, then makes the same Access row
personal to the admin without decrypting or replacing its Service Token.
Admin-owned SSH references remain bound. After commit, Access-list and affected
owner SSH/Runner invalidations are published. The existing best-effort notice
limit still applies: a missed invalidation can leave cached authority usable
for the remainder of an active Run; end the Run when immediate revocation is
required.

Migration `1210` must run before this API is promoted. Conversion writes cannot
be rolled back to a pre-foundation API/Runner or an App older than `0.954.0`:
those readers do not understand a retained protected host with no Access ID.
Roll forward with compatible readers instead of interpreting such a host as
Direct or deleting it. The API promotes before the App in the normal release;
the prior production App verification makes that order safe for this writer.

### Personal-to-organization Access promotion and reviewed deletion (#36707)

Migration `1222` extends the database scope-change guard to allow the narrow
Personal/owner -> Organization/no owner transition within the same
organization, without moving the row, decrypting its Service Token or
replacing existing SSH bindings. Deploy this migration **before** enabling the
new API route. A current admin may promote only their own Personal row after
reviewing its expanded audience; existing owner-host generations advance.
Existing zero-reference DELETE and name/token PATCH request shapes remain
compatible with scope-aware clients. Older API binaries remain compatible with
the expanded trigger until new state is written; they do not offer the new
promotion or reviewed delete operations.

Before #36992, the legacy deletion-preview endpoint let a current admin review
Organization deletion impact with owner identity and per-owner host counts. The
optional opaque snapshot is required only when other owners' hosts are affected. DELETE rechecks the exact revision and host
set under its mutation fence (Access-before-host before #37941), blocks any actor-owned reference, and
atomically detaches only other owners' references into `needs_rebind` before
deleting the config (the same-org FK remains restrictive). Profiles missing
from the member directory are shown by stable owner ID; their hosts still
count. Any changed host set requires a fresh review. No affected-member
message, new SSH/Runner cache invalidation or active-Run cancellation is
added by this delete path. Fresh reads and SSH resolutions treat retained hosts
as protected and unusable until explicitly rebound. An already-running Run
may retain cached capability until completion; this is an accepted bounded
Run-lifetime window, not immediate revocation.

The already-shipped rebind-capable App and shared-aware Runner are prerequisites.
After a member binds a promoted row or a reviewed deletion writes
`needs_rebind`, rollback to pre-foundation API/Runner or pre-rebind App is
unsafe; roll forward with compatible readers. The API-before-App release order
is safe once migration `1222` and those prerequisites are verified.

### Cloudflare Access trigger retirement (#37355, #37369)

The intended SSH create/update admission protocol validates a referenced config
in its transaction: it selects only a same-organization shared config or the
actor's own Personal config with a config-row `FOR SHARE` lock before binding.
The later current-main investigation in #37941 found create using an unlocked
transactional read and edit using only a preflight read; that repair restores
transaction-held shared admission and fixes the configuration/host inversion. Inline SSH creation
inserts its Personal config in the same transaction. Config creation limits
Organization scope to current admins; name/token update, reviewed delete and
both conversion writers lock the config `FOR UPDATE` before changing it.
Organization-to-Personal conversion detaches affected other-owner bindings
before the scope change. Credential rotation, Runner pin updates and chat access
updates change other SSH fields; Clerk user/org erasure deletes SSH references
before their configs. The same-organization FK and scope/destination/rebind
CHECKs remain independent database constraints.

Personal-to-Organization promotion additionally checks only references to the
selected locked config for a different owner, rejecting an incompatible
retained binding before any update. Migration `1290_retire_cloudflare_access_triggers`
then drops the two legacy Cloudflare Access triggers and their unused functions
without replacing them. It retains historical migrations and ordinary
constraints. Privileged direct SQL no longer receives these trigger-specific
ownership and transition checks; use the supported API writers instead.

**Mixed-version release boundary:** the owner chose one PR for the writer and
contraction. Migrations run **before** the new API is promoted, and API rollback
does not reinstall triggers. At the 2026-09-29 12:55 UTC inspection, the
production Vercel aliases `api.okou.ai` and `api.vm0.ai` both resolved to READY
API deployment `dpl_3VXLTDFhv46gJcnVPjSc4hs4EXac` at
`8d7d64c6ca9daac1d35ed50d2e44fe19006998f7` (`api-v1.698.0`). The
current rollback resolver already rejects APIs before the canonical commit
`bb7996407cbf06854852966ef1c5fc04a390d4d2` that adds migration 1287.
At that floor, the Cloudflare/SSH binding and owner-cleanup writer files are
identical to the pre-PR main: supported old writers already reject another
user's Personal binding and serialize scope/binding changes through config row
locks. They lack the new promotion-side defensive check for an already corrupt
retained binding, but supported writers could not create that state while the
legacy triggers were enabled. The owner accepted this bounded migration-first
window, not a general guarantee for external SQL, catalog drift or corrupted
rows. Recheck the serving aliases and rollback floor before releasing the
contraction. A PR merge, CI pass or smoke-clone migration does **not** establish
production migration journal completion; record it only after the real release.

### Cloudflare SSH concurrency repair (#37941)

Credential rotation, deletion, Personal-to-Organization promotion and
Organization-to-Personal adoption acquire current referencing hosts in UUID
order with `FOR NO KEY UPDATE`, then the configuration `FOR UPDATE`. The weaker
host lock remains compatible with implicit `FOR KEY SHARE` checks from restrictive
parent-login deletion. Runner pin/observation continues to acquire its host
before shared login/configuration authority.

The local optimization in #37975 separates metadata-only rename from that
fanout protocol. The #38279 follow-up replaces its config-only transaction and
locking read with one atomic statement: a conditional `UPDATE ... RETURNING`
CTE plus an owner-filtered host-ID/name response join. The update itself enforces
visibility, current-scope management permission, expected revision and revision
exhaustion, and changes only name/revision/time, not config generation. A rejected
write is classified by a fresh visible-config read without retrying it. The
response query and write succeed or roll back together; host metadata is now a
nonlocking statement-snapshot observation rather than a later transaction
snapshot, never an impact or authority check. Rename takes no explicit config
or host row lock and writes no host state; ordinary UPDATE row arbitration
preserves revision conflicts without a reverse host-lock edge. Host generations,
learned pins, independent login, endpoint, binding and rebind state remain
unchanged; only the existing configuration metadata invalidation runs after
commit, using the returned scope. Config-only #38003 rename and these atomic
writers can coexist through the same revision contract without a migration or
client cutover.

Selected host create/edit rechecks same-organization Organization or same-owner
Personal visibility with `FOR SHARE` inside the write transaction, before inline
resource inserts, held through commit. An existing-host edit first locks and
reloads its host and rechecks the expected host generation. The unlocked early
check rejects a bad selection before preparing a new login; it is not commit
authority. Configuration existence and the same-org FK do not prove Personal
visibility, and `FOR KEY SHARE` does not fence a non-key scope change.

After the exclusive configuration fence, each authority-changing mutation
counts current references with the same org/config predicate and reuses its
first locked metadata result, instead of loading all host metadata again.
Under PostgreSQL READ COMMITTED, the locking reader rechecks a concurrently
changed tuple before returning it: deleted/rebound nonmatches are omitted, and
updated matches are returned locked. Every actually returned member therefore
remains in the fresh count's set; its retained lock prevents deletion, rebinding
and relevant metadata changes. Config `FOR SHARE` admission prevents later
incoming bindings from escaping the exclusive configuration fence. The locked
set is a subset of the counted set, so equal counts prove equal identities under
these premises, not for arbitrary sets. A smaller count or missing aggregate row
fails as an invariant violation. Impact, exhaustion and incompatible-owner
checks use the complete retained records, including their current generations.

The follow-up in #38278 removes automatic transaction retries from all four
authority-changing commands. A larger count returns the existing revision
conflict before any business write; each command makes one attempt. The caller
may inspect current state, obtain fresh impact where required, and explicitly
submit a new request. No transaction acquires a new host in reverse order after
the configuration fence, and no exception/deadlock or ambiguous write is
replayed. Current revision, management/scope, exhaustion and exact impact checks
precede business writes.

Each remaining short command-owned transaction preserves a related-write
invariant: rotation couples credentials and host generations; deletion couples
protected detachment and config deletion; promotion couples scope/owner and host
generations; adoption couples other-owner detachment, own-host generations and
scope/owner. The reference count also requires a fresh READ COMMITTED statement
snapshot after the exclusive config fence, including after any lock wait. Simply
collapsing these reads and writes into a single-statement CTE would retain its
initial statement snapshot, not this post-fence membership check.

An empty-set preview cannot authorize affecting a newly bound member host.
Encryption stays outside transactions; identifier-only best-effort notices and existing batching/cache windows stay post-commit. Login, target,
learned trust, atomic generations and explicit protected `needs_rebind` behavior
are preserved. Counting still scans references and token rotation still advances
N persisted host generations synchronously; no measured latency/throughput gain
is established by the structural optimization.

No schema, migration, App/Runner DTO or provider changes are introduced. The
#37955 host-first writers, #37975 optimized writers and #38278 single-attempt
writers can coexist with the same authority and generation contracts. The
single-attempt policy may return a conflict earlier instead of internally
retrying, but needs no new migration or client cutover. Older pre-#37955 API
configuration-first/unlocked writers retain the original concurrency risks while
serving; code merge or green CI does not prove that they have drained.
This change does not authorize production drain, deployment or activation.
Independent SSH-login revision semantics are unchanged. Writer inventory found
login rotation host-before-login and Clerk cleanup host-before-login-before-config,
but their bulk host updates/deletes are not explicitly UUID-ordered. This is
an investigation boundary, not a demonstrated new cleanup defect or proof of
global deadlock freedom. Tests use native PostgreSQL and genuine API/authorized
Runner lifecycles, never SQL barriers or private business-row construction.

### Cloudflare Access impact-review presentation (#36988)

The new App requests the admin-only `GET /api/cloudflare-access/configs/:configId/impact-preview`
with `operation=convert|delete`. It receives affected-member identities and one
aggregate count of other-owned SSH hosts; it never receives another member's
host ID, name, destination, credential or per-member host count from this new
endpoint. The action's expected revision and exact impact snapshot are the
same guarded values used by the existing conversion and deletion transactions.
Directory names are best-effort: a null name does not establish former
membership. The App shows an ID suffix only to disambiguate missing or duplicate
names and never normally prints complete raw member IDs. Neither operation
sends notifications or changes `needs_rebind`/Run/VNC behavior.

### Legacy Access impact-preview retirement (#36992)

The first named-preview App, `app-v0.970.1`, targets
`56980b16a2d241acd05d29de63d5ff7d0a9a8019` and includes #36991 merge
`b3119bb78e8523e6ce5dab33a541e4b5851aff81`. Production App Worker
[deployment 6676046456](https://github.com/okou-ai/okou/deployments/6676046456)
succeeded at `54f7df05ceb1446b8ff7db129dac302ac2d9fb94` with App `0.970.2`
on 2026-09-26 07:23 UTC. Production API
[deployment 6676030640](https://github.com/okou-ai/okou/deployments/6676030640)
succeeded at that same commit on 2026-09-26 07:21 UTC; the later
[deployment 6678761353](https://github.com/okou-ai/okou/deployments/6678761353)
succeeded at descendant `00d9e144332c817636eeba3932fc86922d3c6db4`
on 2026-09-26 12:23 UTC. All these releases include the new route.

#36992 raises the identified-App minimum from `0.963.3` to `0.970.1` in the
API, so an older App advertising a parseable version receives `426` **before**
route matching on its next handled API request. An already-open tab must choose
to reload; there is no forced background refresh. The general minimum-version
mechanism does not force-upgrade a missing or unparseable version or a non-App
client. The legacy `/conversion-preview` and `/deletion-preview` routes and
response contracts are removed, as are the new App's 404 retries to those
routes. The new `impact-preview` remains admin-only and returns identities and
aggregate SSH host usage; conversion and deletion still recheck the exact
snapshot and revision. A client that calls a removed route no longer obtains
per-owner usage from it.

At the requester's explicit direction, **older production rollback artifacts
are not supported by this cleanup**. The production rollback dashboard still
records older API/App releases; this change does not prove them compatible or
remove them from history. Rolling API or App back below the #36991 and `0.970.1`
boundaries requires a separate coordinated compatibility decision. Production
API promotes before App; the capable App has already been confirmed live before
this minimum is raised. Neither VNC enablement nor a production deployment is
performed by the issue implementation PR.

## Feishu and Lark integration identity

New runs use `triggerSource=feishu` or `triggerSource=lark` from the verified
installation loaded by the shared Feishu queue launcher. Both platforms keep
the existing Feishu event context, delivery callbacks, and provider transport.
Previously queued inputs still resolve their installation before creating a
run, including ingress retries and queued follow-ups. Captured execution
contexts and existing runs retain the source they were created with.

The run and uploaded-file source columns are strings, so their new source needs
no database migration. Historical `feishu` runs and existing input assets are not
rewritten: the source alone cannot prove which platform created them. The App
retains its existing historical Lark display label only when the captured
integration prompt explicitly identifies Lark. New run logs, filters, runtime
guidance, and file attribution consume the canonical source. The deprecated
billing usage source projection continues to classify both platforms as `other`.

New chat messages also persist the verified platform in their `source.kind`.
The App reads `lark` directly; it retains the existing historical Lark label for
`feishu` messages only when their stored link explicitly uses the Lark app-link
domain. Historical message documents are unchanged. APIs and Apps predating the
new kind cannot parse those new strict message documents, including chat history
and queued input. Keep a capable API while such records remain readable and
refresh old Apps after promotion.

Migration `1166_feishu_platform_agent_preferences` adds
`feishu_platform_user_agent_preferences`, keyed by user, organization, and
platform. `/switch` and `/switch default` affect only the current platform.
The unscoped historical preference table remains untouched: its records do not
identify which platform selected the Agent, so they are neither copied nor read
by new dispatch. Each platform initially uses its installation default until the
user makes a new selection. Existing chat history and runs are retained.

The additive migration preserves every outgoing API statement against the old
table. It must complete before promoting the new API; new code requires the new
table. Old and new APIs do not synchronize preferences: during the non-GA cutover
or rollback, each reads its own table. Recover by restoring the capable API;
do not copy unscoped selections into both platforms.

Both integrations remain non-GA under their existing disabled-by-default
switches (`FeishuIntegration` and `LarkIntegration`). Deploy the capable API
before the matching App; already-open Apps may need a refresh to display the
new Lark label. No new switch, App floor, Runner protocol, or rollout bridge is
introduced. The Runner transports prepared execution context without parsing
a trigger-source enum.

An API predating this reader cannot safely serve new Lark chat documents, queue entries,
canonical delivery callbacks, or captured deferred Pi launch intent. Retain a
capable API for serving and rollback while these records can be consumed;
disabling ingress does not remove persisted runs. Recovery from an older API
requires restoring the capable API, not relabeling Lark data as Feishu. This
non-GA cutover does not promise transparent rollback to the previous reader.

## Integration source links

Telegram bot DMs, Teams chats, and AgentPhone DMs store their return link in
the existing optional `source.href` field of the V1 user-message document.
No new document fields, context columns, or migrations are introduced. Older
Apps and APIs already accept these URLs, including `sms:`; older Apps may
label a conversation link as an original-message link until refreshed.

New Apps distinguish message links from conversation links by the provider's
documented URL shape. Events already stored without `href` remain unlinked;
their immutable user-message documents and archived snapshots are not rewritten.
Telegram DMs open the bot conversation. Teams Bot Framework `a:` IDs open
the bot chat using its `28:` recipient rather than pretending to be Graph
`19:` chat IDs. AgentPhone DMs open Messages addressed to the inbound destination
(the assistant number); group events do not expose a single-recipient link.

Desktop adds a narrow external-navigation allowance for single-recipient
`sms:+E164` links without query parameters or fragments. Older Desktop builds
continue to deny these links until the Desktop update is installed; browser
delivery does not upgrade the Electron navigation policy. Opening Messages
requires a registered handler on the user's device and does not send a message.

## Integration input attachments

New Feishu/Lark, Teams, Telegram, and AgentPhone trigger attachments use the
existing canonical input asset rows and `R2_USER_ARTIFACTS_BUCKET_NAME`, as Slack
does. Successful imports emit the existing `userMessage` file part and
`[Web file]` prompt format; existing frontends and pinned CLIs can read them
without a coordinated release. Provider download commands continue to accept
their original IDs.

Feishu, Telegram, and AgentPhone store the resolved prompt in their existing
launch context. Teams adds an optional `messageFiles[].canonicalAsset` object;
new readers fall back to the original provider reference when it is absent,
and old readers can still resolve that retained provider reference. Both queue
launch and active input delivery read this persisted context. No database
migration or historical attachment backfill is required. Failed imports retain
the canonical file part and the provider-native prompt reference, matching
Slack. Only ready imports emit a `[Web file]` prompt.

All adapters share MIME validation, streamed size enforcement, a 10-second
per-file import timeout, and retry classification: HTTP 429/5xx and transient
failures remain retryable; other HTTP failures and invalid/unsupported/oversized
files do not. The general size limit is 100 MiB; Telegram retains its Bot API
20 MiB download limit.

The new adapters deduplicate across messages by user, organization, installation,
and stable upstream file identity. Message IDs remain provenance, not identity.
Telegram uses `file_unique_id`; Teams uses file `uniqueId` where available.
Resources without a provider file ID use a hash of the full resource URL, so
unrelated attachments with the same message-local attachment number cannot
collide. Slack retains its existing user/file-ID identity, including existing
canonical asset rows. This does not deduplicate equal bytes under distinct
upstream resource identities.

## VNC X509Plain Runner authority

The private VNC resolve request now accepts two exact Runner capabilities:
`vnc_password` / `x509_vnc` and `username_password` / `x509_plain`. Deploy the
widened API before the Runner. Old Runners continue advertising only X509Vnc and
the new API returns their existing response shape. New Runners against an older
API fail closed; they do not retry a saved X509Plain connection as X509Vnc.

The Runner response decoder remains strict and rejects unknown fields and tags.
The Runner then rejects cross-paired authentication and security variants before
DNS or socket creation. The common generated secret wrapper enforces the largest
wire bound and zeroizes its value; the selected engine authentication type
enforces the profile-specific bound.
Future authentication support adds another explicit method/profile pair and its
typed fields rather than widening an existing discriminator's meaning.

This change requires no migration, stored-data rewrite, guest/CLI protocol
change or feature-switch activation. Existing saved rows keep their exact
discriminators. Roll back the Runner before the API; once a Runner can advertise
X509Plain, retain the widened API request/response contract for the lifetime of
that process.

## VNC X509None owner-selected rollout (default off)

Migration `1289_thick_bruce_banner` makes `vnc_connections.credential_id` nullable only for the
exact `none` / `x509_none` profile; existing credential-backed rows and the
retained direct-route default keep their meaning. Apply it before promoting an
API that can write credentialless rows.

- Old App with new API: existing credential-backed responses retain their shape.
  An App predating this profile cannot be relied upon to read or edit new
  credentialless metadata. Do not admit X509None rows while such clients need
  to manage the owner's VNC hosts; a cached old App needs a refresh after the
  compatible App is available.
- New App with old API: the default-off switch keeps this owner flow hidden.
  If staff enable it across a mixed deployment, the old API rejects X509None
  selections and cannot return the new response shape; there is no fallback to
  a credential-backed profile.
- Old Runner with new API: its advertised profile list lacks the exact
  `none` / `x509_none` tuple, so resolving such a saved row returns
  `unsupported_profile` before KMS or a session. Existing profiles retain their
  existing behavior.
- New Runner with old API: it advertises the added direct and SSH tuples even
  when resolving an older connection. The old strict `supportedProfiles`
  request schema rejects that list, so **all** VNC resolves on that pairing
  fail closed. Promote the compatible API before the new Runner; do not retry
  with an old profile list or infer a downgrade.

Before any X509None row is admitted, every serving API reader and intended API
rollback target must understand the nullable credential and the new response
variant; deploy the compatible App for owners who may encounter that row. An
older API's credential inner join omits such rows, so rolling back below that
reader after an X509None row exists is unsafe even if `VncAccess` is disabled
again. A later rollback below the reader floor needs a separate verified data
and drain decision. No merge, migration, CI result or this compatibility
assessment activates `VncAccess` or certifies an Agent/server acceptance run.

## VNC owner-selected QEMU client certificates (default off; #37375)

Migration `1296_little_electro` follows `1295_chat_thread_canonical_session` and adds nullable `vnc_credentials.encrypted_client_identity`, relaxes `encrypted_password` only for `client_certificate`, and replaces the exact credential and connection profile checks. No old row is rewritten. Apply migration before promoting the new API. The old API sees a compatible nullable column and existing rows during the migration-to-promotion window. Do not admit new certificate-bearing rows until the compatible API and App are promoted, because an old API cannot parse new auth discriminators (and cannot safely resolve or list these records). The first main commit with the compatible API is an explicit **API reader rollback floor once any new row exists**; disabling the feature afterward does not remove that floor. This document is a rollout requirement, not evidence that the floor has already been installed or new rows have been admitted. A rollback below it needs a verified row cleanup and drained readers decision, not an implicit downgrade.

- Old App with new API: existing rows preserve their response shape. New certificate-backed connections carry an additional `clientCertificateAuthentication` metadata field, so a strict old App cannot manage them; refresh the App before admitting such rows. New App with an old API: strict contracts reject new variants; do not submit them during mixed promotion.
- Old Runner with new API: an exact new tuple is absent, so `unsupported_profile` is returned before decryption; existing `none/x509_none` and `vnc_password/x509_vnc` keep their certificate-free behavior. New Runner with old API: its widened strict `supportedProfiles` request is rejected; **all** VNC resolves fail closed on that pairing. Deploy API before Runner and do not retry a legacy tuple.
- New API with new Runner: only the winning authorized Runner receives the KMS-decrypted identity in a private no-store response. The API rechecks authority after KMS. Owner/Agent list metadata never receives keys or passwords. Saved SSH permissions, TLS server CA/name, generation and active-session checks are unchanged. The operational KMS rotation recovery manifest lists both encrypted VNC columns; run that current-version recovery tool against a migrated schema (older snapshots need the corresponding older tool until migration), and verify both password and identity envelopes during key rotation.

Neither migration, merge, CI, independently configured loopback QEMU acceptance nor the client CertificateRequest alone proves production server `verify-peer=on` or a real Agent session. Before production activation record the server's client-CA/ingress policy, untrusted-client rejection for both subtypes and a separate real owner→Agent→Runner capture; `verify-peer=off` is an insecure negative control that accepts an unrelated-CA client. Do not modify a production VNC server, SSH service or `VncAccess` in this change. A supported server-side revocation guarantee is not asserted.

## Testing Expectations

Tests should cover cross-version behavior when a change touches a deployment
boundary.

For frontend/backend API changes:

- Test the current request shape.
- Test the previous frontend request shape while it can still reach the API
  during rollout; after an enforced floor and completed drain, test rejection
  of the retired shape instead.
- Test missing new response fields or old response shapes when frontend code can
  receive them during rollout.

For runner/backend API changes:

- Test old runner requests against the new backend handler.
- Test new runner code with old/missing backend response fields when the runner
  can be deployed before all backend instances are updated.
- Include poll, claim, heartbeat, completion, artifact, and session-resume paths
  when those protocols change.

For persisted state changes:

- Test reading rows or payloads written by the previous version.
- Test old backend behavior against the migrated schema when the migration runs
  before code promotion.
- Populate the pre-migration schema, upgrade it, and exercise the previous API's
  real statement shapes through every compatibility view or trigger. Include
  `INSERT ... RETURNING` and `INSERT ... ON CONFLICT` paths, plus ORM-generated
  column lists; testing only handwritten reads missed the `0722` failure mode.
- Test that new writes do not break the previous deployed reader during the
  rollout window, or document why the old reader cannot observe the new data.

Do not add broad defensive fallbacks just to hide incompatibility. The goal is a
specific compatibility contract for the rollout window, with clear deletion
criteria after the old version is gone.

## Connector OAuth completion receipts

Successful browser authorization start responses require `oauthAttemptId` for built-in OAuth/OpenID and custom HTTP/MCP OAuth. Custom automatic-no-auth `connected` responses do not start browser authorization and do not carry an attempt ID. A successful callback records a short-lived receipt only after credential persistence and required Agent authorization/linking finish. The authenticated, uncached `/api/connector-accounts/oauth-completions/:attemptId` lookup validates the current user, organization, connector target, and actual connected account. Receipts expire 15 minutes after success; account deletion cascades to receipts, and the existing OAuth-state cleanup cron removes expired receipts in bounded batches.

The App uses the exact attempt receipt, not account timestamps, account counts, or sibling-account presence, to continue the flow. The callback's existing single-use state claim remains unchanged. Counts still determine the first-account Agent-grant policy, not OAuth success.

- Old App → new API: existing requests remain valid; the new response field is additive. Already-loaded old pages retain their previous completion heuristic until refreshed.
- New App → receipt-capable API: the start ID is required, but an ID alone does not prove completion. Pending, missing, expired, or inaccessible receipts and reconnect account mismatches never continue the flow or grant access.
- The new table is additive and does not change existing OAuth-state or connector-account rows. No Runner protocol changes or immediate App minimum-version increase are required.

The receipt-capable writer from [#32880](https://github.com/vm0-ai/vm0/pull/32880) shipped in release `3d58eaa4609967a4f655f7cd61d0d7cd454ba2a1`: API `1.575.2` completed [production promotion](https://github.com/vm0-ai/vm0/actions/runs/34335229479/job/102417239410) on 2026-09-09 at 09:48:46 UTC, followed by App `0.873.0` at 09:50:38 UTC. Cleanup [#32870](https://github.com/vm0-ai/vm0/issues/32870) retires the optional response field and absent-ID branch after that release. The maintainer explicitly excludes old API rollback compatibility; no rollback restriction is added or changed. Pre-receipt APIs are outside this cleanup's supported boundary. Existing App requests remain accepted, and already-loaded pre-receipt App bundles are not retired by this change; no App version floor increase is included.

### User cancellation in the App

Cancelling a connector connection aborts the current App attempt: owned requests
and polling stop, its popup closes when the browser still permits access, busy controls are
released, and unfinished local continuations (including account naming and Chat
callbacks) must not start or update a newer attempt. The dialog's Close control
and Escape have the same meaning; outside presses do not cancel pending work.
Connector authorization progress surfaces add no separate Cancel action; forms
that already provide a general Cancel action keep it. Provider isolation
policies can sever the popup handle, so closing that external window is
best-effort and is not required to release the App's attempt.

This is **local cancellation**, not a provider revocation or an API transaction
rollback. The API may already have claimed OAuth state and may finish persisting
credentials, grants, and the completion receipt after the App stops waiting.
Keep those accounts and reconcile them through normal refresh/notifications;
never delete accounts or revoke credentials as compensation. A late receipt
cannot resume a cancelled App attempt, but it does not prevent an already-started
API reconnect callback from writing the same account after a newer callback.

No API, persisted-state, or Runner contract changes are needed. Already-loaded
old Apps retain their previous, non-cancellable behavior until refreshed. A
stronger cancellation or reconnect-write-order guarantee would require a
separately designed server protocol.

## Pi memory summary storage and injection budget

A valid `memory_summary.md` may exceed 2500 exact o200k tokens on disk. The
2500-token budget belongs to the summary excerpt injected into the model prompt,
including its truncation marker, not to the stored artifact. The 64 KiB UTF-8
source ceiling, `sourceHash`/`sourceSize`/`tokenCount` full-source metadata, the
frozen storage version identity and the immutable-path guards are unchanged.

The reader slice of [#33351](https://github.com/vm0-ai/vm0/issues/33351) widened
acceptance only:

- `piMemoryRecallSelectionSchema` bounds the ready selection's full-source
  `tokenCount` by the 64 KiB source ceiling instead of the injection budget.
- API-first and sandbox recall authenticate the complete source bytes, hash,
  size, content and exact token count, and then render one bounded excerpt
  through the shared deterministic truncator.
- The API projection read path no longer treats an authentic larger source as a
  read-integrity mismatch, so it does not requeue that row.

That reader shipped in release
[#33469](https://github.com/vm0-ai/vm0/pull/33469) /
`9ce193854ab828baeec40579a6d36cdf2d4dbf73` (API `1.584.1`, `pi-agent-runtime`
`1.25.1`, `api-contracts` `1.428.1`, CLI `9.323.12`). The producer slice then
stopped capping sources by tokens:

- Phase 2 output validation rejects only genuine problems: invalid UTF-8, a
  missing `v1` header, a source above 64 KiB, immutable-path violations and a
  failed or incomplete atomic publication. A valid larger source publishes in
  full together with its `MEMORY.md` and skills. `summary_tokens` remains a
  parseable historical diagnostic; new runs no longer produce it.
- Projection materialization classifies token-only excess as `ready` and stores
  the complete source with its original `sourceHash`, `sourceSize` and exact
  `tokenCount`. Archive, file-size, path, link, duplicate, hash and encoding
  rejections are unchanged, and existing terminal `over_limit` rows are neither
  mutated nor requeued by this change.
- `phase2_write` and `phase2_edit` return content-free numeric feedback for the
  resulting whole `memory_summary.md`: UTF-8 bytes, the 64 KiB ceiling, exact
  o200k tokens and the 2500-token injection target. Above the byte ceiling the
  token count is reported as `unmeasured` so feedback stays bounded, and output
  validation still rejects that source.

Rollout ordering is a correctness requirement, not a preference:

- old runner -> new backend: a `pi-agent-runtime` without the widened reader
  rejects a larger source and injects no memory. Producers must not emit larger
  sources while such runner versions remain eligible to consume them; the
  reader release above is the gate that made this safe.
- new runner -> old backend: unchanged. An old backend keeps producing sources
  within the injection budget, which the new reader accepts and leaves intact.
- Frozen selections are pinned per run, so a resumed or pinned run keeps the
  epoch and reader decision it started with. New launch contexts bind the
  serving API's commit-addressed CLI package; a package tag alone does not
  prove runtime availability.

Rolling the backend back below the reader change restores the old read-side cap:
an already stored larger projection is then read as a read-integrity mismatch
and requeued, and materialization re-classifies it as `over_limit`. Rolling back
below the producer change only stops new larger sources; it does not rewrite
what was already published. The stored source itself is never truncated or
rewritten by any reader, producer or rollback.

## Connector catalog v4 consumption

Publish the complete v4 catalog before deploying the consumer. The new API
syncs, accepts and reads only v4. Discovery, execution and firewall permissions
use that same accepted-v4 reader. A cold environment reports the catalog as
unavailable until normal v4 sync succeeds. The release workflow stays unchanged;
no environment variable, generation selector or separate warm-up endpoint is
needed. MCP capability filtering does not block catalog acceptance.

Earlier API binaries continue using their v3 namespace and rows. No database
migration, source-salt change or historical-byte rewrite is needed. New APIs
require an accepted v4 snapshot. Later candidate failures retain v4, and a
corrupt accepted v4 snapshot fails. Diagnostics describe the same v4 generation
used by the current reader.

The current catalog storage and writer are described under the
[Release 2 contraction](#connector-catalog-release-2-contraction-migration-1334).
Production diagnostics reported active catalog
`2026-09-19.4560` on 2026-09-20 Asia/Shanghai, opening the v4-only reader gate
under [#34913](https://github.com/vm0-ai/okou/issues/34913). Historical v3
objects and rows remain available to older rollback binaries through their own
v3 readers; current code performs no data deletion or rewrite.

### Builtin MCP execution

Builtin MCP uses the current App, CLI and Runner contract directly. There is no
MCP-specific request-header negotiation, old-client HTTP projection, upgrade
response or Runner claim capability flag. Agent connector replacement applies
to the complete submitted list, including MCP grants. The CLI is kept current;
its package URL does not need to match the serving API commit for MCP admission.
Custom and builtin MCP use the same typed discovery response.

Queued Runs retain their captured CLI package and exact account mapping.
Builtin MCP admission requires the Run's Okou token for authenticated MCP
discovery. None/manual and Automatic methods are executable. Plaud's Automatic
method defaults off in auth-method discovery through `plaudConnector`; this
switch does not gate existing account callbacks or execution.

Outside the platform API admission path, connector intent affects registered
builtin eligibility and final owner disambiguation; it is not a credential-identity
lock. After gathering active firewall base matches, the addon excludes registered
builtin candidates when a registered custom candidate matches, unless present intent
identifies a matching registered builtin. This filter precedes base/rule specificity,
even for a broader custom base and narrower builtin base. Classification comes from
registry-owned `connectorRuntimeTargets`; unclassified firewall entries are not
excluded by this rule. A matching custom denial or malformed configuration does not
reconsider excluded builtin candidates.

The remaining candidates undergo base specificity, matching rule specificity, then
owner disambiguation. The builtin-intent exception retains eligibility, not an
override of specificity or authorization. One eligible owner governs the request even
when intent is absent, malformed, mismatched, or names an absent owner. Removing a
builtin at an overlapping destination can therefore leave a sole eligible custom
owner whose credentials may be injected, subject to its authorization checks.
Multiple eligible owners require valid intent selecting one of them; unresolved
ambiguity is blocked. With no active firewall match, ordinary network fallback
applies without resolving or injecting managed connector credentials. See the staged
contract and broader-custom/narrower-builtin example in
[ordinary connector firewall owner selection](mitm-addon-contracts.md#ordinary-connector-firewall-owner-selection).

This ordinary selection rule does not relax the separate
[platform connector authorization path policy](mitm-addon-contracts.md#platform-connector-authorization-path-policy),
including the `/mcp` intent-admission gate, or the HTTP 409
`connector_auth_owner_conflict` guard for confirmed authentication on a unique
inactive route. The selected owner's permission, network-policy, destination,
credential-resolution, and current-owner revalidation checks still apply.

No-auth builtin and custom MCP requests skip credential validity checks and
proxy auth resolution, including Automatic builtin and custom MCP resolved to no
authentication. Credentialed builtin MCP auth responses use the existing `expiresAt`
field to cap cached account authorization at 30 seconds from validation; this
also bounds static-token cache reuse. Discovery immediately removes deleted
accounts, while subsequent proxy requests may reuse an existing lease until
expiry. Expiry does not interrupt an in-flight request or stream. After
resolution, the addon rechecks the current owner before forwarding. No new
HTTP/custom cache policy is introduced.

Automatic authentication adds separate builtin OAuth bindings and DCR
registrations, plus a nullable account auth-resolution field. Apply this
additive migration before deploying the API. The shared MCP protocol supports
CIMD/DCR, PKCE, validated issuer discovery and authorization responses, and optional refresh tokens.
Builtin callbacks are owned by the API and completion receipts identify the
exact account and attempt. Stored catalog method IDs remain unchanged.

Automatic accounts receive the same compact builtin firewall reference used by
builtin HTTP connectors. The Runner resolves its definition, including auth, from
the accepted catalog; account state does not replace or override that firewall.
An OAuth catalog firewall uses the proxy-only
`Bearer ${{ secrets.MCP_ACCESS_TOKEN }}` template, resolved outside the sandbox.
Automatic discovery still records whether the selected account resolved to OAuth
or no-auth. A mismatch fails at its natural boundary: an OAuth catalog firewall
cannot resolve its required secret from a no-auth account, while a no-auth catalog
firewall sends an OAuth account's request without credentials and lets the upstream
reject it. Builtin runtime-sync updates remain policy-only. There is no MCP-specific
client or Runner capability negotiation. A rollback after Automatic accounts exist
must retain their schema and credential readers.
The addon sends `matchedFirewall.base` when resolving builtin credentials.
The contract hash retirement described above removes the Automatic-specific
comparison against current and historically bound destinations. Catalog and
ordinary Run/account authorization still determine the selected account; no
configuration fingerprint or historical destination lock is applied.

The current connector catalog reader is v4-only as described above. This
execution change adds no environment variable, release workflow change or
per-service skill.

## PostHog CIMD OAuth

PostHog OAuth uses a public client identified by
`https://app.okou.ai/connectors/posthog/metadata.json`, with PKCE and no
client secret. Deploy the API support for static public authorization-code
clients and the updated public metadata before publishing the companion
`okou-ai/okou-connectors` catalog change. Earlier API versions reject the public
client during catalog relationship validation; catalog publication must wait
until those versions no longer serve traffic. If the API must roll back below
this support, restore a compatible catalog first through the normal catalog
release process.

The new API can load the old confidential-client catalog. Its capability
filter hides only the incompatible PostHog OAuth method until the companion
catalog is published; the personal API-key method remains available. PostHog
OAuth is available to all users when its catalog method is compatible and visible.

OAuth storage version 2 adds the account's region and API base URL and changes
the client identity. Version 1 OAuth accounts must reconnect through the
existing storage-version lifecycle. US provider user IDs remain unchanged;
EU IDs have an `eu:` prefix to distinguish independent regional ID namespaces.
The personal API-key storage version stays at 1. No frontend, Runner, or
production data migration is required.

## Storage presigned URLs use a fixed two-day lifetime

All first-party object-storage GET, PUT, and multipart-part URLs are signed for
172800 seconds. API responses that advertise expiration use the same shared
constant, including reference images, private previews, registry archives, chat
snapshots, and exports. Private hosted preview tokens retain that same two-day
lifetime. Provider-owned URLs and OAuth token lifetimes are unchanged.

The app no longer renews preview credentials on a timer or after media errors.
Presigned uploads and Runner/Guest object downloads make one application-level
attempt, except for content-addressed session-history uploads. History uploads
make at most three total attempts (the initial PUT plus two retries) with the same
presigned URL and exact bytes. They do not renew the URL or change request,
upload, or overall run timeouts. Exhaustion preserves the existing unavailable
history outcome; Pi H2 still rejects a checkpoint without a native history hash.

Existing preview-resolution API contracts remain available to deployed older app
and CLI versions. Old Runner versions can consume the longer-lived URLs without
a wire-format change. Older Guests retain their single-attempt history policy;
both policies use unchanged prepare-history and checkpoint wire contracts.

Storage URL caches are read on demand. Updated APIs reuse manifest archive
URLs in `system_storage`, `workflow_skill_storage`, and `readonly_storage` only
with at least four hours remaining at selection, including captured or
prefetched snapshots; exactly four hours remains reusable. Missing, expired,
or below-margin entries use the existing signing path during the normal API
request. This margin does not shorten the two-day signature lifetime or change
cache keys. Private artifact previews retain their strict one-hour margin, and
presentation template previews retain expiry-only reuse. Old APIs retain their
previous reuse cutoff until deployed; archive URLs already persisted in Run
contexts are not retroactively renewed. There is no proactive refresh or
retry. The cron endpoint is now
`/api/cron/prune-storage-presigned-urls` and only removes expired cache rows.
Cache keys include the lifetime, so new code does not reuse the previous shorter
policy. The database's required `refresh_after` and `last_requested_at` columns
remain writable for deployment coexistence; new rows set `refresh_after` to their
expiration and new code does not use either column to schedule renewal.

## API-first usage handoff producer (#35413)

The consumer contract and tolerant readers are delivered by #34787. This
follow-up enables the API to add optional `apiUsage` metadata to the existing Pi
ownership-transfer manifest and durable continuation. Before deploying this
producer, confirm those readers are deployed and older strict readers have
drained.

Old payloads remain valid. A missing `apiUsage` field means unavailable, not
zero. Roll back the producer before rolling back the consumer. The preceding API
simply stops emitting the field; no database contraction or backfill is
required.

Provider results already known at transfer are included. Pre-provider transfer
is marked `no-inference`. A transfer made before a late provider result becomes
known has no snapshot and stays explicitly unavailable in this initial
handoff-only design. See [Sandbox run usage](api-run-usage.md).

## Current-run usage general availability

Current-run usage is generally available without a rollout switch. The normal
release promotes the API before the Runner. During that bounded interval, the
new API grants the prompt and `run-usage:read` capability, while an old Runner
that captured the switch as disabled returns `unavailable` with
`not_dispatched`. The CLI reports that as assignment-unavailable and directs the
caller to create a new Run after Runner promotion; a Runner predating the method
returns `unknown_method`, reported as unsupported Runner. Neither response uses
a fallback or automatic retry.

After Runner promotion, every newly created official Run receives the prompt,
capability and installed `run.usage` consumer. The reverse skew is also safe: a
new Runner with the previous API installs the assignment-bound consumer while
that API continues gating prompt and capability discovery. Already-created Runs
retain their minted capability, stable prompt snapshot and Runner ownership;
create a new Run after promotion to obtain the generally available command.
Stored overrides for the retired switch are ignored by the registered-key
filter and require no database migration. The source DTOs, guest RPC framing,
handoff metadata and observational accounting semantics are unchanged.

## DeepSeek V4.1 Flash Pi coverage

The [historical V4.1 Pi catalog](../turbo/packages/pi-agent-runtime/src/deepseek-v41-catalog.md)
records the former commit-addressed CLI and captured-context contract. Its
execution window is closed by the
[memory retirement gate](#deepseek-memory-execution-retirement-2026-10-08).
Historical accounting identities remain; Responses schemas and Runner claims
are unchanged.

## Durable Run stop intent (#34383)

The [Run cancellation reconciliation contract](run-cancellation-reconciliation.md)
adds nullable `agent_runs.runner_cancellation_mode` and an authenticated v1 read
endpoint. Apply migration 1143 before promoting API code. Its CHECK remains
`NOT VALID` because all existing rows receive NULL; new writes are constrained
without a historical scan. Old writers remain valid with NULL. Rollback retains
the additive column.
Deploy the API across the serving fleet before enabling the Runner consumer in
#34384. Unsupported endpoints and other inconclusive reads must not become
disappearance decisions. This API slice alone adds no new stop-delay bound.

## Email outbox provider replay and send-time expiry (#34645, #34695)

Migration 1148 adds nullable `email_outbox.provider_idempotency_key` and
`email_outbox.provider_request`, plus a unique index over the key. Apply it
before promoting API code; both columns stay NULL for producer-enqueued rows and
for every row written before the migration, so an older API keeps working and a
rollback retains the additive columns.

The first delivery attempt of a row renders its template, commits that provider
request together with a key derived from the row's own id, and only then calls
Resend. Later attempts replay the committed request byte-for-byte under the same
key, so a template change, a sender/`APP_URL` change, a restart, or a provider
acceptance whose completion write is lost resolves to the same email instead of a
second one. Attempts never derive a new key, and an idempotency conflict
(`invalid_idempotent_request`) fails the row visibly rather than re-keying it.

Recovery and bounds:

- A prepared row stays `sending` and owns a 60-second lease. After the lease, a
  drain re-selects it and replays the same request; the abandoned attempt's
  completion is fenced on `(status, attempts)` and cannot overwrite the newer
  one. `sending` is now a durable state, not only an in-transaction marker.
- A row's deadline is its persisted creation time plus the 15-minute TTL. No
  claim, retry or lease moves it. Preparation admits a row against that deadline
  rather than against the timestamp its batch started with, and the drain then
  rechecks the same deadline against a fresh clock after the claim commits and
  immediately before the provider call, because the suppression lookup, the claim
  update and that commit all take real time. A row that reaches its deadline
  inside that window makes no provider request: its owned attempt is failed with
  `Email outbox item expired before contacting the provider`, under the same
  `(id, status, attempts)` fence as any other completion, so it cannot overwrite a
  newer claim or recreate a row that was removed meanwhile. It keeps its committed
  request and key, because an earlier attempt may still be unresolved at the
  provider and that pair is the only record of it. Attempt-exhausted rows are
  failed the same way, and the existing cleanup removes both.
- Expiry decides admission, not retraction. Once `resend.emails.send` has been
  called the email belongs to the provider, so a request already in flight is
  delivered whether or not the deadline passes while it is outstanding.
- Three attempts within a 15-minute TTL stay well inside Resend's documented
  24-hour idempotency retention. Outside that window the provider no longer
  replays a key, so this is bounded retry safety, not unlimited exactly-once
  delivery, and sends made before this rollout carried no key and cannot be
  deduplicated retroactively.
- Delivery clears the committed request and keeps only the key and provider id.
  Undelivered rows are removed by the existing TTL cleanup, so the rendered
  message is retained no longer than the template and recipient already on the
  row, and no new retention or erasure obligation is created.

Mixed-version limitation: an old drain worker selects only `pending` rows and
sends without a key, so it can still duplicate a row that a new worker returned
to `pending`. A worker predating the send-time recheck also samples expiry only
while preparing, so it can still send a row that crossed its deadline during that
preparation. Both protections start once every drain worker runs the new path.
Row locking with `SKIP LOCKED` keeps the two versions from processing the same
row at the same time, and an old worker never claims a `sending` row.

Scale at the time of the change: a fully paginated masked read at 2026-09-16
09:56:29 UTC found 1,008 retained outbox rows, all `sent` and none past one
attempt. That is retained row inventory under the 15-minute TTL, not historical
volume, and it does not establish that an ambiguous send never happened.

## Morning Brief installed preference projection (#34693)

Migration 1149 adds the empty `morning_brief_installed_preferences` table, its
indexes, and its foreign keys to `org_members_cache(org_id, user_id)`,
`agents(id)` and `chat_threads(id)`. It is purely additive and needs no
backfill, `LOCK TABLE` or historical scan, so apply it before promoting API
code. An older API neither reads nor writes the table, and a rollback leaves it
in place holding only derived rows.

`FeatureSwitchKey.NativeMorningBrief` stays off by default. While it is off the
Settings read and write paths behave exactly as before; turning it on makes the
Settings writers copy the member's installed state into the projection and lets
the Settings GET answer from that copy. Turning it back off immediately restores
the legacy read and write path and discards nothing: every user choice still
lives in the legacy installation and its automation.

Both schema directions are therefore closed. Old code after migration never
names the new table. New code before migration cannot reach it either: every
statement against `morning_brief_installed_preferences` sits behind that
default-off switch, so the release's normal migration-before-promotion ordering
is not the only thing standing between a new API artifact and a `42P01`.

Mixed-version and old-writer behavior is the reason the reader validates instead
of trusting the row:

- An old API binary changes the legacy state without refreshing the projection.
  So does the automation poller advancing `next_run_at`, catalog reconciliation,
  and thread deletion. A new binary therefore accepts a row only when its
  `projection_version` matches and every copied field — selected installation,
  automation, Agent, bound thread, enabled, cron expression, timezone and next
  run — still equals the live canonical state. Any mismatch serves the legacy
  answer, so a stale row can never restore an old enabled, schedule, timezone or
  thread state.
- The projection's own `updated_at` is not freshness evidence and is never used
  as one.
- The legacy mutation and the copy are not atomic: the mutation runs on the
  outer `Db` and commits before the copy starts, even though both are inside the
  preference advisory lock. A failed copy is reported operationally and the real
  committed outcome is still returned; the next read falls back to legacy.

The row's lifetime is an evictable cache, not durable ownership. The composite
key to `org_members_cache` fences the current membership, user and organization
cleanup paths, and the refresh locks and rechecks that exact parent with
`FOR KEY SHARE` without ever recreating it. `org_members_cache` is a 60-second
read-through role cache that a concurrent membership read can refill, and the
Clerk erasure bridge is still unregistered, so this is a local fence rather than
global deletion finality. Before native state becomes execution authority, that
lifetime must be replaced with durable membership and erasure ownership.

This historical slice transferred no execution ownership: it consumed no
occurrence and added no Run, Chat event, email, provider request or credit
operation. Its full invariants remain in the
[archived migration contract](https://github.com/okou-ai/okou/blob/9da771dd0928a7a83f81a418ec3a93cc3da17f0d/docs/morning-brief-migration-state.md#the-installed-preference-projection).
See the [current Official Morning Brief contract](morning-brief.md) for the
retained functionality.

## Morning Brief bounded Slack collection (#34727)

Migration 1151 adds the empty `morning_brief_collection_occurrences` table, its
two indexes, its check constraints, and its foreign keys to
`org_members_metadata(org_id, user_id)` and `agents(id)`. It is purely additive
and needs no backfill, `LOCK TABLE` or historical scan, so apply it before
promoting API code. The production scale note below is automation inventory, not
a cutover census, and nothing existing is materialized by this slice.

Both schema directions are closed, but for different reasons, and the default-off
switch is only half the story:

- **Old code after migration** never names the new table. Its only readers and
  writers ship with this change.
- **New code before migration** reaches the table from two places. The collector
  itself is registered in the deployed route table but is gated by the
  development / protected-preview environment check and by the default-off
  `FeatureSwitchKey.NativeMorningBrief`, so it cannot run in production at all.
  The cleanup revocation added to membership, user and organization deletion is
  **unconditional** — it is a `DELETE` that runs whenever those webhooks fire,
  with no feature check in front of it. A default-off switch does not protect
  it. The repository's migration-before-promotion ordering is therefore the
  actual requirement here, not a convenience: promoting the API artifact before
  migration 1151 has shipped would make Clerk membership, user and organization
  cleanup fail with `42P01`.
- A rollback leaves the table in place holding only operational metadata. An
  older API neither reads nor deletes it; its rows stay fenced by the two
  foreign keys until a newer artifact returns.

The row's lifetime is durable member ownership rather than an evictable cache.
`org_members_metadata` is the source of truth for the member's own preferences,
including the timezone an enabled brief requires; it is deleted by membership,
user and organization cleanup and is not refilled by a background reader. This
is deliberately stronger than the `org_members_cache` parent the installed
preference projection uses, which a concurrent membership read can refill.
Claiming and finalizing take erasure admission first and then lock and recheck
that member row with `FOR KEY SHARE`, so a cleanup either waits for the writer
and cascades its row away or has already committed and leaves nothing to write.

This slice transfers no execution ownership. It starts no Run, makes no LLM,
credit or usage operation, writes no Chat event, email or outbox row, and leaves
`next_run_at` and `last_run_at` untouched. The existing Settings, legacy
automation and native Slack read contracts are unchanged. Durable membership and
materialization ownership, global deletion readiness, scheduling and cutover
remain S7 gates; the Clerk erasure bridge is still unregistered, so this is a
local fence rather than global deletion finality.

Requests already in flight to Slack cannot be retracted. Revocation guarantees
only that no result of such a request is accepted, persisted or returned after
the revoking transaction commits. See
[the collection contract](morning-brief-collection.md) for the source contract,
lease semantics, finite budgets and declared coverage limits.

## Marketing browser funnel events

The App sends both onboarding entry and actual Stripe redirect actions to
`POST /api/events` on the environment-matched Marketing origin
(`https://www.okou.ai` in production). The owner explicitly requested removing
the previous onboarding-start and checkout-start receivers without aliases.
Both repositories must ship the matching event contract as a coordinated
cutover; a new App against an old Marketing deployment receives a failed event
request, and an old App against the new receiver uses a retired route. Neither
combination is supported by this prelaunch change. Event failures never block
the onboarding or checkout flow and are not retried by the App.

Verify the production App version and commit contain the new caller, then raise
`minimumSupportedVersion` in
`turbo/apps/api/src/lib/web-client-compatibility.json` to that verified version
in a separate release. Do not guess a version from this PR or raise the floor
with the first replacement App deployment: production promotes the API first,
so a refresh could still load an unsupported build. This PR does not change the
floor or authorize a production rollout.

The existing App API check prompts old clients to refresh on their next handled
API request. Direct Marketing requests do not pass through that middleware;
cached old callers before the floor takes effect are outside this prelaunch
support boundary. Do not roll the App back below the floor or Marketing back
behind the unified receiver while those App builds are supported.

`sendEvent$(tag)` sends only `tag` (`onboarding-start` or `checkout-start`) and a
fresh UUID `eventId`. Marketing derives identity from the bearer token, supplies
the event timestamp, preserves existing first-touch attribution, and records
events even without attribution cookies. A recorded event returns 200 with
`{code: "EVENT_RECORDED"}` when usable attribution is available, otherwise an
empty 204. Errors return their HTTP status with `{code, error}`. The App does
not consume the response body or add outcome telemetry.

Requests include credentials and keepalive and belong to the App root, so
navigation never waits for them and a session change cancels pending work.
There is no ten-second deadline, local attempt marker, deferred onboarding
handoff, retry, or fallback. Each actual POST is preceded by one Axiom
`marketing.event.send` record with tag, userId, and orgId; `outcome: started`
means a send attempt, not server acceptance. No browser request ID header is
introduced. PostHog product and funnel events remain in the App; advertising
account selection and delivery belong to Marketing.

Marketing deduplicates onboarding by user/org and checkout by user/org/event
UUID. These counts differ intentionally from the legacy gtag browser-session/
account deduplication: another checkout action produces another event. A
successful event response is not a provider delivery receipt. This change
retains existing provider sending gates, adds no provider activation or replay,
and leaves checkout coverage at the existing `RedirectToStripe` producers,
excluding previews and other payment paths without that producer.

## Morning Brief collection revocation stamp (#34860)

Migration 1154 adds the nullable `org_members_metadata.morning_brief_collection_revoked_at`
column. It is additive, has no default and needs no backfill, scan or
`LOCK TABLE`, so it applies as an ordinary short transaction.

`FOR KEY SHARE` on the member row only orders two transactions; it does not
outlive either of them. The revocation decision now persists in this column, so
a claim admitted against an external membership answer resolved before
revocation still loses after that cleanup commits — including when the cleanup
found no occurrence to delete, and long before the member row itself is removed.

- **Old code after migration** never reads or writes the column. It stays `NULL`
  for every member an old artifact touches, which is exactly the unrevoked
  state, and the older collector keeps its previous behavior.
- **New code before migration** must not be promoted. Membership, user and
  organization cleanup write this column **unconditionally**, in the same
  transaction that already revokes run authority, with no feature check in front
  of it; the default-off `FeatureSwitchKey.NativeMorningBrief` switch does not protect it.
  Promoting the API artifact before migration 1154 has shipped would make those
  Clerk cleanup webhooks fail with `42703`. Claiming and finalizing read the
  column in the same unconditional statement that locks the member row.
- **Rollback** leaves stamped rows behind. An older artifact ignores them, so a
  member whose cleanup was interrupted after revocation simply keeps their
  pre-existing behavior; the rows themselves are deleted with the member row at
  the end of each cleanup path. There is no dual-write window and nothing to
  contract later.

The companion parent-generation check needs no schema of its own: the admission
carries the member row's existing `created_at`, and the claim requires it to be
unchanged. Ordinary preference upserts preserve that value, so no deployed
writer has to change; only a deleted and recreated row reads differently, which
is exactly the case it refuses. An older artifact simply does not compare it.

This repair changes no route registration, environment gate, feature switch,
schedule, Run, credit, Chat or email behavior, and it does not activate the
still-unregistered Clerk erasure bridge. It is a local serialization boundary
for one owner's collection authority; durable membership and materialization
ownership and global deletion finality remain S7 gates.

## Morning Brief retained generation authority (#35054)

Migration 1165 generalizes collection occurrences from Slack-only to an exact
kind-specific binding and adds the all-source generation provenance:
instruction version/digest, reported language, retained source descriptors and
deadline, complete installation/automation/destination ids, and
`content_purged_at`. Its anchor-wide partial unique index prevents another kind
or contract version from invoking the same logical morning. The replacement
decision constraint lets an expired successful delivery retain a content-free
invocation fence. Binding columns stay nullable only for rows written by the
older Slack-only writer; every all-source reservation writes the complete
canonical binding. The migration has no backfill, but its index and replacement
constraints inspect the existing table under the migration wrapper's ordinary
bounded lock.

The API and migration therefore have these mixed-version rules:

- **Old code after migration** keeps writing null binding columns and a null
  purge stamp. Those rows still satisfy the expanded constraint and retain the
  existing Slack authority checks. Old code ignores binding proof written by a
  newer API.
- **New code before migration** must not be promoted. Reservation, stored-result
  revalidation, and expiry sanitation name the new columns directly; without
  migration 1165 they fail with `42703`. The default-off feature switch and
  protected preview route contain provider use, but they are not a substitute
  for the repository's migration-before-API ordering.
- **New readers of old rows** preserve only the Slack-only contract. A row whose
  `collection_kind` is `sources` must have retained source proof and complete
  installation/automation provenance or its content is withheld. A historical
  non-`sources` row may use its existing live Slack authority gate during the
  rollback overlap; this compatibility branch can be removed after the old API
  rollback window closes and the 24-hour result lifetime has elapsed. The
  generation-time null destination may become the exact thread recorded by its
  first S6 delivery receipt; only that receipt-first transition is accepted,
  and any later destination change is withheld.
- **Rollback after new writes** ignores the additive binding metadata. Content
  sanitation starts only at the row's existing `expires_at`, when the old
  generation contract already refuses the result. The row remains solely as a
  cross-kind/version invocation fence through the seven-day anchor admission
  window, and the separate immutable email outbox retains any already committed
  email body.

Retained descriptors identify every source that supplied model input, including
uncited material, and survive only through the original result or email
obligation deadline. They contain no source body, prompt, instruction text, or
credential. Platform usage receipts remain anonymous and are neither purged nor
reattributed to a user or organization.

## Marketing attribution cutover (#33886)

The App no longer loads gtag, sends Google Ads conversions, looks up an Ads
account, or polls attribution milestones. Marketing owns the unified business
events and provider delivery. The API removes the old signup, account and
milestone attribution routes without aliases, as explicitly requested for this
prelaunch cutover. Existing pages may lose those retired telemetry calls during
the API-before-App promotion window; the replacement App removes their callers.

Billing remains operational across that window. Checkout request schemas use
Zod's default unknown-key stripping, so an older App's extra `adAttribution` is
ignored rather than rejecting a purchase. The removed `googleAdsConversion`
response property was optional in the preceding App contract. Both Apps still
use `completed` and the original purchase response statuses. The retained
`completePaidCheckout$` polls actual payment reconciliation before continuing
onboarding or showing billing success. No payment endpoint or fulfillment is
removed.

The API stops writing Clerk signup attribution and org acquisition columns and
stops attaching acquisition snapshots to new Stripe billing objects. New
customers keep `orgId`; sessions and subscriptions retain financial identity,
tier, price, purchase timestamps and preview routing. Existing metadata copied
through plan or schedule changes is filtered to avoid reintroducing marketing
fields, including old privacy receipts; Marketing retains authoritative
withdrawal state. Historical rows and external objects are not erased in this
change.

The final App cleanup removes its remaining click/UTM parser, attribution
session-storage reader/writer, auth redirect propagation, and explicit PostHog
attribution properties. Existing product
analytics, PostHog user/organization identity, and `/api/events` business facts
remain. Marketing is the single URL boundary: it omits acquisition parameters
from App links while preserving product deep links. App does not add a second
sanitizer for arbitrary incoming query strings or a migration that cleans
historical browser state.

Coordinate the Marketing single-sender cutover with this App/API deployment.
Verify the replacement App is live before setting a later client floor; an
already-open old bundle can otherwise continue collecting browser attribution.
This PR does not select a floor or change production provider settings.

## X resource protocol cleanup

The X producer always emits `x-resource-v1` observations for post and user reads.
The claim and proxy registry no longer carry `xResourceBilling` or its fixed
`startDate`; date-based and absent-capability count producers are retired.
The API retains its existing generic count-event and resource-event contracts.
X writes, other connector counts, model and image events keep their shapes.
Resource events always use N+R billing. This does not change the producer
protocol or the two-UTC-date retention window.

New Runners work with the preceding gated API: they ignore the old claim
capability and that API accepts resource uploads. During normal API-before-Runner
promotion, old Runners receiving the new claim select count-only reads. The
unchanged generic ingestion path accepts those events and bills their full
quantity, so this overlap does not discard usage. Runs that already captured the
preceding capability continue reporting resources.

Count events carry no resource identities: reads from an old Runner in this
overlap cannot populate the daily resource table or receive deduplication. Full
producer coverage requires old Runner processes, Runs, streams and retained
uploads to finish draining. If uninterrupted deduplication is required during
the cutover, predeploy the unconditional Runner against the preceding API and
verify that drain before promoting the API.
The preceding gated API remains a compatible rollback target, but it can restore
full-count billing for accounts without an enabled override. Rolling back the
Runner can reduce resource coverage again.

This is a requested protocol retirement, not a database migration. No stored
execution context contains the claim-only capability, and no historical usage
or resource row needs rewriting. A code merge and local tests do not prove the
production drain or full resource coverage. Record that evidence under #34615 as described in the
[X rollout guide](x-resource-rollout.md).

## Saved Social data jobs

The new `social_data_jobs` table and nullable `usage_event` pricing snapshot
columns must exist before a saved-job API starts. Reconciliation and
scoped usage cleanup also reference the table. Old APIs ignore the additive
schema; old usage events keep null snapshots and continue using the existing
tariff lookup.

Saved jobs are globally available and their rollout switch is removed. All
serving API instances and account cleanup workers must support saved jobs;
older instances reject the job endpoints and older account cleanup does not
remove saved jobs. Credential provisioning and operational pricing
configuration remain separate operational steps. New job settlement commits the priced usage event and durable job
receipt together, so legacy settlement workers cannot observe its pending
event between those writes.

The new CLI uses the saved-job protocol only when job controls are provided.
An old API rejects those endpoints instead of silently running a different
collection. Existing commands without job controls keep their current routes.
List/get/cancel and reconciliation remain available for admitted work to drain.
This cleanup does not add an admission-pause control. The Usage presentation change reads the existing
breakdown contract; stored provider IDs remain unchanged.

After activation, do not roll the API or workers below this implementation
while jobs or usage receipts remain outstanding. A rollback below the saved-job
implementation requires separately stopping new admissions, finishing or
cancelling admitted jobs, and verifying durable settlement receipts; the
removed rollout switch is no longer an admission control. Database expansion is retained. A merged PR does not prove
fleet parity, the drain, or paid-provider readiness.

## Browser native input foundation (#35821)

The `browser_user_action_requests` table must exist before an API instance that
serves `browserNativeInput` starts. The schema is additive: older APIs ignore
the table, and rollback leaves it in place. There is no backfill or production
data operation.

The row is deliberately not an audit record. Its token hash is the primary
key; searchable ownership, agent/thread authorization, provider-session
identity, state, the strict versioned payload, and the two operational
transition timestamps are the only persisted fields. Input callback identities
and exact-target data live only in that payload. Do not add a copied Browser
expiry, originating run, diagnostic reason, or created/updated timestamps.

Keep `browserNativeInput` globally disabled during mixed-version deployment.
Its initial registry policy is staff-only, but an explicit override must not be
enabled until every serving API instance and Clerk account-cleanup worker has
this implementation. Older API instances reject the new routes and older
cleanup workers do not explicitly remove outstanding requests.

The API rejects unknown persisted payload versions instead of guessing. A
nonterminal request is usable only while its exact `browser_session_instances`
row is active and both `timeout_at` and the renewable `idle_expires_at` are in
the future. Guarded lease updates must not revive an already expired Browser.
Terminal requests remain readable after their Browser lease expires so the
Platform can retry notification only; values are never stored and Browser
mutation is never retried. Rolling back the API requires disabling the switch
first. The retained expansion table needs no contraction until all requests
created by the newer API are outside their product retention window.

Browser access is request-scoped and bounded. The CLI resolves each input to a
`backendNodeId` in one exact `pageTargetId` and then stops operating the Browser.
Input creation uses at most one provider lookup and one short-lived, read-only
CDP connection to validate those identifiers and derive the document and
control fingerprints. Application uses one provider lookup and one short-lived
CDP connection to revalidate, mutate, and verify all fields. The API does not
query selectors or rediscover controls.

Direct-interaction creation, read, cancel, and complete are database-only. They
capture no page or DOM metadata and have no open endpoint. The existing
thread-scoped Browser card opens the current Browser and its normal viewer
heartbeat owns Browser access and lease renewal.

The native input preflight endpoint uses the same team-only switch. It performs
one bounded provider lookup and read-only CDP connection per explicit form
entry, returning the verified control subtype and current applicable site
constraints. The editable form first uses the persisted request fields while
preflight runs in the background, then adopts the observed controls without
discarding the draft. A completed failed check blocks submission and offers
retry. Preflight does not hold the thread write lock during provider or CDP
I/O, so submission can proceed while the check is pending. A confirmed target
mismatch marks a pending request stale; transient provider failures leave it
pending for retry. Apply rechecks the exact target and site constraints before
any mutation, even when preflight has not completed.
Per `docs/fallback.md`, this pre-GA feature does not require compatibility with
earlier Platform, API, or persisted-action shapes.
The general number field kind expands the strict shared request and preflight
response contract while `BrowserNativeInput` remains team-only. The API derives
number `min`, `max`, and `step` from the live control, transports submitted
values as strings, and accepts an explicit empty value only for an optional
number field. Existing persisted version-1 actions remain readable; no schema
migration or old-client compatibility branch is required for this pre-GA change.

The Browser action GET response can also report `callbackDelivered` for a
terminal success or cancellation. It derives this fact from the matching
canonical Chat input event ID in the owning thread, not from Browser completion
or a page-local send flag. The lookup uses the Chat event primary key and runs
only for retryable terminal outcomes. An older API omits the optional field;
the newer Platform treats absence as unproven delivery and keeps Continue
available. A mounted card refreshes that fact when its page regains focus or
visibility, so a callback sent from a separate action page converges without a
reload. An older Platform ignores the new field and retains its existing
local behavior until updated. No callback receipt or submitted Browser value is
written to the action row. Thread erasure removes the action and its Chat events
together; ordinary action retention remains seven days for callback recovery.

### Native file input (#36935)

The new file kind uses the existing staff-only `browserNativeInput` switch.
Per `docs/fallback.md`, this pre-GA feature does not need a separate file
switch or old-Platform compatibility branch; staff using an older page during
the cutover can refresh. File controls are never converted to text, and Browser
takeover does not transfer a user's local file. Directory-selection
(`webkitdirectory`) controls are unsupported and rejected, not flattened into
an ordinary file selection.

The file bytes exist only in the user's explicit, bounded apply request and the
managed Browser's selected `FileList`; there is no intermediate storage or
provider-host filesystem path. A website can react to `input`/`change` and
read/upload the selected bytes itself even though Okou does not submit its form.

## OOM containment proof chain removal (#36027)

`OomEvidence.runtime_progress_at` is removed, together with the containment
proof chain that consumed it. No deployment boundary observes the removal.

Guest Control Server produces the evidence inside the guest image and Guest
Control Client consumes it on the Runner host, but those are not independently
deployed surfaces. Runner and Guest binaries ship together, and a draining
Runner keeps executing its already-claimed runs on its own sandboxes rather
than handing them to the new artifact, as described under
[Runner process drain](#runner-process-drain) and in
[guest memory policy](runner-memory-policy.md). Sandbox reuse is decided inside
a single Runner process. The producer and the consumer are therefore always the
same artifact, so no mixed-version pair exists for this field.

The persisted copies are write-only in production. Runner writes
`oom_evidence_log` and Guest Agent writes `<metrics_log>.oom-evidence.json`;
neither is read back by production code, so no reader can encounter a payload
written by an older artifact.

`evidence_written_by_an_older_guest_image_still_decodes` is retained as
`a_retired_runtime_progress_field_decodes_as_an_unknown_key`, reading
`crates/guest-contracts/tests/fixtures/oom-evidence-v1-legacy-runtime-progress.json`
— a byte copy of the pre-removal `contained-tool-oom.json`. It pins the
decoder's treatment of the retired key, not a rollout window: `OomEvidence` and
every nested type (`MemorySnapshot`, `MemoryEvents`, `KernelOomEvent`,
`OomIncident`) carry no `deny_unknown_fields`, so the key is ignored. It carries
no removal gate and is not a bounded rollout fallback.

The v1 telemetry payload is unchanged. `telemetry_evidence()` existed only to
force the field to `None` before upload, and `skip_serializing_if` then omitted
the key, so `runtime_progress_at` never appeared in a v1 payload and still does
not. `oom_evidence_upload_payload_is_unchanged_by_the_removed_progress_field`
uploads the legacy fixture through `JobTelemetry::upload_oom_evidence` and
asserts the serialized `oomEvidence` bytes.

The Guest Agent to Guest Control Server evidence request bytes `3` and `4` are
removed outright. That socket is intra-guest: `guest-control-server` is linked
into `guest-init`, and `guest-agent` and `guest-init` are pinned together by
`guestSha256` in one runner image manifest, so both ends always ship in the same
rootfs. An unrecognized request byte ends the exchange rather than reading a
payload the peer never promised.

`oom_classification` changes meaning at the same time. It previously reported
whether the containment proof succeeded; it now reports which cgroup the kernel
killed. The token `contained_tool_oom` therefore means something different
before and after this change, and a record with no proven OOM evidence now
carries an empty classification instead of `unproven_containment`. The
`oom_unproven_reason` field is gone. Dashboards or saved queries that compare
`oom_classification` across this boundary will be wrong.

## Discord native file delivery (#36646)

Discord file commands use additive upload-init, materialize, complete, and
identity-based download endpoints behind the default-off `discordIntegration`
switch. Uploads retain one canonical asset and operation ID across provider
retries. Native member uploads have no Run; Run-scoped uploads retain their actual
Run source. The API validates the stored bytes before publication, then records
Discord delivery independently from the canonical file URL.

Migration `1232_discord_canonical_delivery_state` adds nullable `provider_state`
to `canonical_asset_deliveries`. Existing Slack destinations keep their original
JSON shape and have no Discord state. Outgoing API statements remain valid after
the additive migration. The new API requires the migration before promotion;
normal migration-before-promotion ordering provides this boundary. Discord
reader/writer changes are non-GA and have no old-client compatibility branch.

Deploy the capable API before using its matching CLI in an enabled test
organization. Older CLIs lack these commands; a new CLI against an older API
receives an unavailable endpoint. No Runner protocol or production activation is
introduced. A revoked or rebound Discord connection cannot reuse the stored
delivery destination. If a send might have succeeded but its receipt is missing,
a prompt retry replays the persisted nonce with `enforce_nonce`, so Discord
returns the original message instead of creating another. After the one-minute
replay window the delivery stays uncertain and is never sent again. Explicit
Discord rate-limit delays are persisted with the delivery attempt; subsequent
completion requests return the remaining delay without sending early.

## Browser advisory retirement (2026-09-29)

The Browser thread key is retired after the preparation in #37097
(`405c21452010c37e4ce2facd51c3f1b231646e7d`). Fresh creation and resume use the
existing owned-thread partial unique index and exact state predicates. Instance
publication inserts the provider instance and screen, then conditionally changes
the observed logical Browser in the same command-local transaction. A lost
logical claim rolls those inserts back. Stop, retention and profile retirement
keep their existing exact resource identities and conditional writes.

All eight Browser transaction scopes now belong to local commands. They execute
SQL directly; neither a transaction parameter nor a transaction-capturing helper
callback leaves the scope. Provider HTTP, CDP, encryption, object storage and
realtime stay outside those transactions. Post-commit provider cleanup finishes
its ownership handoff before the caller observes cancellation. No persisted
field, public API shape, App floor or Runner contract changes.

At the 2026-09-29 inspection, both public API build-info endpoints returned
`020a4d8c4b1d8392a8cdda39b8206d9f643ca555` (API 1.695.0). Vercel's four production
aliases (`api.okou.ai`, `api.vm0.ai`, `vm0-api.vm6.ai`, `vm0-api-prod.vm6.ai`) all
resolved to READY deployment `dpl_Bhc1WpzjbKXqkDEUvDbtH2GZvinQ`, promoted at
01:12:01 UTC. That commit descends from #37097, and more than one hour had elapsed
since promotion when checked; the API's configured invocation bound is 300
seconds. The normal rollback resolver also requires
`45b537a596a153a91b76c3bc7223187840f52775`, a descendant of #37097, so supported
rollback targets contain the Browser preparation. This is read-only rollout
verification, not a new production deployment.

Recheck serving and supported rollback versions before deployment if either
changes. Do not restore a pre-#37097 Browser writer alongside the keyless API.
The preceding prepared API and this version use the same existing constraints,
state comparisons and statement order during rolling overlap.

## Custom account advisory retirement (2026-09-29)

The custom account target acquisition is removed after the preparation from
#37097 (`405c21452010c37e4ce2facd51c3f1b231646e7d`). Exact custom-account deletion
no longer calls the advisory interface; shared account selection and lifecycle
paths now take it only for builtin targets. Existing definition protection,
ordered account row writes, account uniqueness, selection foreign keys and
whole-transaction rollback recovery continue to arbitrate custom writes.

Read-only deployment checks on 2026-09-29 found all production API aliases
(`api.okou.ai`, `api.vm0.ai`, `vm0-api.vm6.ai`, `vm0-api-prod.vm6.ai`) at READY
Vercel deployment `dpl_Bhc1WpzjbKXqkDEUvDbtH2GZvinQ`, commit
`020a4d8c4b1d8392a8cdda39b8206d9f643ca555`. Both public build-info endpoints
returned that commit and version 1.695.0. This version contains #37097; the
01:12:01 UTC promotion preceded inspection by more than the configured
300-second API invocation bound. The existing mandatory rollback floor
`45b537a596a153a91b76c3bc7223187840f52775` also contains #37097.

Recheck supported serving and rollback writers before deployment if that state
changes. A pre-#37097 custom-account writer cannot coexist with this retirement.
No App/Runner contract, persisted field or additional deployment floor changes.
The remaining builtin target lock and transaction-passing account helpers are
separate Release 1 work, not exceptions to the confirmed final architecture.

## Canonical Chat application sessions

Migration `1295_chat_thread_canonical_session` adds a unique index on
`chat_threads.agent_session_id`. A thread may have no session before its first
admitted run, and PostgreSQL continues to allow multiple null bindings. An
application session may be the current binding of at most one thread. Historical
sessions no longer referenced by a thread and threadless sessions remain intact;
no historical run, conversation, checkpoint, or session ID is rewritten.

Before production migration, audit duplicate non-null bindings with:

```sql
SELECT agent_session_id, count(*)
FROM chat_threads
WHERE agent_session_id IS NOT NULL
GROUP BY agent_session_id
HAVING count(*) > 1;
```

The migration rejects duplicates instead of assigning a different owner or
silently detaching history. Any existing duplicates require an explicit repair
based on their ownership and run provenance before rollout. The migration is
non-transactional and builds the index with `CREATE UNIQUE INDEX CONCURRENTLY`,
so chat thread writes are not blocked while it waits for older transactions.
A duplicate fails the build and leaves an INVALID index, which the migration
drops (`DROP INDEX CONCURRENTLY IF EXISTS`) before its next attempt; a failed
build does not authorize production data changes.

New admission preserves the thread's valid application session ID when its
agent, runtime, or model family changes. It resets the native conversation
checkpoint within that same session and replays visible prior turns when native
history cannot be resumed. The same pending transaction updates session identity
and storage, binds the run and consumed input, and creates the runner job; its
last statement claims the unique active-run slot. A stale session snapshot or
active-run uniqueness conflict rolls back the launch and fails the background
pick without automatic preparation retries.

Stable identity applies to an existing session owned by the thread's user and
organization. The existing recovery behavior for a missing, deleted, or
foreign-owned session binding is retained: admission refuses to resume that
session, creates a new authorized application session, and repairs the thread's
current binding in the pending transaction. It does not reuse the foreign ID or
delete either session's history. The one-to-one guarantee covers valid current
bindings; it does not claim that an invalid historical binding preserves its ID
or that a thread has never referenced another detached session.

An outgoing API remains compatible with the added unique index, but it can
still replace a thread's application session during native-history rotation.
Stable application identity therefore requires all admission writers to run the
new implementation. Rolling back the API can restore rotation without corrupting
retained history or invalidating the index. Native Runner checkpoint and claim
protocols keep their existing shapes, so a running older Runner can finish the
run it already owns. This change does not restore the removed thread/session
foreign keys.

## New-workspace onboarding credits become personal usage packs (2026-10-08)

Limited-free workspace bootstrap gives its creator 1,000 member-owned usage-pack
`bonus` credits with the unchanged 30-day expiry, instead of increasing the shared
organization balance. Eligibility and paid-tier race handling are unchanged. No
subscription or allocation is created, and existing shared onboarding grants are
not migrated, refilled, or extended.

Issuance keeps the existing `(org_id, limited-free-onboarding)` expiry-record
receipt as a zero-amount, zero-remaining reservation. That receipt and the personal
grant commit in the bootstrap transaction. Legacy receipts, including spent or
expired ones, still prevent another award; new reservations cannot be displayed
or spent as shared credits. The receipt also prevents an old API or rollback
writer from awarding shared onboarding credits after a new personal grant.

Old and new APIs already read personal usage-pack balances for billing and credit
admission. During a rolling deployment, whichever bootstrap writer wins the common
receipt determines whether a newly initialized workspace receives the old shared
grant or the new personal grant; the other writer cannot award both. Existing
clients use their unchanged billing endpoints. No database migration, client
version floor, or Runner protocol change is required. This change does not deploy
or activate production changes.

## Agent mail notifications stage one

`okou notify mail` adds `POST /api/notifications/mail`, a workspace/user-scoped
receipt read, the `notify:write` capability gated by `notifyMail`, and the
`agent-notification` email-outbox template. The additive `mail_notifications`
migration must precede the API deployment. Old APIs ignore this table and
continue processing the existing email templates.

| Combination                         | Behavior / requirement                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Old CLI / new API                   | Existing commands and Official result-email callbacks retain their behavior.                                                                          |
| New CLI / old API                   | New notification calls fail with an HTTP error; the CLI must not report a send or try a second transport.                                             |
| Old token / new API                 | Tokens without `notify:write` cannot send; start a new run after enabling the switch.                                                                 |
| New API / old Runner                | The additive capability is carried in the trusted `OKOU_TOKEN` overlay; no Runner protocol change is needed. The installed CLI must include `notify`. |
| New producer / old outbox drainer   | Unsupported. Keep `notifyMail` disabled until every drain instance recognizes `agent-notification`, including old deployments reached by cron.        |
| Receipt / expired or deleted outbox | A receipt keeps its ID, content hash, and final status; replay never inserts another email.                                                           |

Deploy migration and all template readers before enabling notification
producers. A rollback after enabling must first stop new production and drain
pending/sending notification rows with the compatible worker; do not route an
existing new template to an old reader. Feature switches are user-overridable
rollout controls, so operational readiness must precede any enablement.
Membership/user/organization cleanup removes these receipts and their outbox
content. In-flight provider calls cannot be recalled.

### Explicit Morning Brief notification purpose

`kind` is an optional mail request field with a permanent `notification` default.
`morning-brief` requires a server-owned official source automation and accepted
run provenance; it writes the new `agent-morning-brief` outbox template with a
server-derived Manage URL. It reuses the original Official result-email
renderer. Existing `agent-notification` and `official-automation-result` payloads
and receipt responses are unchanged; no database migration is needed.

- **Old CLI / new API:** omitted kind remains an ordinary notification with
  identical default idempotency encoding and presentation.
- **New CLI / old API:** old strict request readers reject the new kind field.
  Report the error; never retry without the purpose or through another transport.
- **New producer / old drainer:** unsupported for `agent-morning-brief`. Deploy
  every drainer reader before releasing the CLI or enabling new production.
  The feature remains behind default-off `notifyMail`; no dual reader or
  staff-shape migration is added.
- **Pending intent / retry:** the outbox captures its resolved template and
  management URL. The existing committed provider request/key is replayed
  unchanged, even after the source changes or disappears.
- **Rollback:** stop new production and drain the new template with compatible
  workers before restoring an API/drainer that cannot read it.

Morning Brief retains `resultEmail: true` and its existing accepted callback
snapshots throughout stage one. The later Official revision must change the
instructions and `resultEmail` together, update Morning Brief readiness checks,
and let old runs complete their accepted delivery contract. See
[agent mail notifications](agent-mail-notifications.md) for acceptance gates.
