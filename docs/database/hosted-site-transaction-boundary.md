# Hosted-site publication and deletion transaction boundary

Local investigation for #37511, based on main
`b2d4bb32f4c1c3915edb2608998711c4b3a68bb1`. This is preparation, not a
completed transaction retirement. The retained remote work and handle forwarding
below remain unresolved under the accepted constraints. They predate #38038.

The subsequent [existing-status reader candidate](./hosted-site-status-reader-candidate.md)
implements an inactive canonical API/Worker ownership check and records a
compatibility matrix and exact visibility/admission and old-deleter boundaries.
Its production gates are not assumed; the separate failed SQL prototype is not
part of this preparation.

## Ownership preparation

The deletion precheck now owns `get(db$)` in
`ownedHostedSiteForDeletion$`. The locked ownership recheck is SQL directly inside
`deleteHostedSite$`'s transaction. Both checks retain the public slug,
organization, creator, and live-site predicates. Historical share lookup in
`revokeHostedSiteShare$` also owns `get(db$)`; revocation still runs before the
site deletion transaction and retains the existing share command.

No schema, pointer, delivery record, policy, public request, or response changes
are part of this preparation. No transaction, lock, compatibility reader,
recovery path, or remote operation has been removed or moved. No new lock,
retry, table, field, or JSON coordination state has been added.

## Decision owners and consumers

| Path                                        | Existing decision and recovery                                                                                                                                                                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepareHostedSiteDeployment$` / allocation | Reuse the creator's site and allocate its next manifest version under the site row lock. A site deletion retains the site identity and reserved name.                                                                                                                 |
| `completeHostedSiteDeployment$`             | Resolve the owned deployment and chat scope, validate uploaded files, publish its manifest, and then publish pointers. Only uploading/ready deployments may complete.                                                                                                 |
| `publishHostedSiteDeploymentPointers$`      | Publish the deployment's immutable pointer and delivery alias **before** binding the rolling site alias.                                                                                                                                                              |
| `bindHostedSiteDeployment$`                 | Lock the site, recheck deployment deletion and site ownership/layout, preserve version ordering, publish the rolling pointer, and atomically update deployment readiness/site binding.                                                                                |
| `publishHostedSitePointer$`                 | Validate alias ownership; conditionally write the rolling pointer and registry. Validate and adopt an R2 pointer ahead of SQL after an interrupted completion.                                                                                                        |
| `preserveSnapshotToken$`                    | Validate the historical share, source deployment, policy and token alias under the caller's site/share locks. Remove only the named slug from the policy using its ETag. Retain the token and its revocation state.                                                   |
| `deleteHostedSite$`                         | Revoke a historical private share first. Under the same site lock, remove public pointers and owned registry records, mark uploading/ready public/private deployments deleted, and clear the active binding. A failed remote deletion leaves SQL unchanged for retry. |
| Host Worker `serveLegacyHostedSite`         | Resolve the R2 registry/pointer/manifest and serve stored public content. It does not consult SQL deployment status. Its retained unregistered-pointer reader is also relevant until its separate retirement gate.                                                    |

Source owners:
[Host service](../../turbo/apps/api/src/signals/services/host.service.ts),
[pointer publication](../../turbo/apps/api/src/signals/services/hosted-site-publication-migration.service.ts),
[storage gateway](../../turbo/apps/api/src/signals/external/s3.ts), and
[Host Worker](../../turbo/apps/host-worker/src/index.ts).

## Why a SQL-only split is not demonstrated

### An absent pointer carries no deletion identity

Consider the first publication, whose rolling pointer is absent:

1. Completion validates uploading status and reads the absent pointer.
2. Its conditional PUT is delayed before reaching R2.
3. Deletion marks that deployment deleted and deletes its absent pointer and
   registry. The deletion acknowledges success.
4. The delayed `If-None-Match: *` PUT succeeds: the key is still absent.
5. A final SQL status check rejects completion, but cannot retract the public
   bytes atomically or undo a lost response/cancellation before cleanup.

The same absence is observable before first publication and after deletion.
The existing R2 conditional write has no predicate over SQL deployment status.
`deploymentVersion` orders pointers that exist; deletion discards that pointer.
An ETag read before deletion protects replacement of an existing pointer but
does not fence this absent-key case. Rechecking SQL immediately before PUT
leaves the same interval between the check and the remote write.

The current site lock serializes rolling-pointer publication with deletion.
Removing that serialization without a replacement observable at R2 or at every
serving reader introduces this execution. This is a protocol analysis, not a
claim that a SQL-only candidate has passed concurrent testing.

### A delayed delete can remove a new same-address publication

If deletion commits SQL before removing R2 objects, a new prepare can reuse the
same site and publish a higher version at the same rolling key. The old
deletion's later key-only batch removes the new pointer/registry. Reading the
key again before deleting is still a check followed by a separate remote effect.

The repository's `deleteHostedSitesS3Objects` uses `DeleteObjectsCommand` with
only `Key`, without ETag conditions. Cloudflare's
[S3 compatibility documentation](https://developers.cloudflare.com/r2/api/s3/api/)
documents conditional PUT but does not establish conditional DELETE support.
Its [Workers binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
exposes `delete(key)` without conditional options. No production conditional
DELETE experiment was authorized or performed. Even verified conditional
DELETE would not alone solve the absent-key publication case above.

### Existing immutable-pointer failure window

An immutable deployment pointer and its registry are already published outside
the binding transaction. A completion paused there can resume after deletion.
The binding transaction then rejects the deleted deployment and removes those
exact keys. The new delayed-completion case exercises successful cleanup and
checks that a newer same-address redeploy remains active.

That rejection/cleanup is not a durable fence. A storage write that succeeds
remotely but loses its response, or cancellation before binding, can prevent
the cleanup path from running. SQL `deleted` alone cannot stop the Worker from
serving a recreated pointer/registry. This existing window must be considered
alongside the rolling alias before claiming the accepted “deleted versions
never serve again” guarantee for interrupted requests.

A local acceptance probe reproduced the lost-response window through the
production APIs: prepare an upload, pause its immutable-pointer PUT, delete the
site successfully, resume the PUT, then let the registry PUT persist and reject
its response. Completion returned 500; the files API correctly returned 409;
the immutable pointer and delivery registry both remained in R2. The assertion
that the pointer stayed absent failed. The diagnostic source and output were
saved outside the repository; no passing test was substituted for this failed
acceptance condition. Cancellation itself was traced but not separately tested.

## Remaining prerequisites and transaction accounting

An equivalent retirement needs a deletion decision that late public writes and
every supported serving reader can observe at the actual publication/serving
boundary, using an accepted existing protocol. No such decision was found in
the current pointer/registry/manifest contract. A new tombstone, revision,
lease, coordination record, or assumed writer drain is not included as a
workaround.

| Transaction                | Before / after this preparation | Reason it remains                                                                                                                                                 |
| -------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site/deployment allocation | 1 / 1                           | Atomic site ownership and version admission; its separate injected DB/helper ownership remains outside this bounded preparation.                                  |
| Binding/publication        | 1 / 1                           | SQL site/deployment atomicity and existing site/share lock ordering. Remote pointer work, deleted-version cleanup, and forwarded Tx remain unresolved.            |
| Site deletion              | 1 / 1                           | SQL public/private deletion and binding reset are one business transition. Remote reads/deletes still serialize with rolling publication under the existing lock. |

The short SQL transactions themselves can remain after a valid publication
boundary is established. Retaining the current remote work is **not** accepted
terminal compliance. The unresolved forwarded handles include
`loadActiveHostedDeploymentVersion`, `publishHostedSitePointer$`,
`retainedPointer`, and `preserveSnapshotToken$`; completion lookup also still
forwards a DB handle. Hiding those handles inside a larger command while leaving
the external publication race would not resolve the prerequisite.

## Local behavior evidence and compatibility limits

[Host deletion tests](../../turbo/apps/api/src/signals/routes/__tests__/host-delete.bdd.test.ts)
construct deployments through authenticated prepare/complete/delete APIs and
observe files/history responses and R2 objects consumed by the Worker. Added
cases cover delayed completion after deletion followed by a new same-address
version, overlapping publication/deletion, and partial remote deletion followed
by a user retry. The storage fixture now honors conditional PUT with
content-derived ETags instead of accepting stale writes unconditionally.

The existing Host suite covers creator-only completion, chat-scoped ownership,
out-of-order completion, immutable version links, and completion retries.
Historical private-site conversion cannot be constructed with the current
public prepare API; its retained code and deployment prerequisites were traced,
not fabricated in a new API fixture.

Archived October 8 evidence at the original base: the seven suites consuming
the updated storage fixture produced 37 passing
cases and 45 failures locally. Running those same suites against unmodified
main produced 34 passing cases and the identical 45 failing case names: 44
Runner claim failures (`Job not found in queue`) and one device authorization
failure. The three added deletion cases passed. This is baseline comparison,
not a claim that the whole consumer suite passed or that the interrupted-request
acceptance probe passed. Refreshed checks are recorded separately in the
exact-HEAD review and handoff rather than substituted for this historical record.

This preparation writes exactly the previous persisted bytes and uses exactly
the previous transaction/lock ordering. Old/new APIs and Workers therefore
share its existing protocol; it introduces no additional rollback floor or
writer-drain requirement. The
[hosted publication compatibility contract](../deployment-compatibility.md#hosted-site-publication-identity)
still prohibits restoring the old HTML snapshot writer after named-alias
conversion. Its Worker/API rollout and historical backfill gates remain
independent requirements.

No evidence of production Host writer drain, conditional DELETE capability,
or a new serving-reader floor was collected. The earlier artifact-share gate
does not establish any of those Host-specific prerequisites. No deployment,
backfill, release, or issue closure is part of this preparation.
