# Marketing privacy implementation rollback (DCF-552)

The runtime implementation from [#33283](https://github.com/vm0-ai/vm0/pull/33283)
and [#33436](https://github.com/vm0-ai/vm0/pull/33436) is withdrawn while the
technical approach for [#33275](https://github.com/vm0-ai/vm0/issues/33275) is
reconsidered. This does not complete the privacy remediation.

## Application behavior

- The anonymous/personal privacy-choice endpoints, marketing delivery
  authorization endpoint, and `PrivacyChoices` feature switch are removed.
- Signup attribution no longer records GPC in the withdrawn privacy store or
  issues capture receipts. The signup contract and attribution/Impact checkout
  paths return to their behavior before these two PRs.
- New marketing and Impact privacy receipt/person metadata is no longer
  propagated to checkout or future subscription snapshots. Existing metadata
  is not erased by this rollback.
- Existing browser consent behavior, Termly configuration, Google/Impact
  tracking, and marketing senders are outside this rollback.

The companion [marketing PR #680](https://github.com/vm0-ai/vm0-marketing/pull/680)
requires the withdrawn authorization API. Its current guards must not be
deployed against this rollback: they would suppress optional delivery when the
API is unavailable. A revised implementation needs a new coordinated rollout.

## Storage retirement: migration 1139

On 2026-09-15 the owner explicitly requested complete retirement of
`privacy_choices`, `privacy_choice_revisions`, `marketing_privacy_receipts`, and
`marketing_privacy_withdrawal`. This supersedes #33747 E's earlier retention
plan. The withdrawn store is retired rather than replaced with a new consent
API; the revised DCF-552 work remains in #33275.

Migration `1139_retire_marketing_privacy_storage` removes:

- personal/browser choice rows, including user associations, token hashes,
  purpose decisions, policy/revision identifiers and purpose epochs;
- immutable revision evidence for those choices;
- marketing capture receipts referencing those revisions and epochs;
- the withdrawal trigger, its `invalidate_marketing_privacy_epochs()` function,
  and the three tables' own indexes, checks and foreign keys.

Deleting the row contents is intentional and authorized, whether the tables are
empty or populated. The current API/schema declarations and account-cleanup
helper are removed as well. No compatibility view or replacement trigger is
installed. Migrations `1108`–`1110`, their snapshots and journal entries remain
immutable historical replay records.

The source audit, repeated against prepared release source
`8b9763e341ea8519c1aad5e62ad72dfa5c582eb8`, found one
remaining runtime dependency: the `user.deleted` cleanup deleted personal and
linked browser choices, cascading to revisions and receipts. No current
creation, consent update, delivery authorization, cron or backfill writer was
found. Existing browser consent, marketing senders and attribution/Stripe
metadata are outside this three-table retirement.

## Required release order and rollback boundary

**The preparation must be serving before contraction can merge.**
[Preparation #34296](https://github.com/vm0-ai/vm0/pull/34296), reviewed source
`95339650899c7bf8d50b8d8c18dc7e36a4a015c4`, makes account cleanup work with all
three tables present or all three absent. Its canonical main introduction is
`e98391290d01e88ece8bf1acfcfc258b3f1e3c13`. Record the immutable serving,
old-invocation drain and prepared rollback receipts on
[contraction #34305](https://github.com/vm0-ai/vm0/pull/34305) before marking it
ready; merge ancestry by itself is not a serving receipt.

1. Merge and release #34296 separately. Record its immutable serving API
   artifact/version and verify the old unconditional-cleanup API has drained,
   including webhook work owned by those instances. No remaining independent
   background writer was identified in the source audit; verify this against
   the release inventory before contraction.
2. Before merging/releasing contraction, record the prepared production
   artifact and resolve its canonical main introduction commit. The rollback
   resolver requires targets to contain the first addition of
   `marketing-privacy-cleanup.service.ts` on main's first-parent history. This
   uses the actual merged introduction, including after the helper is deleted,
   instead of an unmerged PR SHA that squash merging would invalidate.
   Missing/shallow history and pre-preparation targets fail before artifact
   lookup. Existing release-tag, READY artifact and earlier compatibility checks
   still apply.
3. Run the normal release's smoke-clone migration and then production migration
   before promoting the contraction API. Record the production migration's
   committed journal entry and `Migrations complete`, separately from smoke
   success. Merging a PR does not establish deployed schema state.

The preparation acquires a shared transaction advisory lock on
`hashtext('marketing_privacy_storage_retirement')` before its relation checks
and deletion. Migration 1139 acquires the exclusive form **before** locking
`privacy_choices` → `privacy_choice_revisions` → `marketing_privacy_receipts`.
It drops the trigger, then child tables before parents, then the function.
A waiting prepared cleanup reads the committed schema under READ COMMITTED;
a failed migration leaves it able to delete retained evidence normally.

The unchanged runner uses a `1s` lock timeout and `10s` statement timeout. All
DDL and the journal insertion are one transaction. Unexpected external foreign
keys, views or function dependencies abort through restrictive drops; lock,
statement and journal failures roll everything back. There is no CASCADE drop,
production repair or unbounded wait.

After contraction, API rollback does not restore these tables or their data.
Only verified prepared artifacts and later compatible releases qualify. An
older API requires a separately reviewed recovery plan, not just an artifact
promotion. The temporary cleanup helper and its focused tests disappear from
current code with the tables; the new migration transition validator remains
until the production journal and completed compatibility cycle allow retirement.

## Evidence and limits

The preparation passed six real PostgreSQL cases in private UTC schemas,
including partial-schema rejection, historical personal/linked cascade cleanup,
retirement commit/rollback races and genuine foreign-key failure rollback. The
same two actual `user.deleted` webhook cases passed with retained and absent
storage in separate databases. These are test-owned data, not production rows.

Contraction passed eight real PostgreSQL migration scenarios, the complete
database migration-consistency chain, four actual account-deletion/lifecycle
webhook cases and the signed Clerk erasure-compatibility route against the
database migrated through 1139. Prepared release source
`8b9763e341ea8519c1aad5e62ad72dfa5c582eb8` also passed those five route cases
against that contracted database and all six private-schema compatibility cases.
This includes main's newer Pi erasure ingress and replay guards. Generated metadata
removes exactly the three tables; other schema objects are unchanged. Rollback
resolver tests cover old targets, missing history and the canonical introduction
after the preparation helper is deleted. API/database types, scoped lints and
Knip passed. Full Vitest coverage belongs to PR CI.

The read-only MaskDB inventory did not expose the three tables on 2026-09-15.
Production row counts therefore remain unknown; missing gateway visibility is
not zero-row evidence. No production DDL or data deletion has been performed by
this implementation task. Complete #33747 only after recording the actual
contraction release evidence; #33275's privacy remediation remains separate.
