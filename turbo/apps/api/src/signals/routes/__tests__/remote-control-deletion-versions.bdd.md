# remote-control-deletion-versions

## remote-control-deletion-versions-001

- Vitest: "SSH host reviewed-version deletion > preserves a newer version, deletes its reviewed version, and reports a missing resource"
- Mode: run
- Given: A signed-in workspace admin owns a SSH host that has since been renamed through `PATCH /api/ssh/connections/:connectionId` using its reviewed generation.
- When: The admin sends `DELETE /api/ssh/connections/:connectionId` with the original `expectedGeneration`, lists, deletes with the new generation, lists again, and deletes once more.
- Then: The stale delete returns HTTP 409 with code `SSH_GENERATION_CONFLICT` and the list shows the SSH host at generation +1 with the new name. Deleting with the current generation returns HTTP 204 and the list is empty. The repeat delete returns HTTP 404 with code `SSH_CONNECTION_NOT_FOUND`.

## remote-control-deletion-versions-002

- Vitest: "SSH host reviewed-version deletion > allows only one competing deletion to report success"
- Mode: run
- Given: A signed-in workspace admin owns a SSH host.
- When: The admin sends two concurrent `DELETE /api/ssh/connections/:connectionId` requests with the same reviewed `expectedGeneration`.
- Then: One delete returns HTTP 204 and the other 404, and `GET /api/ssh/connections` is empty.

## remote-control-deletion-versions-003

- Vitest: "SSH host reviewed-version deletion > never deletes an unreviewed version when update and deletion overlap"
- Mode: run
- Given: A signed-in workspace admin owns a SSH host.
- When: The admin concurrently renames it with `PATCH /api/ssh/connections/:connectionId` and deletes it with `DELETE /api/ssh/connections/:connectionId`, both using the reviewed `expectedGeneration`.
- Then: If the rename succeeds, the delete returns HTTP 409 with code `SSH_GENERATION_CONFLICT` and the renamed SSH host remains listed at generation +1. Otherwise the rename returns 404 or 409 with the matching not-found or conflict code, the delete returns 204, and the list is empty.

## remote-control-deletion-versions-004

- Vitest: "SSH host reviewed-version deletion > conceals another owner's resource in the same organization"
- Mode: run
- Given: A workspace admin owns a SSH host; another user in the same organization signs in.
- When: The other user sends `DELETE /api/ssh/connections/:connectionId` with the reviewed `expectedGeneration` and lists, then the owner lists.
- Then: The delete returns HTTP 404 with code `SSH_CONNECTION_NOT_FOUND` and the other user's list is empty. The owner still sees the unchanged SSH host.

## remote-control-deletion-versions-005

- Vitest: "SSH host reviewed-version deletion > conceals another owner's resource in the different organization"
- Mode: run
- Given: A workspace admin owns a SSH host; another user in a different organization signs in.
- When: The other user sends `DELETE /api/ssh/connections/:connectionId` with the reviewed `expectedGeneration` and lists, then the owner lists.
- Then: The delete returns HTTP 404 with code `SSH_CONNECTION_NOT_FOUND` and the other user's list is empty. The owner still sees the unchanged SSH host.

## remote-control-deletion-versions-006

- Vitest: "VNC host reviewed-version deletion > preserves a newer version, deletes its reviewed version, and reports a missing resource"
- Mode: run
- Given: A signed-in workspace admin owns a VNC host that has since been renamed through `PATCH /api/vnc/connections/:connectionId` using its reviewed generation.
- When: The admin sends `DELETE /api/vnc/connections/:connectionId` with the original `expectedGeneration`, lists, deletes with the new generation, lists again, and deletes once more.
- Then: The stale delete returns HTTP 409 with code `VNC_GENERATION_CONFLICT` and the list shows the VNC host at generation +1 with the new name. Deleting with the current generation returns HTTP 204 and the list is empty. The repeat delete returns HTTP 404 with code `VNC_CONNECTION_NOT_FOUND`.

## remote-control-deletion-versions-007

- Vitest: "VNC host reviewed-version deletion > allows only one competing deletion to report success"
- Mode: run
- Given: A signed-in workspace admin owns a VNC host.
- When: The admin sends two concurrent `DELETE /api/vnc/connections/:connectionId` requests with the same reviewed `expectedGeneration`.
- Then: One delete returns HTTP 204 and the other 404, and `GET /api/vnc/connections` is empty.

## remote-control-deletion-versions-008

- Vitest: "VNC host reviewed-version deletion > never deletes an unreviewed version when update and deletion overlap"
- Mode: run
- Given: A signed-in workspace admin owns a VNC host.
- When: The admin concurrently renames it with `PATCH /api/vnc/connections/:connectionId` and deletes it with `DELETE /api/vnc/connections/:connectionId`, both using the reviewed `expectedGeneration`.
- Then: If the rename succeeds, the delete returns HTTP 409 with code `VNC_GENERATION_CONFLICT` and the renamed VNC host remains listed at generation +1. Otherwise the rename returns 404 or 409 with the matching not-found or conflict code, the delete returns 204, and the list is empty.

## remote-control-deletion-versions-009

- Vitest: "VNC host reviewed-version deletion > conceals another owner's resource in the same organization"
- Mode: run
- Given: A workspace admin owns a VNC host; another user in the same organization signs in.
- When: The other user sends `DELETE /api/vnc/connections/:connectionId` with the reviewed `expectedGeneration` and lists, then the owner lists.
- Then: The delete returns HTTP 404 with code `VNC_CONNECTION_NOT_FOUND` and the other user's list is empty. The owner still sees the unchanged VNC host.

## remote-control-deletion-versions-010

- Vitest: "VNC host reviewed-version deletion > conceals another owner's resource in the different organization"
- Mode: run
- Given: A workspace admin owns a VNC host; another user in a different organization signs in.
- When: The other user sends `DELETE /api/vnc/connections/:connectionId` with the reviewed `expectedGeneration` and lists, then the owner lists.
- Then: The delete returns HTTP 404 with code `VNC_CONNECTION_NOT_FOUND` and the other user's list is empty. The owner still sees the unchanged VNC host.

## remote-control-deletion-versions-011

- Vitest: "SSH credential reviewed-version deletion > preserves a newer version, deletes its reviewed version, and reports a missing resource"
- Mode: run
- Given: A signed-in workspace admin owns a SSH credential that has since been renamed through `PATCH /api/ssh/credentials/:credentialId` using its reviewed revision.
- When: The admin sends `DELETE /api/ssh/credentials/:credentialId` with the original `expectedRevision`, lists, deletes with the new revision, lists again, and deletes once more.
- Then: The stale delete returns HTTP 409 with code `SSH_CREDENTIAL_REVISION_CONFLICT` and the list shows the SSH credential at revision +1 with the new name. Deleting with the current revision returns HTTP 204 and the list is empty. The repeat delete returns HTTP 404 with code `SSH_CREDENTIAL_NOT_FOUND`.

## remote-control-deletion-versions-012

- Vitest: "SSH credential reviewed-version deletion > allows only one competing deletion to report success"
- Mode: run
- Given: A signed-in workspace admin owns a SSH credential.
- When: The admin sends two concurrent `DELETE /api/ssh/credentials/:credentialId` requests with the same reviewed `expectedRevision`.
- Then: One delete returns HTTP 204 and the other 404, and `GET /api/ssh/credentials` is empty.

## remote-control-deletion-versions-013

- Vitest: "SSH credential reviewed-version deletion > never deletes an unreviewed version when update and deletion overlap"
- Mode: run
- Given: A signed-in workspace admin owns a SSH credential.
- When: The admin concurrently renames it with `PATCH /api/ssh/credentials/:credentialId` and deletes it with `DELETE /api/ssh/credentials/:credentialId`, both using the reviewed `expectedRevision`.
- Then: If the rename succeeds, the delete returns HTTP 409 with code `SSH_CREDENTIAL_REVISION_CONFLICT` and the renamed SSH credential remains listed at revision +1. Otherwise the rename returns 404 or 409 with the matching not-found or conflict code, the delete returns 204, and the list is empty.

## remote-control-deletion-versions-014

- Vitest: "SSH credential reviewed-version deletion > conceals another owner's resource in the same organization"
- Mode: run
- Given: A workspace admin owns a SSH credential; another user in the same organization signs in.
- When: The other user sends `DELETE /api/ssh/credentials/:credentialId` with the reviewed `expectedRevision` and lists, then the owner lists.
- Then: The delete returns HTTP 404 with code `SSH_CREDENTIAL_NOT_FOUND` and the other user's list is empty. The owner still sees the unchanged SSH credential.

## remote-control-deletion-versions-015

- Vitest: "SSH credential reviewed-version deletion > conceals another owner's resource in the different organization"
- Mode: run
- Given: A workspace admin owns a SSH credential; another user in a different organization signs in.
- When: The other user sends `DELETE /api/ssh/credentials/:credentialId` with the reviewed `expectedRevision` and lists, then the owner lists.
- Then: The delete returns HTTP 404 with code `SSH_CREDENTIAL_NOT_FOUND` and the other user's list is empty. The owner still sees the unchanged SSH credential.

## remote-control-deletion-versions-016

- Vitest: "VNC credential reviewed-version deletion > preserves a newer version, deletes its reviewed version, and reports a missing resource"
- Mode: run
- Given: A signed-in workspace admin owns a VNC credential that has since been renamed through `PATCH /api/vnc/credentials/:credentialId` using its reviewed revision.
- When: The admin sends `DELETE /api/vnc/credentials/:credentialId` with the original `expectedRevision`, lists, deletes with the new revision, lists again, and deletes once more.
- Then: The stale delete returns HTTP 409 with code `VNC_CREDENTIAL_REVISION_CONFLICT` and the list shows the VNC credential at revision +1 with the new name. Deleting with the current revision returns HTTP 204 and the list is empty. The repeat delete returns HTTP 404 with code `VNC_CREDENTIAL_NOT_FOUND`.

## remote-control-deletion-versions-017

- Vitest: "VNC credential reviewed-version deletion > allows only one competing deletion to report success"
- Mode: run
- Given: A signed-in workspace admin owns a VNC credential.
- When: The admin sends two concurrent `DELETE /api/vnc/credentials/:credentialId` requests with the same reviewed `expectedRevision`.
- Then: One delete returns HTTP 204 and the other 404, and `GET /api/vnc/credentials` is empty.

## remote-control-deletion-versions-018

- Vitest: "VNC credential reviewed-version deletion > never deletes an unreviewed version when update and deletion overlap"
- Mode: run
- Given: A signed-in workspace admin owns a VNC credential.
- When: The admin concurrently renames it with `PATCH /api/vnc/credentials/:credentialId` and deletes it with `DELETE /api/vnc/credentials/:credentialId`, both using the reviewed `expectedRevision`.
- Then: If the rename succeeds, the delete returns HTTP 409 with code `VNC_CREDENTIAL_REVISION_CONFLICT` and the renamed VNC credential remains listed at revision +1. Otherwise the rename returns 404 with code `VNC_CREDENTIAL_NOT_FOUND`, the delete returns 204, and the list is empty.

## remote-control-deletion-versions-019

- Vitest: "VNC credential reviewed-version deletion > conceals another owner's resource in the same organization"
- Mode: run
- Given: A workspace admin owns a VNC credential; another user in the same organization signs in.
- When: The other user sends `DELETE /api/vnc/credentials/:credentialId` with the reviewed `expectedRevision` and lists, then the owner lists.
- Then: The delete returns HTTP 404 with code `VNC_CREDENTIAL_NOT_FOUND` and the other user's list is empty. The owner still sees the unchanged VNC credential.

## remote-control-deletion-versions-020

- Vitest: "VNC credential reviewed-version deletion > conceals another owner's resource in the different organization"
- Mode: run
- Given: A workspace admin owns a VNC credential; another user in a different organization signs in.
- When: The other user sends `DELETE /api/vnc/credentials/:credentialId` with the reviewed `expectedRevision` and lists, then the owner lists.
- Then: The delete returns HTTP 404 with code `VNC_CREDENTIAL_NOT_FOUND` and the other user's list is empty. The owner still sees the unchanged VNC credential.

## remote-control-deletion-versions-021

- Vitest: "SSH deletion request validation > requires the reviewed generation with absent App headers"
- Mode: run
- Given: A signed-in workspace admin owns an SSH host, and the request carries no App client headers.
- When: The admin sends `DELETE /api/ssh/connections/:connectionId` without an expected generation.
- Then: The request returns HTTP 400 with code `SSH_INVALID_INPUT`, and the SSH host is still listed unchanged.

## remote-control-deletion-versions-022

- Vitest: "SSH deletion request validation > requires the reviewed generation with missing version App headers"
- Mode: run
- Given: A signed-in workspace admin owns an SSH host, and the request carries the App client-type header but no version header.
- When: The admin sends `DELETE /api/ssh/connections/:connectionId` without an expected generation.
- Then: The request returns HTTP 400 with code `SSH_INVALID_INPUT`, and the SSH host is still listed unchanged.

## remote-control-deletion-versions-023

- Vitest: "SSH deletion request validation > requires the reviewed generation with unparseable version App headers"
- Mode: run
- Given: A signed-in workspace admin owns an SSH host, and the request carries the App client-type header and an unparseable version header.
- When: The admin sends `DELETE /api/ssh/connections/:connectionId` without an expected generation.
- Then: The request returns HTTP 400 with code `SSH_INVALID_INPUT`, and the SSH host is still listed unchanged.

## remote-control-deletion-versions-024

- Vitest: "SSH deletion request validation > force-upgrades an unsupported App before deletion and accepts the supported App's reviewed generation"
- Mode: run
- Given: A signed-in workspace admin owns an SSH host.
- When: The admin sends `DELETE /api/ssh/connections/:connectionId` from App version `0.1027.1` without a generation, then from the minimum supported App version with `expectedGeneration`.
- Then: The first request returns HTTP 426 with `cache-control: no-store` and body `{ error: "Client update required" }`, and the host remains listed. The supported App's delete returns HTTP 204 and the list is empty.

## remote-control-deletion-versions-025

- Vitest: "SSH deletion request validation > keeps a versioned SSH host while a VNC host references it"
- Mode: run
- Given: A signed-in workspace admin owns an SSH host and a VNC host tunnelled through it.
- When: The admin deletes the SSH host with its `expectedGeneration`, deletes the VNC host, then deletes the SSH host again.
- Then: The first SSH delete returns HTTP 409 with code `SSH_CONNECTION_IN_USE` and the host remains listed. After the VNC host is deleted (HTTP 204), the SSH host delete returns HTTP 204.
