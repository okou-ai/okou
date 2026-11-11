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
Plans use `single-agent-plan-v6`; inventories remain
`single-agent-inventory-v1`. Regenerate earlier plans from their inventory to
apply the approved naming, private-Agent-owner and publication policies. No
executable consumer of any plan version is implemented.

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
  using the current host visibility/owner rules and cached org membership.
  Record all per-member differences. For private-Agent Workflows, view/manage
  changes are accepted by the explicit private-Agent-owner policy: the Agent
  owner receives owner-only access and a different former Workflow owner loses
  access. Under `workflowPublicationPolicy: use-existing-target-permissions`,
  publication eligibility follows the target's existing owner/admin gate for
  the private Workflow owner. Record gains and losses as `acceptedChanges`,
  retaining their before/after rights; there is no migration-specific publish
  grant or grandfathered eligibility. Public-Agent view/manage differences
  remain `unresolvedChanges` and block. Converted Instructions also block
  changed maintenance rights. The public Workflow owner maintenance fix in
  #46438 must be deployed/verified before the planner adopts that policy;
  this version retains its maintenance blockers. No runtime permissions or
  actual Workflow visibility are changed by planning. The cache is preliminary
  evidence, not live membership authority.
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
