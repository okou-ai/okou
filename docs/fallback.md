# Fallbacks to Avoid

A fallback is any extra code path that handles a state the current system is
not supposed to produce: a `??` chain on a field the contract makes required,
a branch for a retired protocol, a default that hides a corrupted row, or a
test that asserts deleted behavior is still deleted.

The default in this repository is **no fallback**. `docs/bad-smell.md` states
the fail-fast rule for configuration; this document extends it to protocols,
persisted state, feature rollout, and tests, and lists the narrow cases where
a fallback is required.

Every fallback costs the same three things: an extra code path that nobody
executes on purpose, an extra state that every future reader must reason
about, and a silent failure mode that turns a loud bug into wrong behavior.
A fallback is worth that cost only when a real, currently-reachable state
needs it.

## 1. Do Not Write Negative Tests Against Old Code

A negative test asserts that removed behavior stays removed: the retired route
still 404s, the legacy field is still ignored, the old parser still rejects the
old shape. These are tombstones. They do not protect a user-visible behavior;
they pin the absence of code that no longer exists.

```typescript
// ❌ Bad: tombstone tests for behavior that was deleted
it("returns 404 for retired BB0, API key, and public v1 routes", async () => {
  /* ... */
});
it("does not expose the legacy computer-use command approval route", async () => {
  /* ... */
});
it("does not read legacy vm0 preview bypass query params", () => {
  /* ... */
});
```

**Why they are harmful:**

- They never fail for a real reason. The route table and the type system
  already prove the code is gone; the test only re-states the deletion.
- They accumulate. Every cleanup adds another tombstone, and the suite grows
  in the one direction that produces no coverage.
- They block the next change. Reusing a path, a field name, or an error code
  now requires deleting a test that looks like a deliberate guard.
- They cost CI time on every run, forever.

**Delete the old test together with the old code.** When a behavior is
replaced, update the existing test to the new behavior instead of keeping the
old assertion alongside it. PR #22573 removed dozens of retired-behavior tests
in one pass, many of them tombstones; that class of test should never have been
written.

**The narrow exception** is a fail-closed security boundary, where the
assertion is that an attacker-supplied legacy credential, token prefix, or
signature format is rejected. There the negative outcome _is_ the product
behavior, and the test stays. "Old code is gone" is not a security boundary.

## 2. Features Behind a Feature Switch Need No Fallback

A feature that has not reached full rollout has no external users. While it is
gated by a `FeatureSwitchKey` that is off by default or staff-only, do not
write compatibility code for it:

- no dual-read or dual-write between the old and new shape,
- no tolerance branch for data written by the previous iteration of the
  feature,
- no client-side handling for an API response the deployed API no longer
  returns,
- no migration or backfill for rows only staff produced.

**A temporary 500 or a broken screen during the cutover is acceptable.** The
blast radius is the staff org that opted in, and the recovery is a refresh or
a redeploy. Paying for a fallback here buys nothing and slows every subsequent
iteration, because each iteration then has to carry, test, and later remove
that fallback.

```typescript
// ❌ Bad: compatibility branch for a pre-GA feature's own earlier shape
const layout = parseLayout(row.layout) ?? parseLegacyStaffLayout(row.layout);

// ✅ Good: one shape, fail loudly if a stale staff row shows up
const layout = parseLayout(row.layout);
```

**Where this stops applying:** once the switch is `enabled: true` for everyone,
the feature is GA and the normal rules in `docs/deployment-compatibility.md`
apply in full. The boundary is the rollout state of the switch, not the age of
the code.

Removing the switch itself is a separate cleanup: when a switch is terminal,
delete the switch, the disabled branch, and the tests for the disabled branch
together.

## 3. Do Not Fall Back On States the Contract Cannot Produce

Most fallback slop is a `??` or `||` chain guarding a value that the owning
contract already guarantees. The chain does not add safety; it invents an
identity that no caller ever asked for.

```typescript
// ❌ Bad: `name` is required by the SDK type; the chain silently changes the
// cached identity to an unrelated field
const displayName = org.name ?? org.slug ?? org.id;

// ✅ Good: use the field the contract guarantees
const displayName = org.name;
```

The same rule covers:

- `?? 0` on a metric that is initialized and updated as a required number,
- a final `?? null` on a value derived from a `NOT NULL` column,
- a fabricated React key for a state the component never constructs,
- `as unknown as` bridges that reconnect types the fallback broke.

Before deleting one, confirm the state is genuinely unreachable under the
owning contract — the SDK type, the Zod schema, the DB nullability, or the
single writer that produces the row. Record that evidence in the PR.

## 4. Do Not Fabricate Data For Corrupted Persisted State

When a required column is null but the only writer always sets it, the row is
corrupted. Deriving a plausible value from an ID or a filename hides an
impossible database state and produces a wrong answer instead of an alert.

```typescript
// ❌ Bad: rebuild metadata from the asset ID when the row is incomplete
const contentType = row.contentType ?? guessMimeFromUuid(row.id);
const status = row.status ?? "failed";

// ✅ Good: throw a precise invariant error
if (!row.contentType) {
  throw new Error(`slack-input asset ${row.id} is missing contentType`);
}
```

Genuinely optional columns keep their documented default. The test is whether
the writer can legitimately leave the field unset, not whether the type happens
to be nullable.

## 5. Do Not Keep Fallbacks For Retired Protocols and Layouts

Once a producer is gone, its reader is dead weight. Delete the reader in the
same PR that retires the producer, or in an explicit follow-up PR that names
the rollout gate it waited for.

This includes retired runner event shapes, superseded API routes, old storage
prefixes, previous OAuth callback metadata, obsolete IndexedDB cache versions,
and unordered heartbeat senders that no live runner can still emit. When old
rows in the retired shape still exist, delete or migrate them rather than
teaching the reader to accept both.

## 6. Fallbacks That Are Required

Keep a fallback only when it belongs to one of these:

1. **Bounded cross-version rollout compatibility.** Frontend, backend, and
   runner deploy independently, so a briefly-mixed fleet is a real reachable
   state. See `docs/deployment-compatibility.md`. This fallback must have a
   verifiable removal gate (see sections 7 and 8).
2. **Genuinely optional external data.** Third-party API fields that the
   provider documents as optional, or that runtime inspection proves absent
   despite the TypeScript declaration.
3. **Genuinely nullable persisted columns**, where a legitimate writer leaves
   the field unset.
4. **Presentational defaults** with no identity meaning — placeholder artwork
   for an unavailable preview, an empty-state label.

Everything else is slop.

## 7. Rollout Removal Gates

A rollout fallback is justified only while the incompatible state it protects
is reachable. Use the removal gate for the owning surface.

| Surface                   | Removal gate                                                                     |
| ------------------------- | -------------------------------------------------------------------------------- |
| DB vs API                 | Release and schema state; see `docs/deployment-compatibility.md`.                |
| Existing runner / sandbox | Old instances finish draining.                                                   |
| Old web/app -> API        | The replacement app is live and the client-version floor excludes the old build. |
| New web/app -> old API    | The old API is no longer serving or retained as a rollback target.               |

How to use them:

- **DB vs API.** The normal production release migrates the production database
  before promoting the corresponding API artifact. A successful release closes
  the new-code-before-migration gate; a failed, cancelled, or incomplete run
  does not.

  This surface also has **two independent directions**, and a fallback that
  covers one does not cover the other:
  - **Old code after migration** — the schema has changed while the previous
    API is still serving or draining. Every statement that API can issue must
    stay legal, including columns an ORM adds to `SELECT` or `RETURNING`.
  - **New code before migration** — the new API is serving before the migration
    is visible to it. This is the direction that produced `42703`, `22P02`, and
    `42P01` in production. New readers and writers must not require the new
    column, enum value, relation, or constraint until the migration lands.

  Remove a fallback only after its direction is safe. New-code fallbacks require
  a successful release and the expected schema. Old-code fallbacks require the
  outgoing API to finish draining and retained rollback targets to remain
  compatible without the fallback; rollback does not restore the database
  schema.

- **Old runner or sandbox.** The backend must accept the old runner protocol
  until old instances finish draining. A claimed run has a two-hour guest
  runtime budget plus bounded finalization. Remove runner-facing endpoints,
  payload variants, and event shapes only after the drain completes.
- **Old web or app clients.** Keep their API contract until the replacement app
  is live and the client-version floor excludes the old build. An open page
  discovers the floor on its next handled API request and receives `426 Upgrade
Required`; an idle page makes no request that needs compatibility.
- **Old API targets.** A new app may need a fallback while an older API remains
  reachable. Remove it after that API is no longer serving or retained for
  rollback.

State the surface and removal gate in the code comment and PR summary. If a
fallback protects more than one surface, every gate must pass before removal.

These gates apply only to GA behavior. A feature still behind a non-GA feature
switch has no old external client to protect, so none of these gates create an
obligation (see section 2).

## 8. Writing a Bounded Rollout Fallback

A legitimate rollout fallback is introduced with its removal already planned.

**Step 1 — ship the tolerant version with a comment stating the removal
condition.** PR #25563 added an additive route and let the app accept the old
API's `404`:

```typescript
const result = await accept(client.unreadIds(), [200, 404]);
// A newly promoted app can briefly reach an API version from before this
// additive route existed. Remove after that API is outside the production
// rollback window.
return new Set(result.status === 200 ? result.body.threadIds : []);
```

**Step 2 — after the rollback window closes, remove the fallback, the contract
entry, and its test.** PR #25694 did exactly that:

```typescript
const result = await accept(client.unreadIds(), [200]);
return new Set(result.body.threadIds);
```

The follow-up PR removed the `404` from the contract, narrowed the BDD helper's
status type, and deleted the test that exercised the missing route. Note that
the deleted test is not a regression loss: it covered the temporary fallback,
so it dies with the fallback rather than becoming a tombstone.

Requirements for this pattern:

- a comment naming the surface, its gate from section 7, and the condition
  that makes the branch removable,
- an entry in the PR summary (see section 9),
- a follow-up issue or PR that removes it,
- the removal deletes the tolerant branch, the contract entry, the helper
  types, and the fallback's tests together.

An "old shape tolerated forever" branch with no removal condition is not a
rollout fallback; it is section 5 slop.

## 9. Declare New Fallbacks in the PR Summary and the Review

A fallback that nobody records is a fallback that nobody removes. Declaring it
is mandatory on both sides of the review when a PR introduces it.

**Every fallback introduced by a PR belongs in the PR summary. A fallback or
compatibility behavior added by the diff but missing from the summary is a P1
finding and blocks the review verdict**: the review is `Changes Requested`
until the author adds the missing entry. This holds even when the fallback
itself is correct — the defect is the undeclared behavior, not the branch.

**Author — in the PR summary.** When a PR introduces one or more fallbacks, the
summary must contain a `Fallbacks` section listing each new one. Do not bury it
in the diff. For each fallback give:

- the file and symbol,
- what old/new interaction it protects,
- the surface and its gate from section 7 (or `none — non-GA feature
switch`),
- the removal condition and the follow-up issue or PR.

```md
## Fallbacks

- `sidebar-unread-threads.ts:allUnreadThreadIds$` — accepts `404` from an API
  that predates the additive `unreadIds` route. Surface: new app -> old API.
  Remove after that API is outside the rollback window; follow-up #25694.
```

PRs that do not introduce a fallback need no `Fallbacks` section. This includes
PRs that only keep or remove existing fallbacks; do not require
`Fallbacks: none` or a removal declaration.

**Reviewer — in the review comment.** The review must list every fallback the
diff introduces, in the same shape, and state whether each one is justified
under section 6, correctly bounded under section 7, and declared in the PR
summary. Raise each undeclared one as a P1 finding asking the author to record
it in the summary, and request changes until it is recorded. A review that says
nothing about fallbacks in a PR that adds one is not a completed review.

## 10. Evidence Required When Removing a Fallback

Removing a fallback is a behavior change until proven otherwise. A cleanup PR
must show why the removed branch is unreachable:

- **Type or schema evidence** — the field is required by the SDK type, the Zod
  schema, or a `NOT NULL` column.
- **Single-writer evidence** — the only code path that creates the row always
  sets the field.
- **Production evidence** — a read-only query against the masked production
  branch showing zero rows in the old shape. PR #24888 removed an unreachable
  claim-time fallback only after confirming `pending_automation = 0`.
- **Rollout evidence** — the applicable gate in section 7 has passed.

The evidence can come from the diff, tests, or linked production or rollout
data. Removing a fallback does not require a `Fallbacks` section or a separate
fallback declaration in the PR summary. Keep the invariant throw so monitoring
surfaces a violation if the assumption ever breaks.

## Review Checklist

- Does the PR add a fallback for a state the contract, schema, or single
  writer already prevents? Request removal.
- Is the feature still behind a non-GA feature switch? Then no compatibility
  code, no migration, no dual-read is required, and a transient error during
  cutover is acceptable.
- Does the PR add a test that asserts removed behavior stays removed? Request
  removal unless it is a fail-closed security boundary.
- Does a new rollout fallback name its surface, its gate from section 7, a
  removal condition, and a follow-up?
- Is it the right gate? Check release and schema state, runner drain, client
  floor, or retained API targets as applicable.
- If the PR adds a fallback, does its summary contain a `Fallbacks` section
  listing every new fallback? Every introduced fallback that the summary omits
  is a P1 finding and blocks the verdict: ask the author to record it there and
  request changes. PRs that add none need neither the section nor
  `Fallbacks: none`.
- Does the review comment list every fallback the diff introduces, with a
  justified/not-justified verdict for each?
- Does a removal PR carry type, single-writer, production, or rollout evidence?
- Does the removal delete the branch, the contract entry, and the branch's own
  tests together?
