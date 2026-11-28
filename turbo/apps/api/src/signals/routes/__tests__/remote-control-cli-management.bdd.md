# remote-control-cli-management

## remote-control-cli-management-001

- Vitest: "remote control CLI management authorization > allows a dispatched Run to manage saved SSH credentials and bindings without exposing secrets"
- Mode: run
- Given: A workspace member has a dispatched Run on an official Runner, and the Run uses its guest credentials; secrets are encrypted with the configured key service.
- When: The Run creates a password SSH credential named `  CLI operations  ` with `POST /api/ssh/credentials`, creates an SSH host bound to it with `POST /api/ssh/connections`, sends `DELETE /api/ssh/connections/:connectionId` without an expected generation, lists connections, rotates the credential with `PATCH /api/ssh/credentials/:credentialId` using the expected revision, and lists credentials.
- Then: The credential is created (HTTP 201) with trimmed name `CLI operations`, `authMethod` `password` and revision 1, and the host is bound to it. The versionless delete returns HTTP 400 with code `SSH_INVALID_INPUT` and the host is still listed. The update returns revision 2 and the list contains exactly the updated credential. No response contains either password.

## remote-control-cli-management-002

- Vitest: "remote control CLI management authorization > accepts a device-approved PAT for VNC configuration"
- Mode: run
- Given: A workspace member has signed in through the CLI device flow (device code created, approved in the browser session, and exchanged for a personal access token).
- When: Using the token, the member creates an SSH credential, lists credentials, and lists `GET /api/vnc/connections`; the browser session also lists credentials.
- Then: The credential is created (HTTP 201) without exposing the password, the token's credential list contains exactly it, the VNC list is `{ connections: [] }`, and the browser session sees the same credential.

## remote-control-cli-management-003

- Vitest: "remote control CLI management authorization > requires a device-approved PAT to supply the reviewed SSH host generation"
- Mode: run
- Given: A workspace member holds a device-approved personal access token and has created an SSH credential and a host bound to it.
- When: The member sends `DELETE /api/ssh/connections/:connectionId` without a body, lists connections, then deletes with the host's `expectedGeneration` and lists again.
- Then: The versionless delete returns HTTP 400 with code `SSH_INVALID_INPUT` and the host remains listed. The delete with the expected generation returns HTTP 204 and the list becomes empty.

## remote-control-cli-management-004

- Vitest: "remote control CLI management authorization > keeps another organization member from accessing or modifying owned credentials"
- Mode: run
- Given: A workspace member has created an SSH credential with a device-approved token; another member of the same organization has their own device-approved token.
- When: The other member lists credentials and tries to update and delete the first member's credential with its revision; then the first member lists credentials.
- Then: The other member's list is empty, and the update and delete both return HTTP 404. The owner's list still contains the unchanged credential.
