# Deployment Compatibility

This guide defines reusable compatibility rules for independently deployed
components and persisted state. Feature-specific rollout plans and production
receipts belong in their owning issue or PR, not in this guide. Removing a
historical note does not retire a compatibility obligation or authorize a
production operation. Existing executable rollback floors remain authoritative.

## Deployment Model

### Frontend

A frontend deployment publishes new browser assets. An already-open page keeps
its loaded JavaScript until navigation or refresh; publishing assets does not
upgrade that page.

The force-upgrade mechanism is API-driven. Standard App API clients advertise
`X-Client-Type: App` and a build-time `X-Client-Version`. The API rejects a
parseable version below the floor in
[`web-client-compatibility.json`](../turbo/apps/api/src/lib/web-client-compatibility.json)
with `426 Upgrade Required` and `Cache-Control: no-store`. The general floor does
not reject a missing or unparseable version. Shared clients show a
non-dismissible update dialog whose action reloads the page. An idle page does
not discover the requirement until its next handled API request.

The shared database Worker reports the same force-upgrade requirement to its
connected tabs. Ordinary Worker transport failures propagate without reloading
the page. Service-worker code is another browser-resident deployment surface;
`skipWaiting()` alone does not refresh already-controlled clients.

Raise the client floor only after the replacement App is live. Production
promotes API before App, so raising the floor in the release that first publishes
that App can make users reload into the same unsupported build. First deploy
compatible API and App changes, then raise the floor and remove the old contract
in a later cleanup release.

Native iOS has an independent floor, enforced by the same API check. iOS
clients advertise `X-Client-Type: iOS` (exact, case-sensitive) and their
marketing version in `X-Client-Version`. The API rejects a parseable version
below the floor in
[`ios-client-compatibility.json`](../turbo/apps/api/src/lib/ios-client-compatibility.json)
with `426 Upgrade Required`, `Cache-Control: no-store`, and the error envelope
`{ "error": { "code": "IOS_UPDATE_REQUIRED", "message": "..." }, "minimumSupportedVersion": "x.y.z" }`,
which iOS treats as a blocking update state. A `null` floor disables iOS
enforcement. Like the web floor, it never rejects a missing or unparseable
version, so builds that predate the client headers cannot be excluded. The floor
must be a stable `x.y.z` version and changes only through a reviewed PR and an
API release, never through environment configuration.

### Backend

The API is the compatibility boundary for frontend and Runner traffic. App
promotion follows the API production lifecycle, including migration and traffic
promotion. Runner promotion waits for API promotion when the same release also
changes the API. Old browser pages and draining Runners can continue to use the
new API; promotion is not an atomic transition for every caller.

Production migrations run before promotion of the exact new API artifact. Old
API instances can therefore issue SQL against the migrated schema. A failed
migration stops promotion. Staged builds, host provisioning, and other
non-serving preparation may finish before migrations; they do not establish
that traffic has moved.

Migrations marked `-- vm0:non-transactional` execute one statement at a time.
Earlier successful statements survive a later failure, and a retry starts the
migration again. Every statement must be idempotent under a full retry.

Evaluate all reachable combinations:

- old App -> new API;
- new App -> old API when traffic propagation or rollback can expose it;
- old Runner -> new API;
- new Runner -> old API when deployment order can expose it.

### Runner, Guest, and CLI Artifacts

Runner and its bundled Guest binaries are one deployment artifact. Each sandbox
belongs exclusively to the Runner that created it; another Runner does not adopt
it, and stopping its owner destroys it. Files private to that sandbox lifetime
need no cross-version reader solely because they cross the Runner/Guest boundary.
The embedded MITM addon and recreated Runner-private registry share that same
artifact boundary. This exemption does not cover independently persisted or
externally consumed data.

CLI packages can be selected separately and captured by queued or active Run
contexts. Keep the exact captured package available through queueing, execution,
and finalization. Do not infer the CLI version from the current API or Runner
version, or remove a protocol merely because a new package has been published.

Never replace a captured package's bytes or redirect its historical URL to a
newer package. Use the exact artifact and required runtime identity for
compatibility decisions. Package semver is a sufficient floor only when the
release process guarantees it advances for every relevant artifact change.

A Runner drain acknowledgement means it stopped admitting new work; claimed
work and finalization can still be running. A healthy replacement or promotion
warning does not prove that every old process exited.

Workspace-cache images, metadata, and history sidecars can outlive their producer
and be consumed by another Runner release. Keep old formats readable or
explicitly invalidate and purge incompatible disposable entries before the new
reader depends on the change. Host-local status files and independently deployed
monitoring collectors also require old/new writer and reader analysis. A
directory-allocation collector can remain independent of Runner releases when
it measures physical blocks without interpreting cache metadata or claiming
reuse eligibility. Changes to directory layouts or metric namespaces still
require consumer updates. Report unavailable or partial observations explicitly
rather than translate old layouts or publish false-zero/stale-success
measurements. Optional diagnostic samples can be
omitted on measurement failure without implying an empty filesystem; retain
legacy fields while tolerant older telemetry readers remain reachable.

## What Requires Compatibility

Compatibility applies to:

- frontend/API requests and responses;
- Runner/API poll, claim, heartbeat, completion, artifact, and resume protocols;
- data written by one API version and read by another;
- schema migrations overlapping outgoing API instances;
- queue and persisted job/Run/session payloads;
- cross-Runner caches, metadata, and independently consumed host files;
- browser-resident Workers and clients that can outlive a deployment;
- captured CLI packages and contexts that retain their own execution lifetime.

Compatibility is not required between package internals in one frontend build,
API build, or Runner artifact, or for state private to one Runner-owned sandbox
lifetime. Determine the owner and lifetime before adding version negotiation.

These requirements protect GA behavior. A feature still behind a non-GA switch
has no old external client solely because its implementation exists; follow
[Fallbacks](fallback.md#2-features-behind-a-feature-switch-need-no-fallback).
A staff-only surface does not make a shared GA billing or credential writer
non-GA.

## Required Change Patterns

Prefer additive cross-version changes:

- add optional request fields before requiring them;
- add response fields without requiring old clients to read them;
- accept old enum values while reachable clients can send them;
- retain an endpoint or migrate clients to a new/versioned endpoint first;
- make readers tolerate missing newly added persisted fields;
- keep migrations compatible with supported outgoing API statements;
- emit only data that every reachable reader can ignore or process safely.

An optional field is not automatically compatible with a strict reader. Deploy
tolerant readers while writers omit the field, then activate writers after old
strict readers and rollback targets have drained or an enforced floor excludes
them.

For an incompatible change, separate the phases:

1. **Prepare:** readers and handlers accept both shapes.
2. **Migrate:** clients and writers start using the replacement.
3. **Clean up:** remove the bridge only after all affected old consumers are no
   longer reachable.

Separate PRs included in one unreleased deployment do not establish reader-first
ordering. Verify the actual deployed artifact and consumer population.
Compatibility branches must name their surface, removal condition, and owning
follow-up; see [fallback declarations](fallback.md#9-declare-new-fallbacks-in-the-pr-summary-and-the-review).
Do not add broad defaults to hide corrupt data or incompatible protocols.

An explicitly accepted breaking cutover must record the affected consumers,
accepted interruption, migration order, and rollback boundary in its owning
issue or PR. Removing historical notes does not establish that acceptance.

### Desktop Response Transforms

Installed Desktop builds decode bound responses strictly and change only after
a Desktop release reaches them, while the API deploys shortly after merge. A
shape-only breaking change to a Desktop-consumed `2xx` response can keep serving
the previous shape to those builds through a response transform registered in
[`client-transforms/desktop.ts`](../turbo/packages/api-contracts/src/client-transforms/desktop.ts).

- **Selection.** The API applies transforms only to `2xx` bodies of requests
  that send `X-Client-Type: Desktop` (exact) and a stable `x.y.z`
  `X-Client-Version`. An entry matches the contract method, path template, and
  status; a version `v` receives it when `maxVersion` is `null` or
  `v <= maxVersion`. Matching entries run in registry order. Other clients and
  missing, prerelease, or unparseable versions receive the current body.
- **Response-only.** Transforms never rewrite requests, non-`2xx` bodies, or
  another client's responses. A change to request shapes, error contracts, or
  semantics uses the prepare, migrate, and clean-up phases above instead.
- **Validation order.** The handler's body is validated against the current
  contract first. The transform receives that validated body, and its output is
  not validated again because it is the old contract by design. Both
  serialization paths, including observed response sizes, use the transformed
  body.
- **Writing a transform.** Make it a pure function of the current body: parse
  it with the current response schema and build the old shape from the result.
  Do not read request state, storage, or time. A transform that throws fails
  the request with a server error; never fall back to the current shape.

Test each transform by copying
[the transform template](../turbo/packages/api-contracts/src/client-transforms/__tests__/transform-template.test.ts).
Assert its output against an explicit JSON Schema of the old shape, taken from
the route's `responses["<status>"].schema` in the production runtime API schema
snapshot (`current.json` in the `runtime-api-schema-prod` release), and assert
that the current body no longer satisfies it. The API runtime's selection and
serialization path (2xx-only application, Desktop version gating,
validate-before-transform, the server error on transform failure and size
observation) has no API test: its synthetic-route fixture test was deleted as a
framework self-test in #37440. Tests never edit the real registry.

### Desktop Contract Gate

Installed Desktop builds decode every route in
[`swift-bindings/routes.ts`](../turbo/packages/api-contracts/src/swift-bindings/routes.ts)
strictly, and the API deploys long before a Desktop release reaches users. The
required `lint-runtime-api-compat` job binds those routes into the runtime API
schema with owner `desktop` and compares the candidate with the production
snapshot that each API production promotion republishes. A breaking Desktop
finding fails the job unless the same PR carries one of two proofs:

- **(A) Floor raise.** Raise `minimumSupportedVersion` in
  [`desktop-compatibility.json`](../turbo/apps/api/src/lib/desktop-compatibility.json)
  to a stable `x.y.z` that is not lower than the base branch floor and not above
  the published Desktop version. A raise covers every Desktop finding in the PR;
  review confirms that the new floor tolerates the new shape. Semantic changes
  expand additively, ship Desktop, then contract together with the raise.
- **(B) Response transform.** Register a transform for the same method, path,
  and `2xx` status in
  [`client-transforms/desktop.ts`](../turbo/packages/api-contracts/src/client-transforms/desktop.ts)
  with `maxVersion` `null` or at least the published Desktop version.
  Transforms cannot prove request findings or route removal, method, or path
  changes. [Desktop Response Transforms](#desktop-response-transforms) defines
  how the API applies them.

The published Desktop version is `currentRelease` of
`GET https://api.okou.ai/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/RELEASES.json`,
which the API serves only after the Desktop update manifest is published. When
it cannot be read, a PR that raises the floor or relies on a non-null
`maxVersion` fails and names the oracle; other PRs are unaffected. A lowered,
removed, or non-stable floor fails even without findings.

The base floor and base schema come from the main commit that the candidate
merges onto, not from the branch's fork point. A finding the base already has
against production was proven by the PR that introduced it; it warns until that
PR reaches production instead of blocking later PRs. Routes absent from the
production snapshot produce no finding until the next API release publishes
them. Runner, Guest Agent, and MITM findings only warn.

Transform lifecycle: a shape-only break registers its transform with
`maxVersion: null`, the Desktop PR that adopts the new shape sets `maxVersion`
as defined in
[`client-transforms/types.ts`](../turbo/packages/api-contracts/src/client-transforms/types.ts),
and once a floor raise passes `maxVersion` the gate reports the transform as
unreachable until it is deleted.

### Coupled Guest Disk and Retained-Image Contracts

A Guest disk cutover couples the Runner/Guest build, device and mount identity,
image layout and exact shape, current-input reconciliation, retained-history
proof, and generation-owned publication. Update the actual producers and
consumers together; a renamed binary, changed path, or transport capability alone
does not establish support for the new layout. Reject incompatible images rather
than interpreting a previous disk format as a new one.

An image is not authority for current authentication, permissions, configuration,
storage inputs, or session history. Reconcile captured Run inputs before use,
then verify retained history against its actual source and current live bytes at
consumption. Missing or invalid evidence requires the normal supported remote
restore, not a format or identity fallback.

Before durable publication, exclude other writers, finish protected readers,
scrub the managed private namespace and authentication state, freeze the disk,
and confirm termination. Publish only the owned immutable generation with its
matching metadata and surviving proof. Namespace cleanup is not a claim of
forensic erasure of deleted filesystem blocks; define that acceptance boundary
explicitly in the owning issue or PR.

## Database/API Transitions

Check two independent directions:

- **Old code after migration:** every outgoing statement remains legal,
  including columns an ORM generates in `SELECT`, `RETURNING`, and
  `INSERT ... ON CONFLICT`, even if application logic does not read them.
- **New code before migration:** new readers and writers cannot require a
  column, enum value, relation, constraint, or function before it exists.

A successful normal migration-before-promotion release closes the second gate
for its exact release artifact. It does not close the first gate or establish
that outgoing or rollback targets have drained. Production rollback promotes
artifacts; it does not restore the old database schema.

Persisted functions, triggers, defaults, views, and other database objects are
consumers too. Query catalog dependencies before contraction; a source search is
not a complete dependency census. Preserve shipped migration history.

### Add, Backfill, Then Require

Introduce a nullable transition column, populate existing rows, migrate writers,
and add the constraint only after every supported writer supplies it. New
readers must not run ahead of the additive migration.

```sql
-- Expand before readers require the field.
ALTER TABLE messages ADD COLUMN event_type text;

-- Backfill while the field remains nullable.
UPDATE messages SET event_type = 'message' WHERE event_type IS NULL;

-- Contract only after supported writers supply the field.
ALTER TABLE messages ALTER COLUMN event_type SET NOT NULL;
```

### Drop in a Later Release

First remove the column from the ORM declaration and all explicit readers and
writers while keeping the physical column. After the preceding API has drained
and rollback compatibility is enforced, drop the column in a later release.
Removing only handwritten reads is insufficient if the ORM still names it.

### Rename with a Narrow Compatibility View

An in-place rename and an auto-updatable single-table view can preserve outgoing
statement shapes. Aliases expose old column names. Test the exact generated
statements, including writes, and remove the view after its consumers drain.
The view does not make the new name available before migration.

Temporary compatibility objects require the exact outgoing SQL contract,
protected release, and removal gate. They are not permission to introduce
business triggers; follow the [trigger policy](api/database.md#database-triggers).

## Drain and Rollback Gates

- **Old App -> API:** the replacement App is live and an enforced client floor
  excludes the old build.
- **New App -> old API:** the old API is neither serving nor a supported rollback
  target.
- **Runner or sandbox:** old owners finish draining, including bounded
  finalization, not merely agent execution. Account for captured CLI contexts.
- **Database/API:** the migration succeeded, outgoing consumers drained, and
  retained rollback targets work with the contracted schema.
- **Persisted formats and durable references:** account for retained data and
  references separately; a client upgrade does not erase old rows or copied
  links.

Every applicable gate must pass. A merge, nominal deployment duration, or an
arbitrary elapsed interval is not drain evidence. Keep enforced rollback floors
in [the main-owned records](../.github/rollback-floors) and their release tooling;
this document does not reset or replace them. Contracted-schema recovery must
restore compatibility first or roll forward, not promote an incompatible API.

## Testing Expectations

Select cross-version coverage for the changed boundary:

- current and reachable previous request shapes;
- missing new response fields or previous responses when clients can receive them;
- outgoing Runner requests against new handlers and new Runner behavior against
  old/missing responses when that pairing is reachable;
- rows and payloads written by the preceding release;
- previous API statement shapes against the migrated schema, including actual
  ORM-generated column lists and writes through compatibility views;
- new writes against every reachable previous reader;
- rejection of retired shapes once an enforced floor and completed drain replace
  their compatibility obligation.

Name the environment, actual artifact identities, exposure window, and remaining
acceptance gaps in the owning PR or issue. CI and preview success do not prove
production deployment, data convergence, or drain. Follow [Testing](testing.md)
for caller boundaries and meaningful behavior assertions.

## Historical Evidence

The former feature-by-feature rollout journal is available at
[the pre-cleanup revision](https://github.com/okou-ai/okou/blob/9813db4b51faa42c982dcfec1720caf5bd5b1b82/docs/deployment-compatibility.md).
It is dated evidence, not proof of current deployment state. Revalidate the
owning source, issue/PR, serving artifact, and executable rollback floor before
acting on a historical receipt.
