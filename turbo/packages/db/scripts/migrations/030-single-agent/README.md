# Single Agent migration operators

Read-only inventory and offline dry-run planning for #45474, under Epic #45400.
The `single-agent:prepare` commands do not implement `apply` or recovery. Every generated plan has
`executable: false`, including plans with no detected blockers. A plan is an
operator review artifact, not authorization or an executable migration manifest.

## Run

From `turbo/packages/db`, using the repository's pinned dependencies:

```sh
# Supply DATABASE_URL through your normal authorized environment.
pnpm single-agent:prepare inventory \
  --org-id <exact-org-id> --target <environment-label> \
  --output /private/path/inventory.json

# Offline: DATABASE_URL and network access are not required.
pnpm single-agent:prepare plan \
  --org-id <same-org-id> --inventory /private/path/inventory.json \
  --output /private/path/plan.json
```

Both commands require an explicit org and a new output path. They refuse to
overwrite files, create files with mode `0600`, and print only a receipt with the
output path, SHA-256 and blocker status. Keep reports in an owner-only directory:
they contain private entity names, IDs, ownership, bundle references and content
hashes. Raw Instructions, Workflow bodies, Chat titles/messages, trigger payloads
and connection strings are not emitted. Unexpected failures print only the error
class; raw database errors can contain source values or credentials.

`inventory` reserves one connection and initializes its server session with
explicit SQL for `default_transaction_read_only=on` and the existing 60-second
statement timeout. This does not depend on a gateway forwarding startup settings.
It then reads the named org using one SQL statement, giving all selected tables
a consistent statement snapshot. The resulting snapshot must attest
`transaction_read_only=on`. It selects no other org's rows. No S3 publication,
connector, runtime execution or feature-switch change occurs. The environment
label is supplied by the operator; it does not verify branch lineage or serving
deployment identity. The database name is recorded separately.

`plan` strictly validates the versioned inventory schema and unique identities,
checks the requested org against the snapshot, and binds its output to the exact
input bytes with SHA-256. It uses no database. Repeating the command against the
same inventory produces identical plan bytes. Treat an inventory as trusted
operator input; its hash detects different input, not forgery or stale state.
Plans use `single-agent-plan-v7`; inventories remain
`single-agent-inventory-v1`. Regenerate earlier plans from their inventory to
apply the approved naming, private-Agent-owner and publication policies. No
plan version can be passed directly to a write command.

Each plan embeds a complete `agentPrefixes` object. Save that object as an
owner-only JSON file to review, edit short English aliases, and reuse it:

```sh
pnpm single-agent:prepare plan \
  --org-id <same-org-id> --inventory /private/path/inventory.json \
  --agent-prefixes /private/path/agent-prefixes.json \
  --output /private/path/another-plan.json
```

The map must use `single-agent-prefixes-v1`, match the org, cover exactly all
non-default source Agent IDs and assign a distinct valid prefix to each.
Configured prefixes are used verbatim and canonically sorted, not regenerated
from display names. Input maps with unknown/missing IDs, duplicate IDs/prefixes,
invalid characters or more than 12 characters fail before any report is written.
The complete effective map is embedded in the plan and bound by its output hash.

Exit codes:

| Code | Meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| `0`  | Inventory saved, or plan saved with no detected blockers; still non-executable.       |
| `1`  | Invalid arguments/input/scope, missing org/default Agent, database or output failure. |
| `2`  | Plan saved with detected blockers that need resolution.                               |

## Planned rules

- Resolve the target exclusively from this org's `default_agent_id`; require a
  public target. No name-based target lookup or all-org mode exists.
- For each other Agent, derive a lowercase ASCII prefix from its trimmed display
  name (or canonical name when no display name exists), normalize accents and
  separators, and bound it to 12 characters. Disambiguate colliding prefixes with
  the first eight source Agent ID digits, shortening the readable stem to fit.
  Labels with no ASCII letters/digits receive `a-<shortAgentId>` until the
  operator supplies a readable English alias through the fixed map. Generated
  prefix collisions still fail closed and require a distinct configured map.
  Empty source labels are invalid; no identity is fabricated.
- Plan `<prefix>--instruction` and `<prefix>--wf-<workflowName>`. Preserve valid
  original Workflow names when the full name fits the 64-character contract.
  Otherwise shorten the Workflow stem and append eight SHA-256 digits derived
  from `(source Agent ID, original Workflow name)`. Same-source public/private
  overrides therefore keep one target name; distinct long names retain distinct
  suffixes. The original name remains in the source record. Invalid original
  Workflow names are not repaired by shortening.
  Keep same-source overrides under one name when their target visibility/owner
  scopes remain distinct. Privatization can collapse a public Workflow and its
  same-owner private override into one scope; block that conflict without
  merging or renaming either ID. Block other collisions, existing default-Agent
  names and invalid names; never overwrite or merge a conflict.
- Keep existing Workflow and Automation IDs. Workflow plans retain the source
  revision, original owner and immutable bundle reference, and require
  republishing the renamed generated `SKILL.md`. Every Workflow from a private Agent becomes
  private under the source Agent owner, including when its original Workflow
  owner differs. Record each ownership transfer as `ownershipChange`, leaving
  the original source row intact. Public-Agent Workflows keep their original
  owner and visibility. Each move names its `targetOwner` and `targetVisibility`.
  Private Agent Instructions become a private Workflow owned by the Agent owner.
  Retained Automations, including disabled ones, keep their owner and state; row
  fingerprints pin their full database configuration without exporting trigger
  contents. Automation execution Chat bindings are inventoried separately.
  On a source private Agent, Automation or binding owners different from the
  Agent owner are invalid execution associations. Plan their deletion in
  `automationDeletions` / `automationThreadDeletions`, retaining source IDs,
  revisions, Automation fingerprints and original Chat IDs for review/recovery.
  This applies to enabled and disabled records; never reassign execution users
  or create private Workflow copies to keep these associations alive. Removing
  a binding does not remove its Chat, messages, Workflow or Project membership.
  Retained Automations and bindings record their owner's before/after Workflow
  visibility and block other inaccessible target Workflows. This static visibility
  check does not establish runtime eligibility or trigger delivery.
  Non-default Official Workflow installations block pending their own mapping.
- Compare Workflow view/manage/publish rights before and after the host change
  using the current Workflow-owner/host-writer rules and cached org membership.
  `workflowMaintenancePolicy: workflow-owner-or-host-writer` applies to both
  source and target: public Workflow owners may maintain their own content,
  as may writers on a visible host Agent. Private Workflows remain owner-only,
  Official Workflows remain read-only, and publication eligibility is unchanged.
  Record all per-member differences. For private-Agent Workflows, view/manage
  changes are accepted by the explicit private-Agent-owner policy: the Agent
  owner receives owner-only access and a different former Workflow owner loses
  access. Under `workflowPublicationPolicy: use-existing-target-permissions`,
  publication eligibility follows the target's existing owner/admin gate for
  the private Workflow owner. Record gains and losses as `acceptedChanges`,
  retaining their before/after rights; there is no migration-specific publish
  grant or grandfathered eligibility. Public-Agent view/manage differences
  remain `unresolvedChanges` and block. Converted public Instructions retain
  their source owner's maintenance rights as Workflow owners. Other maintenance
  changes, including a non-admin target Agent owner gaining access or a former
  host owner losing access to another author's public Workflow, still block.
  The modeled policy follows #46438; verify it on serving and supported rollback
  APIs before execution. An offline plan does not establish deployed behavior.
  No runtime permissions or actual Workflow visibility are changed by planning.
  The cache is preliminary evidence, not live membership authority.
- Initialize members with no personal Instructions row once from the public
  default Agent's snapshotted Instructions. Preserve every saved row, including
  deliberately empty content. Earlier automatically seeded rows also remain
  preserved pending provenance review; text equality and timestamps do not prove
  that a user did not save a value.
- Group old Chats into new private Projects per `(org, Chat owner, source Agent)`.
  Prefer the Agent's trimmed display name, using its canonical name when no
  nonempty display name exists. When source Agent labels match case-insensitively,
  append ` (<shortAgentId>)` to each matching label. Keep these source groups
  distinct and validate the product's 120-character limit.
  Preserve Chat IDs and original Project membership in the plan. Existing
  same-name Projects are listed and block automatic adoption; incoming Project
  name collisions also block. Existing Projects are never deleted or merged.
- Future execution must use the owner's personal Instructions. Converted
  Instruction Workflows have `automaticallyInvoke: false`; they are not an
  automatic continuation hook.

## Deliberate boundaries before apply

This first stage does not establish that the org can be migrated. The plan always
lists the remaining gates:

- Verify live membership, per-member modes, converted-Instruction publication
  rights and earlier seed provenance.
- Download and verify actual bundle bytes, authored text, attachments and size
  limits. This inventory records text hashes/byte counts and bundle references;
  it does not validate archive contents or produce renamed bundles.
- Inventory authored name references, connector/Chat account permissions,
  external channel routing and all dependent foreign keys. Do not infer account
  access from Agent or Workflow sharing, or widen old grants.
- Handle continuation executor routing, unbound/native session state, queued
  inputs, Automation listener/webhook/delivery state and event/cache projections.
  Chats selected here are those bound to this org's Agents; this is not a complete
  inventory of unbound or retired runtime references.
- Before executing planned association deletions, journal full source and
  dependent rows, inspect foreign-key effects and queued work, and preserve Chat
  and Run history. Inventory fingerprints/revisions alone cannot restore deleted
  configuration; the future apply/recovery protocol must own that journal.
- Complete integrated acceptance #45473 and exercise the versioned, drift-checked
  copy operator below before the staff production cutover.

Use the same reviewed tool revision for an isolated production-child-branch
rehearsal and subsequent review. A staff production cutover needs a fresh plan,
followed by persisted-data and runtime acceptance. Other orgs need separate fresh
inventories/plans. Legacy Agent deletion belongs to #45476.

## Isolated-copy execution and recovery

`single-agent:rehearse` is a separate operator for a stopped, isolated database
and object-store copy. It is not a production cutover entry point. The original
`inventory`/`plan` commands remain read-only and their reports remain
non-executable. This operator creates a different, hash-bound execution image
after validating the reviewed report, current rows, complete source archives,
canonical Workflow documents and attachment manifests.

Before a staff-copy rehearsal, complete #45473, verify the deployed permission
policy, resolve every plan blocker, verify the copy's lineage and stop its API,
schedulers, listeners and other writers. The operator checks active/queued work,
but cannot stop remote ingress or establish live Clerk membership. A database
name, endpoint or target label does not prove that a database is a copy. Record
those operational prerequisites in #45474; do not invent acceptance evidence to
pass the command's explicit writer-drain acknowledgement.

Use an owner-only connection file and explicitly configured **copy** object
store. Populate that store with the source's immutable archive objects before
preparation. Never point a rehearsal at production credentials or publish its
test objects to a production bucket.

```sh
# DATABASE_URL_FILE is a mode-0600 file containing the isolated copy's URL.
# Set R2_ENDPOINT, R2_USER_STORAGES_BUCKET_NAME, R2_ACCESS_KEY_ID and
# R2_SECRET_ACCESS_KEY through the authorized copy environment.
pnpm single-agent:rehearse prepare \
  --org-id <org-id> --target <copy-label> \
  --inventory /private/inventory.json --plan /private/plan.json \
  --expect-plan-sha256 <reviewed-plan-hash> \
  --directory /private/new-execution

pnpm single-agent:rehearse apply \
  --org-id <org-id> --target <copy-label> \
  --directory /private/new-execution \
  --expect-image-sha256 <reviewed-execution-hash> \
  --rehearsal --writers-drained --migrate

pnpm single-agent:rehearse verify \
  --org-id <org-id> --target <copy-label> \
  --directory /private/new-execution \
  --expect-image-sha256 <reviewed-execution-hash>

pnpm single-agent:rehearse recover \
  --org-id <org-id> --target <copy-label> \
  --directory /private/new-execution \
  --expect-image-sha256 <reviewed-execution-hash> \
  --rehearsal --writers-drained --migrate
```

Preparation writes a new mode-0700 directory with mode-0600 `execution.json`
and prepared archive files. Unlike the metadata inventory, this recovery image
contains complete private source rows, Instructions, Chat metadata and affected
Automation configuration/dependent records. Keep it owner-private, durable and
outside Git. PostgreSQL JSON text stays intact to preserve wide numeric values
and microsecond timestamps. The image pins the org, database endpoint/name,
object-store endpoint/bucket, schema, source revisions, inventory/report hashes,
source identities and exact before/after values. It never unions grants or
changes member overrides.

Apply flushes an exclusive attempt receipt before its first external effect,
verifies/publishes immutable hash objects, then publishes the database changes
and Project/Chat metadata events in one atomic SQL statement. Every affected
write has its source-value condition; a failed admission or row count aborts
the whole statement. No explicit transaction, advisory lock or coordination
table is introduced. Automation deletion recovery includes known cascading
children and historical Run references; unknown deletion dependencies block.

There is one database checkpoint per org image. An absent completion receipt
does not prove failure: `verify` reads authoritative rows and reports `before`,
`after` or drift. Repeating apply on the exact after image verifies objects and
returns `already-applied` without duplicate rows/events. Recovery only accepts
the exact after image, restores full source data and publishes compensating
Project/Chat events. It rejects later edits instead of overwriting them.
Repeating recovery returns `already-recovered`. Event sequences remain
monotonic, PostgreSQL row revisions are not rewound, and immutable shared
objects are retained. Prepare a fresh inventory/report/image to rehearse again
after recovery.

This verifies persisted migration behavior, not native continuation, live
authorization, listener delivery or production rollout. Those remain explicit
acceptance gates under #45473/#45474. Agent retirement remains #45476.

## Protected staff production cutover

`.github/workflows/single-agent-migration.yml` is the manual production entry
point. It runs only from `main`, requires the existing `production` environment
review, and serializes all its modes without cancelling an in-flight operator.
It does not merge, deploy, change feature switches, stop writers, resize compute,
clear queues, retire Agents, or enable another organization.

The first cohort is exactly `org_3ANttyrbWYJk6JKRSTRLEsbsDLe`. The operator
resolves the default, protected, ready production branch in Neon project
`hidden-lab-39609750`, requires a unique read-write endpoint, validates every
connection identity, and checks the fixed production R2 bucket and endpoint.
Both configured compute bounds must be at least **8 CU**. The rehearsal passed
at fixed 8 CU; 1 CU failed with PostgreSQL `53200`. This is a conservative
prerequisite for this image, not a measured minimum for every organization.
The existing 60-second SQL statement timeout is unchanged.

Before the first dispatch:

1. Keep #45473 acceptance, the successful staff-copy migration/verification/
   recovery evidence, serving permission-policy identity and supported rollback
   compatibility recorded in #45474.
2. An authorized owner provisions `SINGLE_AGENT_MIGRATION_IMAGE_KEY` in the
   protected production environment: 32 cryptographically random bytes encoded
   as 64 lowercase hexadecimal characters. This is a dedicated AES-256-GCM key,
   never an R2 key. Retain an owner-private copy for review and recovery. Keep
   the key available and unchanged until the cutover and recovery window close.
   This PR does not create or read that secret.
3. Confirm authorized production Neon, Clerk and R2 credentials and the existing
   bucket/account variables are configured for the workflow. The coding and
   review process must not retrieve production credentials.
4. Dispatch `target` with the exact staff org ID. This fetches branch/compute
   metadata only: it does not request a database connection URI or read rows.
   Arrange any capacity change separately, then repeat this inspection.
5. Arrange a real maintenance window. Stop API ingress, scheduler dispatch,
   listener/webhook/worker delivery and every other database writer; drain
   running and queued work; freeze membership/role changes. Record who stopped
   what and the evidence in #45474. `writers_drained` is an operator attestation,
   not an automatic service-control mechanism. Database zero-work and full
   source/schema/drift checks are additional gates, not proof that ingress has
   stopped. The production operator never deletes active/queued indexes to
   manufacture an idle database.

Review the fixed prefix map from the rehearsal against the current source
Agents. Encrypt that owner-only JSON file before dispatch; private Agent IDs and
names must not appear in workflow inputs. From `turbo/packages/db`:

```sh
pnpm single-agent:package seal-prefixes \
  --input /private/agent-prefixes.json \
  --key-file /private/migration-image-key \
  --output /private/prefixes.base64
```

Both input files must have mode `0600`; their containing directory must be
owner-private. The command prints only the plaintext map digest and an output
path. Supply the encrypted file's single base64 line as `prefixes_base64` and
its printed digest as `prefixes_sha256` for `plan`, with `writers_drained=true`.

The `plan` mode obtains the explicit `RO` database role and verifies SELECT-only
privileges. Inventory, plan and preparation use read-only sessions. Live Clerk
membership and roles must exactly match the cached census; pages, duplicate
members and incomplete results fail closed. A complete fixed map, zero blockers,
zero running/queued work, immutable source archive validation and drift checks
must pass. Preparation only reads immutable production objects.

A successful plan retains `single-agent-plan-<run-id>` for 30 days:

- `execution.enc`: authenticated encrypted recovery rows, source inventory,
  reviewed plan, immutable archive bytes and attempt receipts;
- `metadata.json`: non-content scope, source commit/run, hashes and counts;
- `audit.json`: redacted operation identity and outcome.

Plaintext rows, Agent names, source bodies, credentials and archive bytes are
never uploaded as artifacts. Download the original plan artifact to a private
local directory and inspect it using the privately retained key:

```sh
chmod 600 /private/review/metadata.json
pnpm single-agent:package open \
  --input /private/review/execution.enc \
  --metadata /private/review/metadata.json \
  --key-file /private/migration-image-key \
  --output /private/new-review-directory
```

Review `execution.json`, including its `inventoryBytes`, `planBytes`, before/after
rows and bundle manifests. Keep all decrypted material outside Git and delete it
when no longer needed. Confirm the printed image hash and the metadata plan
hash; record approval of these exact hashes and the source run in #45474.

Dispatch `apply` with `plan_run_id`, `plan_sha256`, `image_sha256` and a renewed
truthful writer-drain attestation. The source must be a successful first-attempt
`plan` dispatch of this workflow on the **same exact main commit**. If main has
advanced, prepare and review a new plan. The operator downloads the original
artifact by exact run/name, authenticates it, checks its production-only purpose,
org/project/branch/endpoint/revision bindings and current live membership, then
uses the same immutable publication and atomic SQL checkpoint as the rehearsed
copy operator. The original encrypted plan must already be durably uploaded
before apply can start. Shared SQL source-value conditions, row-count assertions,
schema and complete image drift checks remain enforced.

Use `verify` with the original plan run and hashes to distinguish authoritative
`before`/`after` data from drift, especially after cancellation, timeout or an
uncertain outcome. Never infer failure from a missing completion receipt. Do not
use GitHub's rerun button: every dispatch must be attempt 1. Investigate the
existing outcome before dispatching a new operation; there is no automatic
apply retry or rollback.

`recover` requires writers to remain stopped, the original plan run/hashes and
the exact after image. It refuses later edits, restores complete source rows,
retains immutable shared objects and preserves monotonic event sequences.
Verification and recovery may run after main advances: the workflow verifies
that the producer commit is still an ancestor of main, checks out that original
reviewed commit and uses its operator and dependencies. Apply cannot use this
exception. A missing original artifact or package key blocks recovery; retain
both throughout the recovery window. Cleanup removes plaintext and credentials
on success/failure; cancellation also has shell/always-step cleanup, and the
original encrypted plan remains the durable recovery source if a runner dies.

Before resuming writers, verify persisted data and source/target object
references. Then record production runtime checks for personal Instructions,
Workflow permissions, Project/Chat continuation and retained Automation delivery
in #45474. Persisted migration success alone does not establish runtime
acceptance or authorize the next organization. Each later cohort needs its own
fresh inventory, reviewed plan and explicit rollout decision.

## Verification

```sh
DATABASE_URL=<local-disposable-database-admin-url> pnpm test:single-agent-migration
```

The test creates and deletes its own uniquely named database, applies the actual
repository schema, and runs the CLI as a subprocess. It checks tenant isolation,
Postgres read-only attestation through a local gateway that strips optional
startup settings, no source-row changes, private report creation,
offline deterministic planning, preserved empty personal content, owner-separated
Projects and prior membership, enabled/disabled Automations and execution Chat
bindings, audited publication gains/losses, remaining permission blockers,
name/length conflicts, strict scope validation and overwrite refusal. It covers
Agent-owner private conversion, recorded
ownership/access changes, unchanged public-Agent visibility, post-privatization name-scope collisions, and
private-Agent non-owner cleanup, preserved Chat/source data, and other lost
Workflow access for both enabled/disabled Automations and execution Chat
bindings. The migration CI job runs this same test. This is tool verification,
not staff production rehearsal or runtime acceptance.
Naming coverage includes bounded/deduplicated readable prefixes, non-Latin
aliases, complete fixed-map replay, map scope/duplicate rejection, deterministic
long-name shortening with preserved override grouping, and separate same-name
Agent Projects with stable source suffixes.

The same CI command also runs `test-execution.ts` against a second owned
database and an isolated HTTP object-store fixture. It exercises actual CLI
subprocesses, complete before/after data, immutable bundle publication, attachment
bytes/modes, private-Agent ownership, personal empty/preserved values, uncertain
committed PostgreSQL responses, idempotent resume, cascading-row/Run-reference
recovery, later-edit rejection and concurrent first saves. It does not run a
staff-copy rehearsal or execute a Workflow.

`test-production.ts` invokes the production CLI with MSW protocol fixtures at
the external Neon/GitHub/Clerk boundary, without production credentials or network
access. It checks target-only inspection, 8 CU admission, exact-plan source
verification, retained-source recovery selection, authenticated encrypted package
round trips, tamper/unexpected-entry rejection, private file modes, encrypted
prefix submission and paginated live membership drift. The shared real-Postgres
execution test also rejects production-purpose images at the copy CLI boundary.
These tests do not execute a production cutover or establish staff runtime
acceptance.
