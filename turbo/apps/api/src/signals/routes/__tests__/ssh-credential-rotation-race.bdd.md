# ssh-credential-rotation-race

## ssh-credential-rotation-race-001

- Vitest: "SSH host edits overlapping credential rotation > keeps the published credential usable with uncontrolled ordering"
- Mode: run
- Given: A signed-in member has a saved password login "Operations" (username `deploy`) used by host `ssh.example.com`. No ordering is enforced between the two requests.
- When: The member concurrently renames the host with `PATCH /api/ssh/connections/:connectionId` and changes the login's username to `rotated-user` with `PATCH /api/ssh/credentials/:credentialId`, both against the original generation and revision; then enables the host as a remote-access default and an official Runner resolves it for the member's running Run via `POST /api/runners/runs/:runId/ssh/resolve`.
- Then: Each request returns HTTP 200 or 409 and at least one succeeds; a rejected edit carries `SSH_GENERATION_CONFLICT` and a rejected rotation carries `SSH_CREDENTIAL_REVISION_CONFLICT`. The host list shows one host whose name, username and generation reflect exactly the successful changes (one generation per success), and the credential list shows the login with the matching username and revision and the host linked under its current name. The Runner receives `resolved_password` with the host, port, that username and generation, no learned host key, and the original password.

## ssh-credential-rotation-race-002

- Vitest: "SSH host edits overlapping credential rotation > keeps the published credential usable with host first ordering"
- Mode: run
- Given: A signed-in member has a saved password login "Operations" (username `deploy`) used by host `ssh.example.com`. The credential rotation also replaces the password, and its KMS encryption stalls until the host edit has finished.
- When: The member rotates the login with `PATCH /api/ssh/credentials/:credentialId` (username `rotated-user`, new password), renames the host to "Edited" with `PATCH /api/ssh/connections/:connectionId` while the rotation is stalled, then lets the rotation finish; afterwards the host is enabled as a remote-access default and an official Runner resolves it for the member's running Run.
- Then: Both the edit and the rotation return HTTP 200. The host list shows the host as `Edited` with username `rotated-user` and generation increased by two, and the credential list shows the login with `rotated-user`, revision increased by one and the host linked as `Edited`. The Runner receives `resolved_password` with username `rotated-user`, the new generation, no learned host key, and the rotated password.

## ssh-credential-rotation-race-003

- Vitest: "SSH host edits overlapping credential rotation > keeps the published credential usable with rotation first ordering"
- Mode: run
- Given: A signed-in member has a saved password login "Operations" (username `deploy`) used by host `ssh.example.com`. The host edit's authentication stalls until the credential rotation has finished.
- When: The member sends the host rename with `PATCH /api/ssh/connections/:connectionId`, and while it is stalled changes the login's username to `rotated-user` with `PATCH /api/ssh/credentials/:credentialId`; afterwards the host is enabled as a remote-access default and an official Runner resolves it for the member's running Run.
- Then: The rotation returns HTTP 200 and the stale host edit returns HTTP 409 with `SSH_GENERATION_CONFLICT`. The host keeps its original name with username `rotated-user` and generation increased by one, and the credential shows `rotated-user` with revision increased by one. The Runner receives `resolved_password` with username `rotated-user`, that generation, no learned host key, and the original password.
