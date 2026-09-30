# Deployment Compatibility

## Global model catalog foundation (PR-A, 2026-09-30)

Migration `1295_global_model_catalog` extends `run_model_catalog` with
`display_name`, `sort_order`, `is_system_default`, `replaced_by` and two stored
generated columns, and adds `model_routes`. It seeds every code-active model
(labels and `SUPPORTED_RUN_MODELS` order), marks `okou-1.0` as the system
default and seeds `claude-fable-5` with `replaced_by = claude-fable-5-1`. Routes
are seeded from the Built-in candidates, model-first BYOK compatibility and a
copy of `subscription_model_catalog`. The migration fails, rather than dropping
rows, if that catalog lists a model outside the active catalog. See
[the design note](model-catalog.md).

- The change is additive. The only existing reader of `run_model_catalog`
  selects `allow_new_org_policy` for `ACTIVE_RUN_MODELS`; existing values are
  preserved and rows the migration inserts for missing active models default to
  `false`, which matches today's fail-closed treatment of a missing row.
- Rows outside the catalog are deleted: code-retired models without a confirmed
  replacement (`claude-opus-4-8`, `claude-sonnet-4-6`, `deepseek-v4-pro`) and
  IDs the code does not know (for example `gpt-5.6-terra`, `okou-1.0-pro`,
  `okou-1.0-max`). The reader filters them out, so neither the old nor the new
  API observes the deletion.
- `GET /api/model-catalog` is new and read-only; no client calls it yet.
- `display_name` and `sort_order` are `NOT NULL` without defaults. No API writes
  the catalog; manual operator inserts must now supply them.
- Rollback: the previous API ignores the new columns and table. Rolling back
  needs no schema change.
- Transitional duplication: the catalog duplicates code lists and
  `subscription_model_catalog` until PR-E. A migration-suite validator fails on
  any divergence. `allow_new_org_policy` keeps gating new organization policies
  until readers switch to `replaced_by` in PR-B.

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
  Without `OKOU_DEFAULT_IMAGE_MODEL` their size default falls back to their
  built-in model (`1024x1024`, or `auto` with `--image-url`) instead of `auto`
  for Seedream 5 Lite. For a member whose setting is Seedream 5 Lite, an image
  text-to-image command with neither `--size` nor an explicit Seedream Lite
  `--model` fails size validation with `400`. Editing with
  `--image-url` still defaults to `auto`; the agent can retry text-to-image with
  `--size auto` or an explicit supported size. Other
  models are unaffected. Their snapshot and event schemas treat
  `selectedImageModel` as optional, so chat thread reads are unaffected.

Release prerequisite: release #37268 published CLI 9.373.0 but skipped
[production Runner rebuild](https://github.com/okou-ai/okou/actions/runs/36498080195/job/109188223120)
and
[promotion](https://github.com/okou-ai/okou/actions/runs/36498080195/job/109188968213).
The preceding verified production rootfs
[installed CLI 9.371.0](https://github.com/okou-ai/okou/actions/runs/36426838612/job/108946499812).
A rootfs-installed CLI does not expire with an individual run, so a two-hour
drain does not establish its retirement. Before production release, verify that
serving rootfs images use CLI 9.373.0 or later, or obtain explicit owner
acceptance of continued Seedream 5 Lite default-size failures on older installed
CLIs. This cleanup does not change CLI launch paths or the installed-CLI floor.

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
effort chip, and both list only chat models. The undocumented `birefnet` and
`clarity-upscaler` transform models are removed.

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
error until the API is promoted.

## SSH/VNC Agent-grant interface contraction (#36360)

The live Run and Runner authority uses exact chat host defaults/overrides (cutover
#36440, switch graduation #37235). This step retires the old owner Agent-grant
GET/PUT routes, public contracts and first-host auto-grant inserts. An older
client calling those routes cannot gain new broad host authority; the new API
has no handler for them. Current SSH/VNC host inventory and private Runner
checks continue to require the Run's chat permission.

The physical `agent_ssh_access` and `agent_vnc_access` tables remain in the
#36360 release. Production migrations precede API promotion, so a still-serving
older API could have read or written those rows during the overlap. Existing
rows never authorize access on the new API. The owner does not require
preserving rollback to a pre-cutover API for this cleanup.

### Remaining Agent-grant reader retirement (PR #37305)

#36360 intentionally retained VNC owner-cleanup reads, locks and deletes on
`agent_vnc_access` for serving older APIs. Production API versions containing
#37274, including the `8531a2b` build observed on 2026-09-29, **still access
this table** during user, organization and membership cleanup. The earlier
production drain proved only that pre-#37274 binaries had stopped serving; it
did not make a same-release VNC grant table drop safe.

PR #37305 removed this last production VNC grant dependency and the test-only
SSH grant writer, while **retaining both physical grant tables and their schema
declarations**. It merged as `712de8a72b7e4613311ea1b29812074dba43e0ce`.
The production API containing it (`4608b8d21cd67cccf9ca1a50aa654e94130085ea`)
completed [promotion](https://github.com/okou-ai/okou/actions/runs/36524823248/job/109268010829)
at 2026-09-29 05:22:31 UTC. At 05:52:55 UTC, the READY Vercel deployment
`dpl_3Wn7roDDKTdDvuSA2JkUzkPQpQca` owned all four production API aliases,
and cache-bypassed `/api/build-info` on each reported that SHA. The elapsed
window exceeded Vercel's 30-minute maximum extended function invocation bound.
Current chat-scoped SSH/VNC host authority, VNC configuration cleanup and
historical migration replay remain unchanged.

**Separate physical contraction (#37272, not yet deployed):** Generated migration
`1288_drop_retired_agent_grant_tables` drops `agent_ssh_access` and
`agent_vnc_access` without cascading into other objects. The user excludes
rollback compatibility with pre-#37305 APIs after this migration, but not safety
for any earlier API still serving. Immediately before any **authorized**
production table-drop deployment, recheck all aliases and serving builds plus
the full old-invocation execution bound; a merged PR, prior check or one sampled
response is insufficient. Since migrations run before API promotion, combining
the final-reader removal and table drop in one release was unsafe. The above is
pre-drop gate evidence, **not** a production migration receipt.

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
removes compatibility that no longer has a reader. It also deletes the
one-time `019-pi-api-first-turn-cleanup` script, which was run in production on
2026-09-28 (17 objects deleted, `pi-api-first-turn/` verified empty).

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
- Official Workflow queue marker decoding (#29908): its writers still write the
  markers.

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
  pre-retirement API. The BytePlus, MiniMax, and JoggAI webhook routes are
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

## Unified chat queue (release 7): legacy steer and Pi API-first removal

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
- The four API-first steps listed under release 6: the Sandbox CLI no longer
  writes the `vm0_pi_api_first_turn_boundary` startup record; the API no longer
  writes `piLaunchConfig.apiFirstTurn` (removed from the strict contract),
  `pi-sandbox-handoff.service.ts`, the completion-time handoff object deletion
  and the `pi-api-first-turn/` sweep in the sandbox cleanup cron; the Guest
  reads the installed-CLI requirement only from `piInstalledCliRequirement` and
  no longer parses the startup record or launch config. The Runner's generated
  `PiLaunchConfig` has no `deny_unknown_fields`, so it tolerates the removed
  slot; only the installed release 7 CLI's strict launch schema rejects it.
  `okou run usage` accepts only the `sandboxProxy` source.
- `PI_SANDBOX_INSTALLED_CLI_MIN_VERSION` rises to the first CLI release without
  the slot, because release 6 installed CLIs parse the launch config strictly
  and require `apiFirstTurn`. The value is the last released CLI version plus
  one patch; if another release ships before this change merges, raise it
  again so it stays above every release 6 CLI.

**Merge gate:** every release 6 Runner is live and earlier Runners have drained
(no reserve or receipt calls in production since 2026-09-28 05:30 UTC).

Mixed versions during rollout (API first, then Runner with its Guest; old
Runners drain for up to about two hours; the Sandbox CLI is either the
commit-addressed `CLI_PKG_URL` of the API that created the run or the CLI
preinstalled in the Runner image):

- New API with a release 6 Runner and Guest: the API writes no slot and the new
  CLI floor, so the release 6 Guest rejects its installed release 6 CLI and
  launches the new commit-addressed CLI. That CLI accepts the slot-free launch
  config and writes no startup record, which release 6 Guests tolerate. The
  release 6 Runner validates the launch config without the slot, steers only
  through the remaining endpoints and reports no `apiFirstTurn` usage source.
- New Guest with an old CLI that still writes the startup record: reachable only
  when a new Guest launches a release 6 CLI, which needs a launch context
  written by a release 6 API. The Guest treats the record as an unknown JSON
  record: it is written to the local transcript only, takes no event sequence,
  and public events still start at 1.
- Old Guest with the new CLI: release 6 Guests start at sequence 1 without the
  startup record.
- Pi runs queued by a release 6 API and claimed after the new API is promoted:
  their stored `piLaunchConfig` still carries `apiFirstTurn`, which the strict
  claim reader rejects, so the claim fails the run. This affects only Pi runs
  created before promotion and not yet claimed; runs are normally claimed
  within seconds and the pending timeout bounds the window at five minutes.
  This is accepted; release at low traffic.
- No reader remains for handoff objects that earlier APIs wrote under
  `pi-api-first-turn/`. The one-time `019-pi-api-first-turn-cleanup` script
  was run in production on 2026-09-28, after release 7 promotion and the old
  API writer drain: it deleted 17 objects from that prefix in
  `vm0-s3-user-storages-prod` and verified the prefix is empty. Canonical
  session history outside the prefix is untouched. The script has since been
  removed.

**API rollback floor: this release**, pinned by the marker
`.github/rollback-floors/pi-api-first-turn-retired` in
`resolve-production-rollback-target.sh`. Earlier APIs write `apiFirstTurn` and
the old CLI floor on every Pi run: a release 7 Guest would launch its
preinstalled release 7 CLI, which rejects the slot, so every Pi run fails until
the Runners are rolled back as well. This rejection comes from the installed
CLI, not the Runner's generated type or the Guest. Earlier APIs also require
the slot when they decode contexts queued by this release. The release 6
Runner protocol is the minimum supported predecessor; the stricter release 7
API floor subsumes it.

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
  column on rollback; the existing Release 7 API floor remains unchanged.
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
  This field adds no rollback floor beyond the release 7 API floor above. Keep the
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

## Unified chat queue (release 6): Runner, Guest and Sandbox CLI

The Runner reads steerable input from
`GET /api/runners/runs/:runId/steerable-inputs/next` instead of reserve, and
the Guest declares each input the CLI backend accepted through
`POST /api/runners/runs/:runId/steerable-inputs/:eventId/steered` instead of
receipt. The process-control payload carries the source chat-event ID
(`eventId`); delivery IDs, the Guest receipt journal, Runner journal recovery
and `activeInputDeliveryIds` in completion requests are gone. A `409` from the
steered endpoint is final, and a failed declaration is not retried: the input
stays queued for the next pick.

The Sandbox Pi CLI no longer waits for the per-run handoff manifest. It opens
the session the Runner restored from `resumeSession` (inline `sessionHistory`
or blob `historyRef`) as `restored-<sessionId>.jsonl`, or the file a reused
sandbox's previous run appended to, and starts a fresh session on a first
turn. It still writes the private `vm0_pi_api_first_turn_boundary` startup
record (`sandboxEventSequenceStart: 1`, `sandbox-first`) because pre-release-6
Guests require it. The release 6 Guest accepts the record when present and
otherwise starts at sequence 1 on the first official RPC record; it rejects
the retired continuation modes. The Runner validates the launch config
without `apiFirstTurn` and `run.usage` no longer reports the always-unavailable
`apiFirstTurn` source.

The installed-CLI launch requirements (`requiredPiAgentRuntimeVersion`,
`minCliVersion`, `requiredPiSessionConstructionDigest`) move to the execution
context as `piInstalledCliRequirement`, forwarded by the Runner to the Guest in
the run payload. They are not added to `piLaunchConfig`, because the Pi CLI
parses the launch config strictly and an older installed CLI would reject an
unknown key. The API writes both the new field and the old `apiFirstTurn`
copy. The Guest reads the new field and falls back to `apiFirstTurn` only for
runs created before this API release. An older API that reads a queued context
strips the unknown top-level field, so rollback is unaffected.

Guest binaries ship inside the Runner binary, so Runner and Guest never skew.
Mixed versions during rollout:

- New Runner with an API below release 4: unsupported. **API rollback floor:
  release 4**, main commit `fd5104417a0cf41116ce9cb9c1aeb2fa3b5e14da`, pinned in
  `resolve-production-rollback-target.sh`, because a draining release 6 Runner
  only calls the steer endpoints.
- Old Runner with this API: unchanged; release 4 and later still serve reserve,
  receipt and `activeInputDeliveryIds`, and the old Guest keeps reading the
  requirement from `apiFirstTurn`.
- Old Sandbox CLI (commit-addressed `CLI_PKG_URL` of a run created before this
  release) with a new Guest: it still waits for the manifest the API keeps
  publishing and writes the startup record. Its `okou run usage` rejects the
  new result without `apiFirstTurn` as `invalid-response`.
- New Sandbox CLI with an old Guest (a run created after API promotion that an
  old Runner claims): the CLI writes the startup record the old Guest requires
  and reads the session the old Runner restored the same way. `okou run usage`
  accepts results with or without `apiFirstTurn`.

Accepted in this release:

- The old-CLI `okou run usage` break above is accepted rather than staged. It
  reaches only runs created before this release that the installed-CLI parity
  check sends to `npx`, and the removed source was always `unavailable` since
  release 4.
- The staff-only Pi Langfuse relay no longer parents Sandbox observations under
  the Run End-to-End span, and no longer emits Sandbox Wait. The parent and
  `sandboxWaitStartedAt` came from the handoff manifest, and the API-first
  phases they linked no longer exist. Sandbox traces become root traces.
- A steered declaration that fails without a `409` is not retried. That input
  stays the run's steer anchor, so later inputs wait for the next pick after
  the run ends, and the model sees that input again.

**Release 7 deletion order.** Release 7 only deletes. It may merge once every
release 6 Runner is live and every earlier Runner has drained:

1. The Sandbox CLI stops writing the startup record; release 6 Guests already
   start without it.
2. The API stops writing and the contract drops `piLaunchConfig.apiFirstTurn`,
   together with `pi-sandbox-handoff.service.ts`, the `pi-api-first-turn/`
   cleanup cron, the reserve and receipt endpoints, and the steer settlement of
   `activeInputDeliveryIds` in completion requests; Rust bindings follow.
3. The Guest drops the `apiFirstTurn` fallback for the installed-CLI
   requirement and the startup-record parser, and the Runner stops tolerating
   the slot. Runs queued before release 7 still carry
   `piInstalledCliRequirement`, so the fallback has no remaining reader.
4. The CLI drops its tolerance for `sources.apiFirstTurn` in `okou run usage`;
   no Runner reports it after the pre-release-6 Runners drain.

Release 6 installed CLIs parse `piLaunchConfig` strictly and require
`apiFirstTurn`. The release 7 API must therefore raise
`PI_SANDBOX_INSTALLED_CLI_MIN_VERSION` to the release 7 CLI in the same change
that stops writing the slot. Release 6 Guests then launch the commit-addressed
CLI instead of an installed release 6 CLI.

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

## Pi API-first retirement (release 4, API side)

The API no longer runs Pi first turns in-process. Every Pi run goes to the
Sandbox. Run creation publishes the no-inference `sandbox-first` handoff under
`pi-api-first-turn/<runId>/` (v3 manifest plus session object, or a v4 manifest
referencing blob-backed history) before the run and its runner job commit.
`piLaunchConfig.apiFirstTurn` stays populated because the Runner validator and
the CLI handoff resolver still require it; the contract, Runner, Guest and CLI
are unchanged and are cleaned up in a later release. The `pi_api_first_turn`
advisory lock is gone. No database migration.

Old and new instances during deploy:

- An old API instance still runs its in-flight API-first attempts in its own
  process and completes, fails or hands them off itself; new instances need no
  state from it. Cancellation handled by a new instance no longer takes the
  lock or aborts the old process's provider call; the status-guarded terminal
  transition still decides the winner, and a losing attempt stops at its own
  deadline.
- Completion deletes the handoff objects of every Pi run, and the sandbox
  cleanup cron still sweeps the unchanged `pi-api-first-turn/` prefix after the
  presigned URL TTL, so objects written by old instances are not orphaned.

**Rollback:** safe down to the release 3 floor; an earlier API resumes API-first
for new runs and reads nothing this release writes differently.

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
still skip KMS. At that release, the owner lifecycle locks and first-host
Agent grants remained; the later [grant contraction](#sshvnc-agent-grant-interface-contraction-36360)
retired first-host writes.

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

A queued Web input whose context ID is the VM0-era Web ID now decodes exactly
like the Okou Web ID. Writers still emit the Okou ID. Official Workflow queue
markers, their IDs and their claim rules are unchanged (#29908).

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
name in the current layout when a legacy site holds the requested name. Artifact preview images are new objects and use `current`; the video
poster transform still runs on the source artifact's CDN origin. The private
video poster request always uses the current `files.` host, which the Worker
accepts for both domains.

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
and Pi. PR #36402 deployed the additive ID field while the Runner stayed on
Codex 0.155.1. The Runner now upgrades to 0.156.1 after that API rollout and
old claimable contexts have drained. An older Runner ignores the additive field.
A newer Runner served by an older API, or claiming a context without the field,
still writes the original placeholder account ID; that combination is not
supported with Codex 0.156.1 and may fail workspace routing. An explicitly
empty field remains rejected. API rollback before #36402 therefore also
requires rolling back the Runner. Removing the missing-field compatibility
branch is tracked by #36420.

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

Morning Brief enrollment remains a separate durable obligation. The POST
attempts it after saving missing preferences, and the enrollment worker admits up to
20 timezone-bearing members without enrollment rows on each tick before
processing due work. Qualification checks the Clerk membership and rollout
boundary; existing `cancelled`, `ineligible`, and `completed` rows are not
recreated. No schema migration is needed.

## Pi 0.87.1 model admission (2026-09-23)

The API and commit-addressed CLI now pin Pi 0.87.1. Its native catalog contains
`claude-opus-5-5`, `gpt-6-sol`, and `gpt-6-luna`, so the Pi admission table can
route those models through Pi when their existing product policy allows it.
This change does not make a model newly addable to an
organization. GPT-6 Sol and Luna continue to use the global OpenRouter endpoint
because neither is in the US endpoint allowlist.

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

Every CLI artifact `manifest.json` records the release versions of what the
bundle contains: `versions.cli` (`@okouai/cli`), `versions.piAgentRuntime`
(`@okouai/pi-agent-runtime`), and `versions.piSdk` (the pinned upstream Pi SDK
plus a digest of the first-party patch set). A release additionally publishes
the release commit's artifact at `okou-cli/v<versions.cli>/`. That path is
immutable: the publish step fails the release when the version already exists
with different bytes, so one CLI version identifies exactly one bundle and the
semantic version can serve as a compatibility identity.

The runner build (`runner build --okou-cli-artifact DIR`) installs the versioned
bundle into the rootfs customize layer at `/usr/local/lib/okou-cli/<version>/`
with a `/usr/local/bin/okou` launcher and an installed manifest at
`/usr/local/lib/okou-cli/installed.json`; the bundle bytes and the manifest are
part of the rootfs hash, and `verify-rootfs.sh` asserts the install. Release
runner builds install the CLI version tagged in `.release-please-manifest.json`
at the same release commit; preview images install the commit artifact of their
own head commit. A build without the artifact carries no CLI and keeps only the
commit-addressed path below.

Compatibility is negotiated per run rather than by deployment order:

- `piLaunchConfig.apiFirstTurn` carries two optional fields:
  `requiredPiAgentRuntimeVersion` (the runtime the backend prepared the
  API-first turn with) and `minCliVersion` (the lowest CLI release that
  understands the current launch payload). They are optional so contexts
  captured by earlier backends remain valid.
- **The backend writes them.** This launch config is persisted in the
  encrypted queue payload and decoded by whichever API instance serves the
  claim, and `piApiFirstTurnConfigSchema` is strict, so a backend from before
  these fields existed rejects a payload that carries them. The tolerant reader
  shipped first with the writer off, in `8d8f3a3e14d23f7471e0773bd9acb988f59217af`
  (#36000, released as api 1.657.0 in `1807fbf7e37dc98e99793a57e7799f6dc804ad53`);
  the writer followed in its own release after that API was promoted. This is
  the same staging the API-first usage handoff producer (#35413) used.

  **API rollback floor: `8d8f3a3e14d23f7471e0773bd9acb988f59217af`** (#36000's
  merge commit). An API artifact that predates it rejects, at claim time, every
  queued Pi run created after the writer was enabled. The production rollback
  resolver (`.github/scripts/resolve-production-rollback-target.sh`) enforces
  the floor for API targets; verify manually with
  `gh api repos/okou-ai/okou/compare/8d8f3a3e14d23f7471e0773bd9acb988f59217af...<artifact-sha> --jq .status`
  and require `ahead` or `identical`. Retained Runner tags are not constrained:
  the guest ignores unknown launch-config fields.

- `piLaunchConfig.apiFirstTurn` also accepts the optional
  `requiredPiSessionConstructionDigest`: a build-time SHA-256 over the
  code-determined session construction (the system prompt template and the
  ordered tool schemas for fixed inputs, one profile without and one with the
  memory tools) that `@okouai/pi-agent-runtime` commits in
  `session-construction-digest.json` and whose test fails while it is stale.
  Every CLI artifact manifest carries the same value as
  `sessionConstruction.digest`, and the runner build copies it into the
  installed manifest. It moves only when code that feeds the constructed
  session changes, in whichever package that code lives, whereas
  `piAgentRuntime` also moves on dependency-only release bumps and therefore
  forced the `npx` launch after most releases. **The backend writes it now**:
  the reader shipped first in `322efb6d72508e15b90dc788100a776da1485751`
  (#36142, released as api 1.659.0 in
  `3ffd0d5086a02cd8328cf60defab7a242b682273`), and the writer followed
  after that API was promoted. The production rollback resolver enforces this
  reader as an additional API floor so old strict readers cannot claim queued
  runs carrying the digest. Retained Runner tags are unaffected.
- The guest agent execs the installed CLI only on a parity match at or above
  the CLI floor. When the launch config carries
  `requiredPiSessionConstructionDigest`, parity means the installed manifest's
  `sessionConstruction.digest` is identical, and an installed CLI without a
  digest fails parity; otherwise parity means the installed `piAgentRuntime`
  equals `requiredPiAgentRuntimeVersion`. The installed `cli` must be at or
  above `minCliVersion` in both cases. Every other case launches the
  commit-addressed package through `npx`, which is always built from the
  backend's commit; a launch config without the fields, or a rootfs without an
  installed CLI, always takes the `npx` path.
- The runner advertises the installed versions as an optional `installedVersions`
  field of the claim body. Older backends ignore it; the current backend records
  it in claim telemetry as `runner_installed_cli_version` and
  `runner_installed_pi_agent_runtime_version`. The optional
  `piSessionConstructionDigest` member is advertised when the installed
  artifact has a digest. The backend records it as
  `runner_installed_pi_session_construction_digest`; older installed artifacts
  omit it.
- The CLI restarts a pending-tool API-first handoff from H0 as `sandbox-first`
  when the required session-construction digest, or without one the required
  runtime version, differs from what it bundles. A settled-session continuation
  is a complete checkpoint and is never discarded for a parity difference.

Skew in either direction is therefore safe: a new backend with an old runner
emits the fields into a launch config the old guest ignores, because the
generated Rust bindings do not deny unknown fields; a new runner with an old
backend sees no required version and launches through `npx`.
Raise `PI_SANDBOX_INSTALLED_CLI_MIN_VERSION` whenever a launch-payload or
handoff field becomes required. Retiring `CLI_PKG_URL` and the `npx` path
follows the drain procedure below and is tracked in #35967.

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

### Pi Langfuse trace relay

New run contexts no longer store or inject platform Langfuse credentials.
The commit-pinned CLI exports
OTLP to `POST /api/webhooks/agent/:runId/langfuse/traces` using its existing
`OKOU_TOKEN`. The API checks that token's run/user/org and the run's captured
`langfuseTraceEnabled`, then forwards only the OTLP body and encoding headers
with server-owned Langfuse credentials. Connector account selection cannot
change this destination or authentication. API execution, ownership transfer,
Sandbox Wait, and Sandbox Execution are sibling observations under the
deterministic Run End-to-End parent. LLM and tool observations stay inside their
execution phase. Both V3 and V4 sandbox handoffs carry that run parent and a
required `sandboxWaitStartedAt` timestamp when tracing is admitted. This
staff-only trace contract has no legacy shape or historical rewrite.

The API phase ends when handoff preparation starts. Transfer preparation ends
when manifest publication starts; the sandbox emits Sandbox Wait from that same
timestamp through native execution start. Publication, handoff restoration, and
runtime startup therefore belong to waiting. Publication failures still mark
the transfer as failed. Cross-host clock skew never produces a fabricated or
negative wait; invalid intervals are omitted.

The relay sets `x-langfuse-ingestion-version: 4` on its upstream request so
Langfuse stores native observations without synthesizing an extra trace span.
The API owns this version declaration; incoming headers cannot downgrade it.
This staff-only feature requires v4 ingestion and has no legacy ingestion
fallback or historical trace backfill.

The API and its pinned CLI must ship together through the existing deployment
pipeline. Existing Guests already pass the first-party API URL, run token, and
trusted platform environment to that CLI; no Runner promotion is needed.

The relay first reached production on 2026-09-15 at 05:11:55 UTC in API 1.603.0
and CLI 9.331.0, at commit `4a60b74daa3cba9e11fdb6a072fa989dd1a242d3`
([deployment](https://github.com/vm0-ai/vm0/actions/runs/34931381962/job/104260645155)).
[#34256](https://github.com/vm0-ai/vm0/issues/34256) explicitly retires optional
legacy tracing support: claim-time credential extraction and the Guest bootstrap
file are removed. The 07:19 and 07:21 UTC observations found empty admission and
runner queues and only post-rollout nonterminal Pi runs. Those observations do
not certify complete draining of captured legacy contexts or close the rollback
window; the retirement decision accepts loss of optional tracing for such contexts.

An older context retains its captured CLI URL. That CLI treats an absent bootstrap
path as tracing disabled, so agent execution continues without legacy exports.
Guests still filter platform Langfuse project keys from tracing-enabled Pi child
environments. The current CLI only configures the relay and has no direct-export
fallback. This change does not repair exports from an already-running legacy CLI.
An API rollback that removes the relay route drops optional trace exports from
relay-enabled runs; agent execution continues independently. This retirement does
not change production rollback policy.

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
header. No organization default or stored selection changes; a new catalog row
must be admitted separately before an organization can add the model.

#### GPT 6 Sol native model readiness

Poll and claim requests advertise `X-Native-Gpt-6-Sol: 1` only from Runner artifacts
whose bundled Guest supports GPT 6 Sol and its reasoning efforts. The API checks
this capability after authorizing and validating the stored context, before
claiming native `gpt-6-sol` or `openai/gpt-6-sol` work. A claimant without the
exact capability receives the existing claim `404`; the job stays pending for
a capable Runner. This covers Built-in and BYOK routes without changing any
organization default or stored selection.

Poll excludes unsupported Sol jobs before applying its candidate limit, so old
Runners can still discover existing models behind a Sol job. Claim repeats the
capability check to cover direct notifications and previously discovered work.

The header leaves the strict claim JSON unchanged, so a new Runner can still
claim existing work from an old API, which ignores the extra header. During
API-first promotion, or a Runner rollback, old Runners can continue executing
existing models but cannot consume Sol jobs. Sol work waits until a supporting
Runner is available. The capability remains necessary while an incompatible
Runner is a supported rollback target; no database migration is involved.

#### Claude Opus 5.5 native model readiness

Poll and claim requests advertise `X-Native-Claude-Opus-5-5: 1` only from
Runner artifacts whose bundled Guest accepts Claude Opus 5.5, its gateway alias,
and the model's reasoning efforts. The API checks this capability before an old
Runner can claim Claude Code work whose canonical `modelUsageProvider` is
`claude-opus-5-5`. The logical identity is used instead of `ANTHROPIC_MODEL` so
the guard also covers OpenRouter, Vercel, Azure deployment names, Bedrock
foundation models and opaque cloud profiles.

Poll excludes unsupported Opus 5.5 jobs before applying its candidate limit, so
old Runners can still discover existing work behind one. Claim repeats the
check for direct notifications and previously discovered work. A claimant
without the header receives the existing claim `404`; the job remains pending
for a capable Runner.

The header leaves strict request bodies unchanged and is ignored by old APIs.
During API-first promotion or Runner rollback, old Runners continue executing
existing models while Opus 5.5 work waits. The model remains on the Claude Code
harness until the pinned Pi catalog can resolve and verify it. No organization
default or stored model selection changes, and no database migration is part of
this compatibility boundary.

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
stores that real failure reason for both BYOK and built-in runs. Public presentation
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
built-in/BYOK production samples, Axiom monitor configuration and delivered-alert
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
no migration, data deletion or rewrite is needed. At that GA stage, owner
isolation, Agent grants, winning Run/Runner authority, credential encryption
and host trust remained required. The later
[chat remote access](thread-remote-access.md) cutover replaces Agent grants
with per-chat host permission for Run authority. The Run-lifetime authority
cache and missed-notification window remain unchanged.

Promote the API before the App. An older API can still enforce its rollout switch;
the App retains its existing unavailable/error handling for that response, never
an authorization bypass. Older loaded Apps may hide SSH until refreshed. Already
created Runs retain their minted capabilities and prompt snapshot; create a new
Run to obtain SSH guidance and capabilities. Runner/guest/CLI DTOs and stored
hosts, credentials, pins, grants and observations do not change. Source-level GA
does not attest deployment state or waive the protected-reader constraints below.

## Cloudflare Access for SSH

The #31996 delivery adds a protected transport to the existing SSH host domain.
#34077 is additive database/API authority preparation, including the minimal
current Runner contract reader and Platform diagnostic translations.
Direct and Cloudflare Access are generally available with no rollout switches;
at the original delivery, the SSH Agent grant covered both. The later
[chat remote access](thread-remote-access.md) cutover applies the same per-chat
host permission to both transports. The initial delivery used the
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
unchanged impact. The transaction locks
the Access row before host rows, detaches other owners' references into
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
set under the Access-before-host lock, blocks any actor-owned reference, and
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

The SSH create/update writer validates a referenced config in its transaction:
it selects only a same-organization shared config or the actor's own Personal
config with a config-row `FOR SHARE` lock before binding. Inline SSH creation
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

Migration `1289_thick_bruce_banner` follows the separate 1288 retired-grant
contraction. It makes `vnc_connections.credential_id` nullable only for the
exact `none` / `x509_none` profile; existing credential-backed rows and the
retained direct-route default keep their meaning. Apply it before promoting an
API that can write credentialless rows. Its ordering does not waive the
separate pre-deployment gate for the 1288 grant-table drop above.

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

## Pi native provider reader preparation

For the generation 4 reader-first release, see [Pi native provider preparation](pi-native-provider-preparation.md). Its model generation is independent of launch snapshot V3. Native writers remain absent until the controller verifies compatible API readers and rollback targets, Runner capabilities, pinned CLI artifacts and existing-route health. The preparation merge alone does not close these gates.

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

[The v4 rollout guide](connector-catalog-v4.md) documents bootstrap, capability
and rollback requirements. Production diagnostics reported active catalog
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
switch does not gate existing account callbacks or execution. The addon honors explicit
owner intent and never injects another owner's credentials when the requested
owner is absent, including overlapping builtin/custom destinations.

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
CIMD/DCR, PKCE, exact issuer/resource binding and optional refresh tokens.
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
Automatic OAuth resolution requires this destination to match the current
catalog and the locked account binding. Missing or stale destinations fail closed;
HTTP/custom and no-auth resolution do not require this field. Best-effort runtime
sync cannot authorize credentials for a changed endpoint.

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
Presigned uploads and Runner/Guest object downloads make one application-level attempt;
errors remain visible to the caller. Existing preview-resolution API contracts
remain available to deployed older app and CLI versions. Old Runner versions can
consume the longer-lived URLs without a wire-format change.

Storage URL caches are read on demand and reuse unexpired entries. Missing or
expired entries are signed once during the normal API request. There is no
proactive refresh or retry. The cron endpoint is now
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
handoff-only design. See [API-first run usage handoff](api-run-usage.md).

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

The [V4.1 Pi catalog and deployment contract](../turbo/packages/pi-agent-runtime/src/deepseek-v41-catalog.md)
requires the API's matching commit-addressed CLI for new admission and preserves
old captured contexts. Existing Responses schemas and Runner claims are unchanged.
Retain the V4.1 reader and API billing writer in serving/recovery and rollback
targets while admitted V4.1 Pi work remains.

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

This slice transfers no execution ownership: it consumes no occurrence and adds
no Run, Chat event, email, provider request or credit operation. See
[the migration contract](morning-brief-migration-state.md) for the full
invariants.

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
columns must exist before the new API starts. Reconciliation and
scoped usage cleanup reference the table even when `socialDataJobs` is off.
Old APIs ignore the additive schema; old usage events keep null snapshots and
continue using the existing tariff lookup.

Keep `socialDataJobs` disabled until all serving API instances and account
cleanup workers contain this implementation. Older instances reject the new
job endpoints, and older account cleanup does not remove saved jobs. Setting
the flag during that mixed-version window is unsupported. Credential
provisioning and operational pricing configuration are separate activation
steps. New job settlement commits the priced usage event and durable job
receipt together, so legacy settlement workers cannot observe its pending
event between those writes.

The new CLI uses the saved-job protocol only when job controls are provided.
An old API rejects those endpoints instead of silently running a different
collection. Existing commands without job controls keep their current routes.
New APIs retain list/get/cancel and reconciliation after disabling creation,
so admitted work can drain. The Usage presentation change reads the existing
breakdown contract; stored provider IDs remain unchanged.

After activation, do not roll the API or workers below this implementation
while jobs or usage receipts remain outstanding. Disable new admissions,
finish or cancel admitted jobs, and verify durable settlement receipts before
such a rollback. Database expansion is retained. A merged PR does not prove
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
