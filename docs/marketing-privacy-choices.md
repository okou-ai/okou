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

## Retained database state

Migrations `1108`, `1109`, and `1110` have already shipped. Their SQL, snapshots,
journal entries, tables, trigger, and permanent consistency coverage are retained.
The Drizzle schema remains aligned with the deployed database and no new schema
migration is needed. Outgoing API instances can finish against the same schema
while the rollback deploys.

Existing privacy choices, revision evidence, and capture receipts are preserved
without new application writers. Account deletion still removes personal and
linked anonymous choices and cascades to their revisions and receipts.

## Authorized storage retirement (2026-09-15)

The owner explicitly requested complete retirement of `privacy_choices`,
`privacy_choice_revisions`, `marketing_privacy_receipts`, and
`marketing_privacy_withdrawal` under #33747. The contract migration will delete
their stored rows as well as the epoch function and schema declarations. This
supersedes E's earlier retention decision; it does not resume the withdrawn
runtime or complete the revised DCF-552 remediation in #33275. Historical shipped
migrations, snapshots and journals remain immutable replay records.

There is one remaining runtime dependency: `cleanupClerkDeletedUser` deletes
personal choices and linked browser choices during the `user.deleted` webhook.
Those deletes cascade to revisions and receipts. No current creation, consent
update, marketing delivery authorization, cron or backfill writer was found at
`main@bc9a254f8005d20b6514254c30c903649f7f1b00`; marketing senders and existing attribution metadata are outside
this three-table retirement.

The cleanup preparation preserves that deletion while storage exists and skips
it after contraction. Its transaction first takes a shared advisory lock on
`hashtext('marketing_privacy_storage_retirement')`, then checks relation presence
and deletes the matching subjects. Partial schema loss is rejected; only all
three tables present or all three absent are supported. The drop migration must take the exclusive
transaction lock with the same key **before** any table lock. A waiting cleanup
reads the final schema after the lock, using READ COMMITTED. Query failures and
cancellation remain errors; there is no blanket missing-table exception catch.

Release the preparation first. The destructive migration runs before API traffic
promotion, so merging cleanup and table drops into one first release would still
break the outgoing unconditional DELETE. Before merging/releasing contraction,
record the immutable serving preparation artifact, verify outgoing writers have
drained, and enforce a rollback floor that contains the prepared cleanup. A
healthy release tag or merged PR alone does not establish this gate. Keep this
temporary helper until the contraction PR removes it together with the tables.

The read-only MaskDB inventory did not expose these three tables on 2026-09-15;
their production row counts remain unknown. This is not zero-row evidence.
Deletion is authorized regardless of row count. This preparation performs no
production data deletion and makes no claim that storage contraction has run.
