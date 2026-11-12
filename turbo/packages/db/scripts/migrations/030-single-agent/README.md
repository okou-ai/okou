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

## Manual staff production cutover

Run `single-agent:production` directly on the operator's authorized machine,
using the repository's pinned dependencies and a clean reviewed Git checkout.
Merging or deploying this code does not execute it. There is no GitHub Actions
execution dependency, repository secret, Actions run ID or artifact download.
The migration SQL, scope and recovery guarantees are shared with the copy operator.

The first cohort is exactly `org_3ANttyrbWYJk6JKRSTRLEsbsDLe`. Neon metadata must
confirm project `hidden-lab-39609750`, its default/protected/ready production
branch and a unique read-write endpoint. Both configured compute bounds must
be at least **8 CU**; fixed 8 CU passed the staff-copy rehearsal while 1 CU failed
with PostgreSQL `53200`. This is a conservative admission condition, not a
measured minimum for every organization. The SQL timeout remains 60 seconds.
The operator does not resize compute, stop writers, clear work indexes, deploy,
change feature switches or enable another organization.

The executing machine supplies credentials through its existing authorized
secret environment and an owner-only database connection file:

- `NEON_API_KEY`: metadata-only GET requests for the fixed branch/endpoint. The
  operator never asks Neon for a connection URI or role password.
- `DATABASE_URL_FILE`: mode-0600 connection file for that exact endpoint and
  `neondb`; use `RO` for plan/verify and `neondb_owner` for apply/recover. TLS is
  verified. Database metadata must attest the login, database, read-only session
  and appropriate table/column privileges.
- `CLERK_SECRET_KEY`: a complete live membership/role census must match the
  cached inventory. Missing pages, duplicate members or membership drift block.
- `R2_ENDPOINT`, `R2_USER_STORAGES_BUCKET_NAME`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`: explicitly select the fixed production object store.

No credential value is a command-line argument, receipt or stdout field. Do not
retrieve production credentials while implementing or reviewing this tool.

Before execution, record #45473 acceptance, staff-copy apply/verify/recovery
results, serving permission-policy identity and supported rollback compatibility
in #45474. Arrange actual staff-scoped writer maintenance: stop API ingress,
scheduler/listener/worker delivery and other writers, drain running/queued work,
and freeze membership changes. `--writers-drained` records a truthful operator
attestation; it does not stop services. The database's additional zero-work and
source/schema/drift checks do not prove that ingress has stopped. Do not stop
other organizations merely to satisfy this staff-only operation.

First inspect metadata (no database connection or archive key is needed):

```sh
pnpm single-agent:production target \
  --org-id org_3ANttyrbWYJk6JKRSTRLEsbsDLe
```

Keep all input/output outside the checkout in an owner-private directory.
Generate one dedicated 32-byte key as 64 lowercase hexadecimal characters in a
new mode-0600 local file; pass its path with `--key-file`. Keep the same private
key through planning, review, execution and the recovery window. It is never
configured in GitHub. Preserve a secure owner-controlled recovery copy of the
key and encrypted plan; a lost key prevents decryption.

Use the reviewed fixed prefix map as a normal mode-0600 JSON file. Planning is
read-only and is also the default when the command name is omitted:

```sh
export DATABASE_URL_FILE=/private/production-ro-url
pnpm single-agent:production plan \
  --org-id org_3ANttyrbWYJk6JKRSTRLEsbsDLe \
  --agent-prefixes /private/agent-prefixes.json \
  --key-file /private/migration-image-key \
  --directory /private/new-staff-plan \
  --writers-drained
```

A complete map, zero blockers, live membership, full immutable source-archive
validation, quiescence and drift checks must pass. Planning only GETs object
bytes and uses read-only database sessions. The new mode-0700 output contains:

- `execution.enc`: AES-256-GCM authenticated recovery image, source inventory,
  reviewed plan and immutable archive bytes;
- `metadata.json`: scope, unique plan ID, producer commit, hashes and counts;
- `audit.json`: operation identity and redacted completion/error state.

Files use mode `0600` and are never overwritten or automatically uploaded.
Decrypted staging is private and removed on normal success/failure. A hard kill
can leave private staging on the authorized machine; preserve the original plan,
resolve the database outcome, then remove only that operation's private staging.

Open the encrypted plan locally to review the actual prefix map, changes,
association deletions, source/before/after rows and bundle manifests:

```sh
pnpm single-agent:package open \
  --input /private/new-staff-plan/execution.enc \
  --metadata /private/new-staff-plan/metadata.json \
  --key-file /private/migration-image-key \
  --output /private/new-staff-review
```

Record approval of the exact metadata plan/image hashes in #45474. Keep the
original successful plan directory durable before any external effect. Apply
requires both reviewed hashes, a new attempt directory, the same clean operator
commit, the local key and explicit mutation/drain flags:

```sh
export DATABASE_URL_FILE=/private/production-owner-url
pnpm single-agent:production apply \
  --org-id org_3ANttyrbWYJk6JKRSTRLEsbsDLe \
  --plan-directory /private/new-staff-plan \
  --expect-plan-sha256 <reviewed-plan-hash> \
  --expect-image-sha256 <reviewed-image-hash> \
  --key-file /private/migration-image-key \
  --directory /private/new-staff-apply-attempt \
  --writers-drained --migrate
```

After an interruption or uncertain result, do not infer failure from a missing
completion receipt. Run `verify` with the original plan/hashes/key, a fresh
output directory and the `RO` connection. It accepts neither mutation flag and
reports authoritative before/after state or rejects drift. There are no
automatic apply retries or rollback.

Run `recover` with the same original plan/hashes/key, a fresh output directory,
the owner connection and both `--writers-drained --migrate` flags. It only
accepts the exact after image, refuses later edits and preserves monotonic event
sequences and immutable shared objects. Keep writers stopped through verification
and the recovery decision. Use `metadata.binding.commit` in a clean checkout for
all operations on that plan, including after main advances; the operator never
checks out or deploys code for you. A source/schema change can require a fresh
plan or explicit recovery investigation rather than an automatic override.

Before resuming staff writers, verify persisted rows and source/target object
references. Then accept personal Instructions, Workflow permissions, Project/Chat
continuation and retained Automation delivery in production under #45474.
Persisted migration success alone is not runtime acceptance. Other organizations
need separate inventories, reviewed plans and rollout decisions. Restore the
previous shared compute configuration after the operation completes.

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

`test-production.ts` invokes the manual CLI with real files and MSW only at
external HTTP boundaries. It covers target inspection, default read-only mode,
explicit mutation admission, reviewed local plan identity, authenticated package
round trips, tamper/unexpected-entry rejection, private modes, connection identity
and paginated live membership drift. It does not dispatch a production operation
or establish staff runtime acceptance. The copy CLI rejects production-purpose
images before execution.

The real-PostgreSQL execution test also exercises production privilege admission
with a uniquely owned login role: SELECT-only access is accepted for planning,
an overprivileged reader is rejected, and insufficient write rights cannot admit
apply/recovery. The fixture database and role are removed together.
