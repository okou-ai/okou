# Deployment Compatibility

This guide defines reusable compatibility rules for independently deployed
components and persisted state. Keep feature-specific business logic in source
code, and rollout plans and acceptance evidence in the owning issue or PR, not
in this guide or other documents at the `docs/` root.

## Deployment Model

### Frontend

An already-open page keeps its loaded JavaScript until navigation or refresh.
Publishing new assets does not replace that code. Service workers and shared
browser workers can also outlive the deployment that produced them.

The App's API-driven upgrade floor is defined in
[`web-client-compatibility.json`](../turbo/apps/api/src/lib/web-client-compatibility.json).
A handled request from an identified build below that floor receives
`426 Upgrade Required`; the user must accept the update dialog to reload. An
idle page does not discover the floor, and missing or unparseable advertised
versions are not excluded by the general floor.

Raise a client floor only after the replacement frontend is live. First ship
an API that accepts both contracts and the replacement frontend; raise the floor
and remove the old contract in a later release. Otherwise, API-first promotion
can send users into a reload loop while the origin still serves the old build.
A client floor does not retire non-App callers or persisted data.

### Backend

Production migrations run before API traffic promotion. App promotion waits
for the API production lifecycle; Runner promotion waits for API promotion when
the same release changes the API. This is not an atomic switch for every client.
Builds, host provisioning and other non-serving preparation can happen earlier.

Old API instances can still serve against the migrated schema. Retained rollback
artifacts must also remain compatible: rolling back code does not restore an old
database schema. A failed migration must prevent promotion of the new API;
promote the exact artifact whose required migrations completed.

Non-transactional migrations execute statements independently. Earlier successful
statements survive a later failure, and retry starts the migration again. Every
statement must be safe under a full retry from the beginning.

### Commit-addressed CLI artifacts

Execution contexts capture an immutable CLI package URL when they are created.
Queued and active work keeps that artifact after later API or Runner deployments.
Never replace its bytes or redirect its historical URL to a newer package.

Use the package commit and required runtime identity for compatibility decisions.
Package semver is not a sufficient floor unless the release process guarantees
it advances for every relevant artifact change. An installed bundle must satisfy
the captured context's compatibility requirements; a newer Runner alone does
not prove that all work uses a newer CLI.

Before removing an API variant consumed by an older CLI, deploy the compatible
replacement, then account for the maximum queue, execution and finalization
lifetimes. Verify that no old captured context or supported externally pinned
caller remains. This gate is separate from Runner process drain.

### Runner

#### Runner process drain

Promotion starts and verifies the replacement Runner, then requests soft drain
of older processes. A drain acknowledgement means the process stopped admitting
new work, not that its claimed work and finalization have completed. Promotion
warnings or a healthy replacement do not prove that every old process exited.

Old Runners keep calling the API while their work drains. Support those requests
until the old processes and their finalization have finished. A new Runner must
also tolerate an old API whenever deployment propagation or a supported rollback
can expose that pairing.

Runner and bundled Guest binaries ship as one artifact. A Runner does not adopt
another Runner's sandboxes, and stopping the owner destroys its sandboxes.
Sandbox-local state private to that artifact does not need cross-version readers.
Shared host caches, lock identities, workspace images and history sidecars have
a different lifetime: later artifacts can consume them, so they require a
compatible format or explicit invalidation before a new reader depends on it.

## What Requires Compatibility

Compatibility is required across deployable or durable boundaries:

- Frontend and independently deployed API requests and responses.
- Runner-facing API requests, responses and completion/finalization paths.
- Data written by one version and read by another during rollout or rollback.
- Database migrations while outgoing API instances still serve or drain.
- Queues, persisted job payloads and captured execution/session contexts.
- Shared caches, workspace images, metadata and sidecars consumed by later
  artifacts.

Compatibility is not required between internals shipped in one artifact:

- Packages inside one browser build or API deployment.
- Runner and its bundled Guest binaries.
- Files private to one Runner-owned sandbox lifetime.

A non-GA feature does not need compatibility solely for its cutover. Apply the
[feature-switch and fallback rules](fallback.md#2-features-behind-a-feature-switch-need-no-fallback)
without removing independently retained data, authorization or recovery
contracts.

## Required Change Patterns

Prefer additive changes across version boundaries: optional inputs, tolerant
readers, retained endpoint variants and data that old supported readers can
still process. An optional field can still break a strict reader. Deploy tolerant
readers before enabling new writers, and keep those writers disabled until old
strict readers and incompatible rollback targets have drained or are excluded.

For an incompatible change, separate the work into phases:

1. **Prepare:** accept both protocols and make readers tolerate both persisted
   representations.
2. **Migrate:** move producers and consumers to the replacement contract.
3. **Clean up:** remove compatibility only after unsupported callers, captured
   contexts and rollback artifacts can no longer exercise it.

Do not remove an API field, endpoint or persisted representation in the same
release that first introduces its replacement consumer. A source merge, green
pipeline, arbitrary wait or absent sampled traffic does not establish drain.
Document the actual exposed versions, bounded lifetimes, supported rollback
set and evidence for closing each gate.

An explicitly owner-accepted breaking cutover may instead reject an outgoing
pairing. Record the accepted interruption, affected consumers, migration order
and rollback boundary in the owning issue or PR. Cleanup itself does not
establish that acceptance.

Compatibility must be temporary and explicit. Record the protected surface and
verifiable deletion condition in a short source comment or a follow-up issue.
Do not add broad defensive fallbacks to hide incompatibility; follow the
[fallback requirements](fallback.md).

## Database/API Transitions

Evaluate both directions independently:

- **Old code after migration:** outgoing and rollback APIs must still issue
  legal SQL. Include ORM-generated `SELECT`, `RETURNING` and conflict clauses,
  not only fields explicitly read by application code.
- **New code before migration:** readers and writers must not require new
  columns, enum values, relations, constraints or functions before they exist.
  Migration-before-promotion closes this direction for a normal successful
  production release, not every preview or alternative deployment path.

Use staged schema transitions:

- Add a nullable field before readers require it, backfill existing rows, then
  enforce the constraint only after all supported writers supply it.
- Remove a retired column from ORM declarations and all readers/writers in a
  code-only release; drop the physical column only after the previous API drains.
- When renaming a relation or column, an explicitly verified, auto-updatable
  compatibility view can preserve the outgoing statement shape. It does not
  protect new code before the rename migration.
- Inventory database functions, existing triggers and column defaults through
  PostgreSQL catalogs before contraction; a source scan cannot find every
  persisted consumer. Follow the [database guidance](../.claude/skills/database-development/SKILL.md)
  and its restrictions on new database objects.

Verify the exact old statements against any permitted compatibility object and
remove that object after its protected releases drain. Before destructive cleanup,
confirm the replacement is healthy and exclude rollback artifacts requiring the
removed schema. Recovery must restore compatibility or roll forward; a code
rollback alone is insufficient.

## Testing Expectations

Cover the old/new pairs that can actually coexist:

- Current and previous frontend requests against the new API, plus missing or
  old response fields that the new frontend can still receive.
- Old Runner requests against the new API, and new Runner behavior against old
  API responses wherever that pairing is supported.
- Persisted rows, queue payloads, session history and captured contexts written
  by previous versions and read by the replacement.
- Real outgoing SQL against the migrated schema, including ORM-generated
  columns, `INSERT ... RETURNING` and `INSERT ... ON CONFLICT`.
- New writes consumed by a previous reader, or evidence that the old reader
  cannot observe those writes.

Tests establish behavior for their inputs; they do not establish production
promotion, complete fleet drain or rollback readiness. Record deployment and
lifecycle evidence separately. Once an old shape is outside the supported
boundary, follow the [testing anti-pattern guidance](testing/anti-patterns.md)
rather than keeping tests whose only purpose is to pin retired behavior.

## Rollout Records

Keep specific release matrices, cutover decisions, version/commit floors and
production receipts in the owning issue or PR. Do not append feature histories,
implementation inventories or incident timelines to this guide. A historical
receipt must be refreshed before treating it as evidence of current deployment.

Earlier feature-specific notes remain available in
[the pre-cleanup Git revision](https://github.com/okou-ai/okou/blob/adbed2f709d35cae7273789ce098569f32421eba/docs/deployment-compatibility.md).
Removing those notes from this guide does not authorize a deployment, retire an
active compatibility requirement or remove an enforced rollback floor.

## Debug Morning Brief sample mail

The session-only Debug action adds `POST /api/debug/morning-brief-email` and an
owner-scoped receipt read. Both `_debug` and default-off `notifyMail` gate the UI
and API. The request supplies only a stable UUID; the server fixes content,
recipient and links and does not impersonate an Agent or invoke an automation.

Apply the generated nullable `mail_notifications.source_run_id` migration before
promoting the API. Old Agent producers still supply that column and old receipt
readers do not expose it, so existing notifications remain valid. New Debug
receipts use NULL source and the `debug-morning-brief` identity namespace; no
existing row is changed or backfilled. The normal owner cleanup and durable
idempotency lifecycle apply.

Deploy every outbox drainer with the new `debug-morning-brief` template reader
before exposing the Debug producer. Old drainers reject that template. Old App
versions do not call the new API; a new App with an old API gets a visible HTTP
error, preserving the same request UUID for retry. Stop new Debug production and
drain pending samples with compatible workers before restoring an older drainer.
Already committed provider requests retain their payload and key.

The Official source check, `resultEmail`, instruction and schedule/readiness
contracts are unchanged. This PR does not enable switches, publish production
or establish real inbox delivery.
