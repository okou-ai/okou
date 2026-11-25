# cloudflare-access-promotion-deletion

## cloudflare-access-promotion-deletion-001

- Vitest: "only an admin may promote their own Personal configuration in place without losing SSH bindings"
- Mode: run
- Given: An admin owns a personal Cloudflare Access configuration bound to the admin's SSH host; a member of the same organization owns another personal configuration; an admin of a different organization exists.
- When: The member, the admin (on the member's configuration), the other organization's admin, and the admin with a stale revision call `POST /api/cloudflare-access/configs/:configId/convert-to-organization`; the admin then promotes at revision 1, the member lists configurations and binds a host, and a Clerk `user.deleted` webhook erases the admin.
- Then: The member's request returns HTTP 403 `CLOUDFLARE_ACCESS_FORBIDDEN`, the admin's request for the member's configuration and the foreign admin's request return HTTP 404, and the stale revision returns HTTP 409. The promotion returns HTTP 200 as an organization configuration at revision 2, generation 2 listing the admin's host, without the client secret, and the host keeps its login, port and binding at the next generation. The member sees the organization configuration with no hosts of their own; after the admin's erasure it remains organization-scoped and the member's host stays bound.

## cloudflare-access-promotion-deletion-002

- Vitest: "named impact previews disclose total hosts and owners, never per-owner usage or host details"
- Mode: run
- Given: An admin's organization configuration is bound to one admin host, two hosts of a first member (whose Clerk profile is "First Member"), and one host of a second member without a profile name.
- When: A member requests `GET /api/cloudflare-access/configs/:configId/impact-preview` for `convert` and `delete`, and the admin requests both previews.
- Then: The member's previews return HTTP 403. Both admin previews have expected revision 1, `ownHostCount` 1, `otherHostCount` 3, and exactly two affected owners (`First Member` and a null display name), with no per-owner host counts, host IDs or host names, and they share the same impact snapshot.

## cloudflare-access-promotion-deletion-003

- Vitest: "new impact previews omit the warning data when no other hosts are bound"
- Mode: run
- Given: An admin has an organization configuration with no bound hosts.
- When: The admin requests `GET /api/cloudflare-access/configs/:configId/impact-preview` for `convert` and for `delete`.
- Then: Each preview reports `ownHostCount` 0, `otherHostCount` 0 and no affected owners.

## cloudflare-access-promotion-deletion-004

- Vitest: "an admin reviews aggregate impact before deleting other owners' hosts; stale or unreviewed requests cannot detach them"
- Mode: run
- Given: An admin's organization configuration is bound to two hosts of a first member ("First Member") and one host of a second member.
- When: A member requests a deletion preview; the admin previews, deletes without a snapshot, deletes with the snapshot after the first member binds another host, previews again, renames the configuration, deletes with the previous preview, reviews again, and deletes at a fixed time.
- Then: The member's preview returns HTTP 403. The admin's preview shows revision 1, no own hosts, three other hosts and two named owners without host details. Deletion without a snapshot returns HTTP 409 `CLOUDFLARE_ACCESS_IMPACT_CONFLICT`, the stale snapshot returns HTTP 409, the new preview counts four other hosts with a different snapshot, and after the rename the deletion returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT`. The fresh review expects revision 2 and the deletion returns HTTP 204; no configurations remain and both members' hosts keep their logins, advance a generation, are updated at the deletion time, and have transport `needsRebind`.

## cloudflare-access-promotion-deletion-005

- Vitest: "a reviewed deletion is stale when a member removes the last reference"
- Mode: run
- Given: An admin's organization configuration is bound to a single member host, and the admin has reviewed a deletion preview.
- When: The member deletes the host via `DELETE /api/ssh/connections/:connectionId`, then the admin deletes the configuration with the reviewed preview.
- Then: The host deletion returns HTTP 204, the configuration deletion returns HTTP 409 `CLOUDFLARE_ACCESS_IMPACT_CONFLICT`, and the configuration still exists.

## cloudflare-access-promotion-deletion-006

- Vitest: "removing one reviewed peer host rejects deletion without detaching the remaining host"
- Mode: run
- Given: An admin's organization configuration is bound to two hosts of one member, and the admin has reviewed a deletion preview.
- When: The member deletes one of the hosts via `DELETE /api/ssh/connections/:connectionId`, then the admin deletes the configuration with the reviewed preview.
- Then: The host deletion returns HTTP 204 and the configuration deletion returns HTTP 409 `CLOUDFLARE_ACCESS_IMPACT_CONFLICT`. The configuration still exists, and the member's host list is unchanged, with the remaining host still bound at its original generation.

## cloudflare-access-promotion-deletion-007

- Vitest: "changing a reviewed peer host generation requires a fresh review before deletion"
- Mode: run
- Given: An admin's organization configuration is bound to one member host, and the admin has reviewed a deletion preview.
- When: The member renames the host via `PATCH /api/ssh/connections/:connectionId`, the admin deletes with the old preview, previews again, and deletes with the new preview.
- Then: The rename returns HTTP 200 at the next generation. The stale deletion returns HTTP 409 `CLOUDFLARE_ACCESS_IMPACT_CONFLICT`; the new preview has a different snapshot but the same expected revision, and the member's renamed host is unchanged. The fresh deletion returns HTTP 204 and the member's host keeps its new name, advances one more generation, and has transport `needsRebind`.

## cloudflare-access-promotion-deletion-008

- Vitest: "losing admin role after a deletion preview cannot detach another member's host"
- Mode: run
- Given: An admin's organization configuration is bound to a member's host; the admin reviews a deletion preview and is then demoted to a member.
- When: The demoted user deletes the configuration via `DELETE /api/cloudflare-access/configs/:configId` with the reviewed preview.
- Then: The request returns HTTP 403 `CLOUDFLARE_ACCESS_FORBIDDEN`, and the member's host stays bound to the configuration.

## cloudflare-access-promotion-deletion-009

- Vitest: "binding and reviewed deletion serialize without leaving a broken SSH reference"
- Mode: run
- Given: An admin has reviewed an empty deletion preview for an organization configuration.
- When: The admin deletes the configuration concurrently with creating a host bound to it via `POST /api/ssh/connections`.
- Then: If the host is created (HTTP 201), the deletion returns HTTP 409, the configuration remains and the host stays bound. Otherwise the deletion returns HTTP 204 and no configurations or hosts remain.

## cloudflare-access-promotion-deletion-010

- Vitest: "a competing new binding cannot leave a reviewed peer detached while its configuration remains"
- Mode: run
- Given: An admin has a direct host with a reusable login and an organization configuration bound to a member's peer host, and has reviewed a deletion preview.
- When: The admin creates a new host bound to the configuration using the existing login concurrently with deleting the configuration with the reviewed preview.
- Then: If the new host is created (HTTP 201), the deletion returns HTTP 409, the configuration remains, the admin's hosts include the new host and the member's peer host is unchanged. Otherwise the deletion returns HTTP 204, no configurations remain, the admin has only the direct host, and the peer host advances a generation with transport `needsRebind`.

## cloudflare-access-promotion-deletion-011

- Vitest: "a newly bound self-owned host blocks deletion after an initially empty review"
- Mode: run
- Given: An admin reviews a deletion preview for an organization configuration with no hosts (no own hosts, no affected owners), then binds the admin's own host to it.
- When: The admin deletes the configuration via `DELETE /api/cloudflare-access/configs/:configId` with the reviewed preview.
- Then: The request returns HTTP 409 `CLOUDFLARE_ACCESS_IN_USE`, and the admin's host stays bound to the configuration.

## cloudflare-access-promotion-deletion-012

- Vitest: "self-owned SSH references block deletion even with a reviewed snapshot; an ordinary member cannot preview impact"
- Mode: run
- Given: An admin's organization configuration is bound to the admin's own host and to a member's host.
- When: The member requests a deletion impact preview, the admin previews, and the admin deletes the configuration at revision 1 with the reviewed snapshot.
- Then: The member's preview returns HTTP 403. The admin's preview shows `ownHostCount` 1. The deletion returns HTTP 409 `CLOUDFLARE_ACCESS_IN_USE`, and both the member's and the admin's hosts stay bound to the configuration.
