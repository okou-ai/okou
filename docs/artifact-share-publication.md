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

The prepared writer retains the existing row lock and transaction. A successful
private update always advances the R2 ETag for files, including an unpublished
file. A later explicit share reuses that snapshot and durable identity. Status
now exposes the revoked identity and selected target after an initial stop;
the audience is private and both recipient URLs remain null. HTML publication
through this service is already disabled, so stopping an absent HTML grant
continues to leave it absent.

This is a preparation release, not completion of transaction reduction. The
one retained transaction belongs to `updateArtifactShare$` and serializes the
policy read, preparation and conditional publication with outgoing writers.
It still contains external I/O. No transaction is removed, moved or combined
in this preparation.

## Lock removal gate

Before removing that transaction, deploy the prepared writer and verify that
every serving, in-flight and supported rollback API writes an initial file
revocation. A merge to main alone does not close this gate. An outgoing writer
that acknowledges a missing-policy revocation without writing an ETag cannot
be safely overlapped with a lock-free first publication.

After this gate, writers can read a policy and ETag, prepare immutable snapshots
and aliases outside SQL, and publish exactly once with the existing R2
`IfMatch` or `IfNoneMatch`. Every policy includes a fresh revision, preventing
an old validator from becoming current again after audience changes. A stale
publication fails without retrying or acknowledging its proposed audience.

Copies remain in the owning file's private `shares/` prefix. An unsuccessful
publication may leave an unused snapshot or immutable alias, as it already can
today. Those objects confer no access: delivery checks the current policy,
audience and token. Keep the owning identity committed; this change introduces
no automatic snapshot or alias reclamation. Do not delete a reused alias or snapshot after an uncertain
publication response. Revocation invalidates existing aliases through the
policy, while historical share-link readers retain their current compatibility
checks. This work does not deploy or publish a production release.
