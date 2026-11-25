# ssh-credentials

## ssh-credentials-001

- Vitest: "reusable SSH credential owner routes > requires a session to list credentials"
- Mode: run
- Given: The caller sends no session credentials.
- When: The caller lists SSH credentials with `GET /api/ssh/credentials`.
- Then: The request returns HTTP 401 with error code `UNAUTHORIZED`.

## ssh-credentials-002

- Vitest: "reusable SSH credential owner routes > shares named metadata, rejects referenced deletion, and preserves credentials after host deletion"
- Mode: run
- Given: A signed-in member can encrypt secrets with KMS.
- When: The member creates a password login with padded name " Operations " and username " deploy " via `POST /api/ssh/credentials`, attaches it to two hosts "First" and "Second" via `POST /api/ssh/connections`, lists credentials, tries to delete it with `DELETE /api/ssh/credentials/:credentialId`, deletes both hosts, then deletes the credential.
- Then: The create returns HTTP 201 with name `Operations`, username `deploy`, auth method `password`, revision 1, no hosts and `cache-control: no-store`. The credential list shows both hosts by ID and display name. None of the create, list or host responses contain the password, encrypted fields, `vm0secret:` or `authentication`. Deleting the referenced credential returns HTTP 409 with `SSH_CREDENTIAL_IN_USE`. After both hosts are deleted (HTTP 204) the credential is still listed unchanged, and deleting it then returns HTTP 204 and the list is empty.

## ssh-credentials-003

- Vitest: "reusable SSH credential owner routes > keeps a referenced credential usable when deletion overlaps login rotation"
- Mode: run
- Given: A signed-in member has a password login used by one host.
- When: The member concurrently rotates the login with `PATCH /api/ssh/credentials/:credentialId` (new username `rotated-delete-user` and new password, revision 1) and deletes it with `DELETE /api/ssh/credentials/:credentialId` at revision 1.
- Then: The rotation returns HTTP 200 with revision 2, username `rotated-delete-user` and the host still linked; the deletion returns HTTP 409. The credential list contains exactly the rotated credential.

## ssh-credentials-004

- Vitest: "reusable SSH credential owner routes > keeps every host on the current credential when attachment races rotation"
- Mode: run
- Given: A signed-in member has a password login used by host "Existing host" (`first.example.com`).
- When: The member concurrently attaches the same login to a new host "New host" (`second.example.com`) via `POST /api/ssh/connections` and changes the login's username to `rotated-user` via `PATCH /api/ssh/credentials/:credentialId` at revision 1.
- Then: The attach returns HTTP 201 and the rotation HTTP 200. The host list has two hosts, both using the login with username `rotated-user`: the existing host at generation 2 and the new host at generation 1 or 2. The credential list shows the login at revision 2 with username `rotated-user` and both hosts linked.

## ssh-credentials-005

- Vitest: "reusable SSH credential owner routes > resolves the current credential after concurrent low-frequency rotations"
- Mode: run
- Given: A signed-in member has a password login used by host "Shared".
- When: The member concurrently sends two `PATCH /api/ssh/credentials/:credentialId` requests at revision 1 setting the username to `first-user` and `second-user`.
- Then: Each returns HTTP 200 or 409 and at least one succeeds. The credential's username is one of the two values, and the host list shows the host bound to the same credential with that same username.

## ssh-credentials-006

- Vitest: "reusable SSH credential owner routes > hides other users and organizations before KMS work or binding"
- Mode: run
- Given: An owner has a password login (one KMS data-key generation). Two other callers are signed in in turn: one sharing the owner's organization ID and one sharing the owner's user ID.
- When: Each other caller lists credentials, updates the owner's credential ID and a random unknown ID with new authentication, creates a host bound to each of those IDs, deletes the owner's credential, and lists hosts.
- Then: Each other caller sees an empty credential list. Every update and host bind returns HTTP 404 with `SSH_CREDENTIAL_NOT_FOUND`, the delete returns HTTP 404, and their host list is empty. KMS data-key generation stays at one call.

## ssh-credentials-007

- Vitest: "reusable SSH credential owner routes > rejects malformed authentication without logging or echoing supplied secrets"
- Mode: run
- Given: A signed-in member can encrypt secrets with KMS.
- When: The member sends raw `POST /api/ssh/credentials` requests with malformed authentication carrying a canary secret: a password method that also has a private key, a private-key method with an empty passphrase, and a private-key method that also has a password.
- Then: Each request returns HTTP 400, no response body contains the canary, and KMS generates no data key.

## ssh-credentials-008

- Vitest: "reusable SSH credential owner routes > rejects a delayed stale edit and keeps the winning credential usable"
- Mode: run
- Given: A signed-in member has a password login at revision 1. A private-key replacement edit stalls during KMS encryption.
- When: While the replacement edit is stalled, the member renames the login to "Concurrent winner" via `PATCH /api/ssh/credentials/:credentialId` at revision 1; then the stalled edit finishes; then the member deletes at revision 1 and again at revision 2.
- Then: The rename returns HTTP 200 with name `Concurrent winner`, revision 2 and auth method `password`. The stalled edit returns HTTP 409 with `SSH_CREDENTIAL_REVISION_CONFLICT`, and the credential list shows exactly the renamed credential. The stale delete returns HTTP 409 with `SSH_CREDENTIAL_REVISION_CONFLICT`, and the delete at revision 2 returns HTTP 204.

## ssh-credentials-009

- Vitest: "reusable SSH credential owner routes > publishes a prepared authentication edit after every observed host is deleted"
- Mode: run
- Given: A signed-in member has a login used by host "Initially attached" and a second login "Replacement". An edit of the first login (username `rotated-user`, private-key authentication) stalls during KMS encryption.
- When: While the edit is stalled, the member deletes the host with `DELETE /api/ssh/connections/:connectionId`; then the edit finishes.
- Then: The host delete returns HTTP 204 and the edit returns HTTP 200 with the original name and createdAt, username `rotated-user`, auth method `private_key`, revision 2, and the host it observed listed. The credential list then shows the edited login with no hosts and the replacement login with no hosts, and the host list is empty.

## ssh-credentials-010

- Vitest: "reusable SSH credential owner routes > publishes a prepared authentication edit after every observed host is rebound"
- Mode: run
- Given: A signed-in member has a login used by host "Initially attached" and a second login "Replacement". An edit of the first login (username `rotated-user`, private-key authentication) stalls during KMS encryption.
- When: While the edit is stalled, the member rebinds the host to the replacement login with `PATCH /api/ssh/connections/:connectionId`; then the edit finishes.
- Then: The rebind returns HTTP 200 and the edit returns HTTP 200 with the original name and createdAt, username `rotated-user`, auth method `private_key`, revision 2, and the host it observed listed. The credential list then shows the edited login with no hosts and the replacement login with the host linked. The host list shows the host bound to the replacement login with its username and generation increased by one.

## ssh-credentials-011

- Vitest: "reusable SSH credential owner routes > leaves a recoverable credential state after deletion overlaps an edit"
- Mode: run
- Given: A signed-in member has an unused password login at revision 1.
- When: The member concurrently renames it to "Concurrent edit" via `PATCH /api/ssh/credentials/:credentialId` and deletes it via `DELETE /api/ssh/credentials/:credentialId`, both at revision 1.
- Then: If the delete wins (HTTP 204), the edit returns HTTP 404 with `SSH_CREDENTIAL_NOT_FOUND` or HTTP 409 with `SSH_CREDENTIAL_REVISION_CONFLICT` and no credential remains. Otherwise the delete returns HTTP 409 with `SSH_CREDENTIAL_REVISION_CONFLICT`, the edit returns HTTP 200 with name `Concurrent edit` and revision 2, the list contains only that credential, and deleting it at revision 2 returns HTTP 204 and empties the list.

## ssh-credentials-012

- Vitest: "reusable SSH credential owner routes > preserves one valid outcome when creating a host races credential deletion"
- Mode: run
- Given: A signed-in member has an unused password login at revision 1.
- When: The member concurrently creates a host bound to the login via `POST /api/ssh/connections` and deletes the login via `DELETE /api/ssh/credentials/:credentialId`.
- Then: Either the host create returns HTTP 201 and the delete HTTP 409 with `SSH_CREDENTIAL_IN_USE`, leaving one host and one credential; or the host create returns HTTP 404 with `SSH_CREDENTIAL_NOT_FOUND` and the delete HTTP 204, leaving no hosts and no credentials.

## ssh-credentials-013

- Vitest: "reusable SSH credential owner routes > preserves the host binding when changing credentials races deletion"
- Mode: run
- Given: A signed-in member has host "Existing" bound to an original login, plus an unused "Replacement" login.
- When: The member concurrently rebinds the host to the replacement login (renaming it "Rebound") via `PATCH /api/ssh/connections/:connectionId` and deletes the replacement login via `DELETE /api/ssh/credentials/:credentialId`.
- Then: Either the rebind returns HTTP 200 and the delete HTTP 409 with `SSH_CREDENTIAL_IN_USE`, the host list shows the rebound host and both logins remain; or the rebind returns HTTP 404 with `SSH_CREDENTIAL_NOT_FOUND` and the delete HTTP 204, the host list shows the unchanged original host and only the original login remains.
