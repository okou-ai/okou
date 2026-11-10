# Single Agent migration preparation

Read-only inventory and offline dry-run planning for #45474, under Epic #45400.
These commands do not implement `apply` or recovery. Every generated plan has
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

`inventory` reads the named org using one SQL statement, giving all selected
tables a consistent statement snapshot. Postgres enforces read-only execution
through `default_transaction_read_only=on`; the resulting snapshot must attest
`transaction_read_only=on`. It selects no other org's rows. No S3 publication,
connector, runtime execution or feature-switch change occurs. The environment
label is supplied by the operator; it does not verify branch lineage or serving
deployment identity. The database name is recorded separately.

`plan` strictly validates the versioned inventory schema and unique identities,
checks the requested org against the snapshot, and binds its output to the exact
input bytes with SHA-256. It uses no database. Repeating the command against the
same inventory produces identical plan bytes. Treat an inventory as trusted
operator input; its hash detects different input, not forgery or stale state.

Exit codes:

| Code | Meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| `0`  | Inventory saved, or plan saved with no detected blockers; still non-executable.       |
| `1`  | Invalid arguments/input/scope, missing org/default Agent, database or output failure. |
| `2`  | Plan saved with detected blockers that need resolution.                               |

## Planned rules

- Resolve the target exclusively from this org's `default_agent_id`; require a
  public target. No name-based target lookup or all-org mode exists.
- For each other Agent, plan `<agentName>--instruction`; for its existing
  Workflows, plan `<agentName>--wf-<workflowName>`. Canonical Agent names are
  lowercased. Validate with the product's Workflow name contract (64 characters).
  Preserve same-source public/private overrides under one name. Block other
  collisions, existing default-Agent names and overlong names; never truncate,
  overwrite or invent a suffix.
- Keep existing Workflow and Automation IDs. Workflow plans retain owner,
  visibility, source revision and immutable bundle reference, and require
  republishing the renamed generated `SKILL.md`. All Automations, including
  disabled ones, retain their state; row fingerprints pin their full database
  configuration without exporting trigger contents. Automation execution Chat
  bindings are inventoried separately, with owner/scope checks.
- Compare Workflow view/manage/publish rights before and after the host change
  using the current host visibility/owner rules and cached org membership.
  Report per-member differences as blockers, including visibility expansion on
  private hosts and lost publish/maintenance rights. Converted Instructions also
  block changed maintenance rights. The cache is preliminary evidence, not live
  membership authority.
- Initialize members with no personal Instructions row once from the public
  default Agent's snapshotted Instructions. Preserve every saved row, including
  deliberately empty content. Earlier automatically seeded rows also remain
  preserved pending provenance review; text equality and timestamps do not prove
  that a user did not save a value.
- Group old Chats into new private Projects per `(org, Chat owner, source Agent)`.
  Prefer the Agent's trimmed display name, using its canonical name when no
  nonempty display name exists; validate the product's 120-character limit.
  Preserve Chat IDs and original Project membership in the plan. Existing
  same-name Projects are listed and block automatic adoption; incoming Project
  name collisions also block. Existing Projects are never deleted or merged.
- Future execution must use the owner's personal Instructions. Converted
  Instruction Workflows have `automaticallyInvoke: false`; they are not an
  automatic continuation hook.

## Deliberate boundaries before apply

This first stage does not establish that the org can be migrated. The plan always
lists the remaining gates:

- Verify live membership, per-member modes and earlier seed provenance.
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
- Implement a versioned, drift-checked `apply` and recovery protocol, then finish
  integrated acceptance #45473 before the staff cutover rehearsal.

Use the same reviewed tool revision for an isolated production-child-branch
rehearsal and subsequent review. A staff production cutover needs a fresh plan,
followed by persisted-data and runtime acceptance. Other orgs need separate fresh
inventories/plans. Legacy Agent deletion belongs to #45476.

## Verification

```sh
DATABASE_URL=<local-disposable-database-admin-url> pnpm test:single-agent-migration
```

The test creates and deletes its own uniquely named database, applies the actual
repository schema, and runs the CLI as a subprocess. It checks tenant isolation,
Postgres read-only attestation, no source-row changes, private report creation,
offline deterministic planning, preserved empty personal content, owner-separated
Projects and prior membership, enabled/disabled Automations and execution Chat
bindings, permission blockers, name/length conflicts, strict scope validation and
overwrite refusal. The migration CI job runs this same test. This is tool
verification, not staff production rehearsal or runtime acceptance.
