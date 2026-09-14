# Shared-thread artifact snapshots

With the existing `privateArtifacts` switch enabled for the sharing user and
organization, sharing selected chat messages copies their referenced private
artifacts into an independent resource snapshot. The original messages and
artifact sharing policies are unchanged. The switch remains false by default.

Only the selected messages and their managed static dependencies are included.
User-uploaded input attachments retain the existing filename-only projection.
Existing public links and external resources retain their current URLs; this
feature does not backfill historical data or crawl external websites.

## Snapshot and delivery

- Files are copied within the private artifact bucket to
  `private-artifacts/<sourceId>/thread-shares/<sharedThreadId>/<token>/<filename>`.
  The copied messages reference `https://a.okou.io/<token>.<extension>`.
- Hosted sites pin one ready private deployment, including its full manifest and
  bundle, under `shared-artifacts/<brand>/<sharedThreadId>/<deploymentId>` in the
  existing hosted-sites bucket. The copied messages reference
  `https://<token>.okou.app/`. Other environments use their configured domains.
- Static managed references in HTML, CSS, JavaScript and JSON are rewritten to
  the same snapshot URLs, including owned private R2 signatures and isolated
  private-site preview URLs. Ownership is checked against the source record;
  possessing an old signature is never publication authority. Relative assets
  stay relative. This does not freeze dynamically constructed URLs or backend
  requests. Unresolvable recognized private dependencies fail the share.
- Repeated references reuse one resource within this share. Later changes to the
  source deployment or file do not update the copied bytes. The planner bounds
  each share to 100 managed resources and 32 MiB of rewritten text, with a 4 MiB
  limit per text asset; existing hosted-bundle limits also apply.

The authoritative R2 policy is
`shared-thread-artifacts/<brand>/<sharedThreadId>.json`. It contains the owner,
original organization, resource targets and `preparing`, `active` or `revoked`
state. The database records the same ownership identity on `shared_threads`.
Aliases use the new `thread-resource` delivery-record kind. The Worker reads the
parent policy before every file, Range, HEAD or site-subresource request,
including content-cache hits. It uses the existing immutable content cache and
returns private/no-store responses. No request-time API or database call is
added to Worker delivery, and image-transform requests cannot bypass revocation.

## Publication and removal

Publication creates a preparing policy and durable database identity, then locks
that identity, rechecks current Clerk membership, copies the complete snapshot,
registers aliases and conditionally activates the R2 policy. Public thread reads
also require the active policy. All started copies settle before cleanup on a
failure or request cancellation; cleanup revokes the policy before removing
copied bytes and the database identity. Failed cleanup retains the identity for
retry. An ambiguous final R2 write may already have activated the complete
snapshot; callers must reload or revoke that identity rather than assume the
write was rolled back. Incomplete copies are never activated.

Owner-authenticated `DELETE /api/shared-threads/:id` revokes the parent before
deleting snapshot bytes and the shared-thread catalog entry. User and organization
deletion webhooks revoke in the foreground before acknowledging success; storage
failures return a retryable error. Background cleanup removes copied bytes.
Revoked policies and aliases remain tombstones. Existing snapshots remain
readable and revocable after switch rollback. Already downloaded bytes and
requests authorized before revocation cannot be recalled.

## Deployment

Apply the additive database migration and deploy the API and host Worker before
enabling a test cohort. Older Workers reject the new delivery-record kind, so
mixed deployments fail closed for new snapshot links. This change creates no
bucket, DNS route, credential or rollout override. Per-PR staging acceptance is
still needed for the deployed App/API/Worker combination.
