# Release 1 model policy command boundary

This is a scoped implementation record, not a declaration that the entire
Model Policy package or Release 1 is complete.

## Completed replacement publication

`model-policy.service.ts:commitOrgModelPolicyReplacement$` owns the complete
policy replacement commit. Its caller supplies the organization, user, policy
list, revision, and final `AbortSignal`. The command obtains `writeDb$`, opens
its transaction, executes the finite SQL directly, and awaits the commit. No
`Db` or transaction is passed to another function or command in this commit.
The validation and write-plan helpers consume ordinary snapshots and values.
SQL predicates and the retained lock statement are pure builders.

The publication preserves these existing business guarantees:

- An empty set is arbitrated through the existing unique default slot. Any
  stale or invalid replacement rolls back its preparatory default insertion.
- Provider, connection, and surface parents are locked before policy rows.
  Validation uses the parent values read under those locks; a deleted or
  foreign provider cannot become an authorized route through a later helper
  read.
- Ordered policy ownership is compared with a fresh complete set before
  validating the caller's revision. The bounded three-attempt identity check
  remains unchanged.
- Current entitlement and catalog restrictions, exactly one default, cloud
  mapping validity, member-only OAuth, and unchanged restricted routes retain
  their existing validation rules.
- Removing a model relocates member preferences and clears their service tier
  in the same commit as replacing the policies. The existing partial unique
  default constraint remains the default-slot authority.

There is no external I/O, new persistent field, or new coordination table in
this transaction. The shared entitlement status-to-runtime mapping is a pure
function, reused by the read path and replacement validation.

## Compatibility and unfinished ownership

The existing `model-policy:<orgId>` advisory key remains for outgoing seed and
replacement writers that do not acquire the complete current policy set. All
three Release 1 writer protocols already use the default-slot and parent/set
ownership rules. Removing that key requires evidence that incompatible APIs
are no longer serving, their in-flight work has drained, and retained rollback
targets use the prepared protocol.

That compatibility requirement does **not** cover the remaining structural
work. Lazy `ensureOrgModelPolicyFacts` still opens a helper-owned transaction
and forwards handles. Onboarding completion still forwards its transaction
into policy initialization; its policy and onboarding metadata changes must
stay atomic when ownership is moved into a business-input command. Read and
response projection helpers also still receive database handles. These are
implementation gaps, not changes that deployment or elapsed time completes.

## Verification

The replacement preserves the existing API tests for concurrent initialization
and complete replacement, mandatory/current revisions, preserving another
administrator's configuration, provider and custom-surface validation, plan
restrictions, and relocating member preferences. The four retired tests that
controlled internal row locks or compared artificially unrepaired database
snapshots are not restored.

Focused formatting, plain Oxlint, and ESLint pass for this change. Combined
HEAD type checks and behavioral tests are owned by the main PR pipeline; no
local Vitest suite or development server was run for this change.
