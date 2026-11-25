# cloudflare-access-lifecycle

## cloudflare-access-lifecycle-001

- Vitest: "creator deletion erases private Access while preserving shared Access and another member's SSH host"
- Mode: run
- Given: A workspace creator owns an organization Cloudflare Access configuration and a personal configuration bound to the creator's SSH host; a member of the same organization has a host bound to the organization configuration.
- When: A signed Clerk `user.deleted` webhook for the creator arrives at `POST /api/webhooks/clerk`, and the member then creates a personal configuration reusing the erased personal configuration's ID and lists configurations and hosts.
- Then: The re-creation returns HTTP 201. The member's configuration list is exactly the shared organization configuration (listing the member's host) and the new personal configuration, and the member's host remains.

## cloudflare-access-lifecycle-002

- Vitest: "Clerk webhook organization deletion erases remote identities while preserving another organization's resources"
- Mode: run
- Given: An organization has a shared Cloudflare Access configuration with a bound host and login; a separate surviving organization has its own configuration and bound host.
- When: A signed Clerk `organization.deleted` webhook for the first organization arrives at `POST /api/webhooks/clerk`, and the survivor then recreates the erased configuration ID, the erased login ID via `POST /api/ssh/credentials`, and the erased host ID via `POST /api/ssh/connections`.
- Then: The configuration re-creation returns HTTP 201 and the survivor lists exactly its own configuration (with its host) and the recreated one; before the host re-creation the survivor's hosts are exactly its own host. The login and host re-creations return HTTP 201, after which the hosts are the survivor's host and the recreated host.

## cloudflare-access-lifecycle-003

- Vitest: "manual organization deletion erases remote identities while preserving another organization's resources"
- Mode: run
- Given: An organization has a shared Cloudflare Access configuration with a bound host and login; a separate surviving organization has its own configuration and bound host.
- When: The first organization's admin deletes it via `POST /api/org/delete` with confirmation, and the survivor then recreates the erased configuration ID, login ID and host ID.
- Then: The deletion returns HTTP 200. The configuration re-creation returns HTTP 201 and the survivor lists exactly its own configuration (with its host) and the recreated one; the hosts are first only its own host, then its own host and the recreated host after the login and host re-creations return HTTP 201.

## cloudflare-access-lifecycle-004

- Vitest: "admin conversion retains the config and hosts while other owners must rebind"
- Mode: run
- Given: An admin's organization configuration is bound to the admin's host and to hosts owned by two members.
- When: A member requests `GET /api/cloudflare-access/configs/:configId/impact-preview?operation=convert`, the admin previews, the member attempts `POST .../convert-to-personal`, the admin converts with the preview, each owner lists hosts, and a Clerk `user.deleted` webhook later erases the admin.
- Then: The member's preview and conversion return HTTP 403 `CLOUDFLARE_ACCESS_FORBIDDEN`. The admin's preview has expected revision 1, `otherHostCount` 2, a 64-character hex snapshot, both members as affected owners, and no host counts or member host IDs. The conversion returns HTTP 200 as a personal configuration at revision 2, generation 2 listing only the admin's host, without the client secret. The admin's host advances a generation keeping the binding; each member's host advances a generation with transport `needsRebind` and no configuration ID, and members see no configurations. After the admin's erasure the member's host remains.

## cloudflare-access-lifecycle-005

- Vitest: "conversion requires a fresh preview after binding or revision drift"
- Mode: run
- Given: An admin previews conversion of an organization configuration with no hosts, after which a member binds a host to it.
- When: The admin converts with the stale preview, previews again, renames the configuration via `PATCH /api/cloudflare-access/configs/:configId`, and converts with the second preview.
- Then: The first conversion returns HTTP 409 `CLOUDFLARE_ACCESS_IMPACT_CONFLICT`. The new preview counts one other host with a different snapshot. The rename returns HTTP 200, and the second conversion returns HTTP 409 `CLOUDFLARE_ACCESS_REVISION_CONFLICT`. The member's host stays bound to the configuration.

## cloudflare-access-lifecycle-006

- Vitest: "conversion and concurrent host binding retain a valid admin-owned reference"
- Mode: run
- Given: An admin has an organization configuration with no hosts and has reviewed a conversion preview.
- When: The admin converts it to personal concurrently with binding a new host to it; if the conversion conflicts, the admin previews again and converts.
- Then: A conflicting conversion returns HTTP 409 with a revision or impact conflict while the configuration stays organization-scoped and the host list is exactly the new host, after which the fresh conversion returns HTTP 200. Finally the configuration is personal at the next revision and generation, and the admin's host stays bound to it (advanced one generation when it was converted after binding).
