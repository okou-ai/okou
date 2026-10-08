# Artifact share publication

The database `artifact_shares` row is a durable owner/index identity. The R2
policy is the sole mutable authority for audience, selected snapshot and public
token. Identity allocation commits before external publication; an absent or
revoked policy grants no recipient access. The existing policy schema and
delivery readers remain unchanged.

## Writer preparation

Stopping an unpublished file now writes a revoked policy with an immutable file
snapshot. Previously, a private update with no policy returned success without
writing anything. That empty-state behavior cannot fence a concurrent first
publication once writers stop sharing the database row lock.

The preparation writer in [#38015](https://github.com/okou-ai/okou/pull/38015)
retains the existing row lock and transaction. A successful private update
always advances the R2 ETag for files, including an unpublished
file. A later explicit share reuses that snapshot and durable identity. Status
now exposes the revoked identity and selected target after an initial stop;
the audience is private and both recipient URLs remain null. HTML publication
through this service is already disabled, so stopping an absent HTML grant
continues to leave it absent.

That is a preparation release, not completion of transaction reduction. The
one retained transaction belongs to `updateArtifactShare$` and serializes the
policy read, preparation and conditional publication with outgoing writers.
It still contains external I/O. No transaction is removed, moved or combined
in that preparation.

## Lock removal gate

Before removing that transaction, deploy the prepared writer and verify that
every serving, in-flight and supported rollback API writes an initial file
revocation. A merge to main alone does not close this gate. An outgoing writer
that acknowledges a missing-policy revocation without writing an ETag cannot
be safely overlapped with a lock-free first publication.

Read-only verification on 2026-10-08 established that boundary for the canonical
Vercel API and repository-supported rollback:

- Both [canonical](https://api.okou.ai/api/build-info) and
  [legacy](https://api.vm0.ai/api/build-info) API aliases returned version 1.714.1
  at `c069adbf01450fffc71d9e011025924792524d57`, a descendant of preparation
  commit `61b91126a88149de8aaa3dd196e1d4af092a91c1`. The
  [API promotion](https://github.com/okou-ai/okou/actions/runs/37767112573/job/113281739918)
  completed at 11:15:44 UTC; its dedicated production URL returned the same
  revision.
- A complete six-hour production API trace summary through 12:41:53 UTC found
  the outgoing pre-preparation revision last active at 07:58:29.571 UTC, followed
  only by the preparation and current revisions. Both outgoing and current
  Vercel function configurations set `maxDuration: 300`;
  [Vercel terminates](https://vercel.com/docs/functions/configuring-functions/duration)
  an invocation after that bound, including time spent waiting. This bounds old
  in-flight work through 08:03:30 UTC. A fresh complete 15-minute summary at
  13:16 UTC contained only the current revision. This inference combines serving
  revisions, trace continuity and the invocation bound; absence of old logs
  alone does not establish drain.
- The current rollback resolver rejects targets before the main commit adding
  migration 1345, `5080d026e68f10f41285570f52a9b655fb562052`, which descends from
  the preparation. The rollback workflow always loads that resolver from current
  main; no earlier resolved rollback was still active during verification.

These observations close the previously unmet gate without deploying this
change. Recheck the serving and supported rollback boundary before a later
production promotion if either changes. Restoring a pre-preparation writer
alongside this publisher remains unsupported.

## Transaction-free publisher

The follow-up removes the one `updateArtifactShare$` transaction rather than
moving it. Its identity insert still commits first with the existing unique
target key. The private `publishArtifactShare$` command reads that identity
through `shareIdentity` and checks its owner and original organization before
reading the current policy. No database handles or accessors cross command or
factory parameters. No transactions are retained or combined in this slice.

After the deployment gate, writers read a policy and ETag, prepare immutable
snapshots and aliases outside SQL, and publish exactly once with the existing R2
`IfMatch` or `IfNoneMatch`. Every policy includes a fresh revision, preventing
an old validator from becoming current again after audience changes. A stale
publication fails without retrying or acknowledging its proposed audience;
the existing error boundary reports failure. Simultaneous requests can now
conflict instead of waiting for one another. Every acknowledged change is
authoritative, and a request that observed an older ETag cannot restore its
scope after a newer acknowledged change. The preparation writer uses those
same conditionals, so it can overlap with the transaction-free publisher once
older no-op initial-revocation writers have drained.

File ownership, storage bucket and source key are captured by the stable
`ownedShareTarget$` read command from one `privateArtifactRecord$` read.
Snapshot preparation receives those plain facts; it does not repeat
the query or forward a database handle. Delivery still reads current ownership
and membership before issuing credentials. Alias preparation and snapshot
copying finish before the single conditional policy write; an abort skips
remaining publication work.

Copies remain in the owning file's private `shares/` prefix. An unsuccessful
publication may leave an unused snapshot or immutable alias, as it already can
today. Those objects confer no access: delivery checks the current policy,
audience and token. Keep the owning identity committed; this change introduces
no automatic snapshot or alias reclamation. Do not delete a reused alias or
snapshot after an uncertain publication response. Revocation invalidates
existing aliases through the policy, while historical share-link readers retain
their current compatibility checks. This work does not deploy or publish a
production release.
