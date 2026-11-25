# runner-ssh

## runner-ssh-001

- Vitest: "SSH authority invalidation > notifies all active owner Runs after committed edits, rotations, reset and deletion"
- Mode: run
- Given: An owner has an SSH host (`deploy` inline key) enabled by default, two active runs and one completed run in the same Runner group; another owner has a separate SSH host and run.
- When: The owner edits the host via `PATCH /api/ssh/connections/:connectionId` (new host, then rotated credential) with the current `expectedGeneration`, resets the host key via `POST /api/ssh/connections/:connectionId/reset-host-key`, deletes it via `DELETE /api/ssh/connections/:connectionId`, and lists `GET /api/ssh/connections`.
- Then: Each edit, the reset (HTTP 200) and the delete (HTTP 204) publish exactly three realtime messages: `ssh:changed` with the owner's org ID on the owner's user channel, and `ssh-authority-invalidated` with the run and connection IDs for each of the two active runs on the Runner group channel; the completed run and the other owner receive nothing. The final list is empty.

## runner-ssh-002

- Vitest: "SSH authority invalidation > keeps committed mutations successful when notification delivery fails"
- Mode: run
- Given: A Pro owner has a running chat run dispatched to an official Runner and an SSH host enabled by default; realtime publishing fails.
- When: The owner changes the host credential to username `new-login` via `PATCH /api/ssh/connections/:connectionId` with `expectedGeneration: 1`, then lists `GET /api/ssh/connections`.
- Then: The update returns HTTP 200 with generation 2, and the list shows the host with generation 2 and username `new-login`. The attempted publications are exactly `ssh:changed` for the org and `ssh-authority-invalidated` for the run and connection.

## runner-ssh-003

- Vitest: "SSH authority invalidation > resolves the current host credentials after overlapping low-frequency edits"
- Mode: run
- Given: A Pro owner has a running chat run dispatched to an official Runner and an SSH host enabled by default.
- When: The owner sends two concurrent `PATCH /api/ssh/connections/:connectionId` credential edits (`first-login`, `second-login`) both with `expectedGeneration: 1`; the official Runner then calls `POST /api/runners/runs/:runId/ssh/resolve`.
- Then: At least one edit returns HTTP 200 (the other may return 409). The listed host's username is one of the two, and the resolve returns `outcome: "resolved"` with that username and the listed generation.

## runner-ssh-004

- Vitest: "chat thread SSH authority > uses current per-host defaults and overrides for a dispatched chat Run"
- Mode: run
- Given: A chat user has a dispatched chat run on an official Runner and an SSH host that is not enabled by default.
- When: The official Runner calls `POST /api/runners/runs/:runId/ssh/resolve` while the owner toggles `PUT /api/remote-access/hosts/ssh/:connectionId/default` and `PUT`/`DELETE /api/chat-threads/:threadId/remote-access/ssh/:connectionId`; the Runner also calls `POST /api/runners/runs/:runId/ssh/pin` while disabled.
- Then: Resolve is `unavailable` with the default off, `resolved` once the default is on. Disabling the thread override publishes `ssh:changed` and `ssh-authority-invalidated` for the run, after which resolve and pin both return `{ outcome: "unavailable" }`. With the thread override on and the default off, resolve is `resolved`; after clearing the override it is `unavailable`.

## runner-ssh-005

- Vitest: "shared credential runtime authority > rotates every referencing host, preserves pins, invalidates the Run, and rebinds only one host"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host using a saved `deploy` key credential (pinned to a host key), plus a second "Shared host" referencing the same credential and an unrelated host with its own `other` key, all enabled by default.
- When: The owner renames the credential via `PATCH /api/ssh/credentials/:credentialId`, then rotates it to username `operator` with a password, re-points the shared host to the unrelated credential via `PATCH /api/ssh/connections/:connectionId`, and switches the credential to a new private key; the official Runner resolves, pins and observes via `POST /api/runners/runs/:runId/ssh/{resolve,pin,observations}` between steps.
- Then: The rename keeps every host generation and publishes only `ssh:changed`. The rotation publishes `ssh:changed` and `ssh-authority-invalidated` with the run and `connectionId: null`, bumps the generation of only the hosts referencing the credential, and keeps learned host keys. Both referencing hosts resolve as `resolved_password` with `operator` and the password and no key fields; the unrelated host still resolves its key. A pin with stale generation 1 on the shared host returns `configuration_changed` and a stale observation is `ignored`. After re-pointing, the shared host resolves generation 3 with the unrelated key while the original still resolves the password; after the key switch the original resolves `operator` with `new-key`, null passphrase and no password, and the shared host is unchanged.

## runner-ssh-006

- Vitest: "SSH connection observations > ignores delayed evidence when a deleted SSH ID is recreated"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host; the Runner recorded an authentication failure one second ago. The owner then deletes the host and recreates it with the same ID (new creation time) enabled by default.
- When: The official Runner posts `POST /api/runners/runs/:runId/ssh/observations` with the delayed failure, then a recovery (null failure reason) with the new creation time, then the delayed failure again; the owner reads `GET /api/ssh/connections/observations`.
- Then: The first observation returns `recorded`. The recreated host has generation 1 and a different microsecond-precision `createdAt`, and observations are empty. The delayed failure returns `ignored`, the recovery returns `recorded`, and the replayed failure is `ignored`. Observations list exactly the recovery with the new creation time, generation 1 and null failure reason.

## runner-ssh-007

- Vitest: "SSH connection observations > isolates credentials, trust and observations for a shared endpoint with sibling username deploy"
- Mode: run
- Given: Row `deploy`: a Pro owner has a running chat run on an official Runner and an SSH host for `ssh.example.com` as `deploy`, plus a sibling host `SSH.example.com.` with its own `deploy` key and passphrase, both enabled by default.
- When: The official Runner resolves both hosts, records authentication-failure observations for both, pins the first host, and resolves again after the owner rotates, resets the host key of, and deletes the first host; the owner reads `GET /api/ssh/connections/observations`.
- Then: The sibling resolves to normalized host `ssh.example.com`, port 22, username `deploy`, its own key and passphrase, generation 1 and no learned host key, and stays byte-identical throughout. The first host resolves its own key; pinning returns `{ outcome: "pinned", generation: 2 }` and clears its observation, leaving only the sibling's. After rotation it resolves `rotated-login` with the learned host key at generation 3; after reset the host key is null at generation 4; after deletion it is `unavailable` and the list contains only the sibling.

## runner-ssh-008

- Vitest: "SSH connection observations > isolates credentials, trust and observations for a shared endpoint with sibling username ubuntu"
- Mode: run
- Given: Row `ubuntu`: a Pro owner has a running chat run on an official Runner and an SSH host for `ssh.example.com` as `deploy`, plus a sibling host `SSH.example.com.` with an `ubuntu` key and passphrase, both enabled by default.
- When: The official Runner resolves both hosts, records authentication-failure observations for both, pins the first host, and resolves again after the owner rotates, resets the host key of, and deletes the first host; the owner reads `GET /api/ssh/connections/observations`.
- Then: The sibling resolves to normalized host `ssh.example.com`, port 22, username `ubuntu`, its own key and passphrase, generation 1 and no learned host key, and stays byte-identical throughout. The first host resolves `deploy` with its own key; pinning returns `{ outcome: "pinned", generation: 2 }` and clears its observation, leaving only the sibling's. After rotation it resolves `rotated-login` with the learned host key at generation 3; after reset the host key is null at generation 4; after deletion it is `unavailable` and the list contains only the sibling.

## runner-ssh-009

- Vitest: "SSH connection observations > records bounded owner-only failures and recovery without changing configuration or invalidating credentials"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host with a microsecond-precision creation time; another owner has their own run and host.
- When: The official Runner resolves the host, then posts `POST /api/runners/runs/:runId/ssh/observations` with a creation time differing only in the last microsecond digit, an authentication failure one second ago, a recovery, a replay of the failure, a replay of the recovery, a failure two minutes in the future, and a later healthy observation; the owners read `GET /api/ssh/connections/observations` and `GET /api/ssh/connections`.
- Then: The resolve response carries `X-SSH-Connection-Created-At` equal to the host's creation time. The other-instance observation is `ignored` and leaves observations empty. The failure is `recorded` as one entry with generation 1 and `authentication_failed`, without changing the host list, decrypting secrets or publishing anything but `ssh:changed`; the other owner sees no observations. The recovery is `recorded` with a null failure reason; the replays and the future failure are `ignored`; the later healthy observation is `recorded` with its time. The host list is unchanged at the end.

## runner-ssh-010

- Vitest: "SSH connection observations > fences configuration changes and uses the post-TOFU generation"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host at generation 1.
- When: The Runner records an observation, pins the host key via `POST /api/runners/runs/:runId/ssh/pin`, observes at generations 1 and 2, the owner rotates the credential via `PATCH /api/ssh/connections/:connectionId`, the Runner observes at generations 2 and 3, the owner deletes the host, and the Runner observes at generation 3.
- Then: The pin returns `{ outcome: "pinned", generation: 2 }` and clears observations. A generation-1 observation is `ignored` and generation 2 is `recorded` with generation 2. After the credential edit observations are empty, generation 2 is `ignored` and generation 3 is `recorded`. After deletion observations are empty and the observation returns `unavailable`.

## runner-ssh-011

- Vitest: "SSH connection observations > requires official authentication and current winning-runner, owner, Run and chat authority"
- Mode: run
- Given: An owner has an SSH host enabled by default and an active run on an official Runner; another owner has a separate host; a third owner's run has completed.
- When: `POST /api/runners/runs/:runId/ssh/observations` is sent with a Clerk session, the run's sandbox token and a wrong official secret; then with the official secret using another Runner ID, an older heartbeat generation, the other owner's connection, the completed run, after disabling the thread override, and after clearing it.
- Then: The three wrong credentials return HTTP 401. Wrong Runner ID, wrong generation, foreign connection, completed run and disabled thread override each return `{ outcome: "unavailable" }`. After clearing the override the observation is `recorded`, and the owner's `GET /api/ssh/connections/observations` returns HTTP 200.

## runner-ssh-012

- Vitest: "SSH connection observations > rejects diagnostic text and command outcomes instead of storing them as connection failures"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host.
- When: The official Runner posts `POST /api/runners/runs/:runId/ssh/observations` with an extra `error` containing the private key, an extra `command`, failure reasons `exec_rejected` and `cancelled`, and `expectedGeneration: 0`.
- Then: Every request returns HTTP 400, and `GET /api/ssh/connections/observations` stays empty.

## runner-ssh-013

- Vitest: "official Runner SSH authority > allows an ordinary owner and preserves a pinned connection"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host enabled by default.
- When: The official Runner calls `POST /api/runners/runs/:runId/ssh/resolve`, pins the host key via `POST /api/runners/runs/:runId/ssh/pin`, and resolves again.
- Then: Both resolves return `resolved` and the pin returns `pinned`. The owner's host list shows the pinned host key, and the second resolve performs two secret decryptions.

## runner-ssh-014

- Vitest: "official Runner SSH authority > only delivers the exact current credential to the winning official process"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host for `ssh.example.com` as `deploy` with a private key and passphrase.
- When: The official Runner calls `POST /api/runners/runs/:runId/ssh/resolve` for the host with its exact Runner identity.
- Then: The response is exactly `{ outcome: "resolved", host: "ssh.example.com", port: 22, username: "deploy", generation: 1, learnedHostKey: null, privateKey, passphrase }` after two decryptions, with `Cache-Control: no-store`. The owner's `GET /api/ssh/connections` contains no secret material.

## runner-ssh-015

- Vitest: "official Runner SSH authority > rejects unauthenticated, session, guest and local Runner credentials before decryption"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host; another user holds a CLI personal access token.
- When: `POST /api/runners/runs/:runId/ssh/resolve` is sent with no authorization, a wrong official secret, a Clerk session and the run's sandbox token; `POST /api/runners/runs/:runId/ssh/pin` is sent with the CLI token.
- Then: The four resolves return HTTP 401 and the CLI-token pin returns HTTP 403. No secrets are decrypted and the host has no learned host key.

## runner-ssh-016

- Vitest: "official Runner SSH authority > returns indistinguishable unavailable for wrong claims and hidden or missing connections"
- Mode: run
- Given: A chat user has a dispatched chat run on an official Runner and an SSH host enabled by default; a foreign owner has their own run and host; the same user under another organization owns a hidden host.
- When: The official Runner calls `POST /api/runners/runs/:runId/ssh/resolve` with a random connection ID, the foreign connection, another Runner ID, heartbeat generation 8, and a random run ID; and calls `POST /api/runners/runs/:runId/ssh/pin` for the foreign and hidden connections; it also resolves the hidden connection.
- Then: Every resolve and pin returns exactly `{ outcome: "unavailable" }`, no secrets are decrypted, and the foreign host keeps no learned host key.

## runner-ssh-017

- Vitest: "official Runner SSH authority > denies a pending Run and each real terminal state without decrypting credentials"
- Mode: run
- Given: A chat user has an SSH host enabled by default and starts a pending run plus runs that end `completed`, `cancelled` and `failed` on an official Runner.
- When: The official Runner calls `POST /api/runners/runs/:runId/ssh/resolve` and `POST /api/runners/runs/:runId/ssh/pin` for the pending run and for each terminal run.
- Then: Every call returns `{ outcome: "unavailable" }` and no secrets are decrypted.

## runner-ssh-018

- Vitest: "official Runner SSH authority > checks current chat access and credential existence on every call"
- Mode: run
- Given: An owner has an SSH host enabled by default and an event-automation run dispatched to an official Runner.
- When: The owner disables the host default via `PUT /api/remote-access/hosts/ssh/:connectionId/default`; the Runner resolves and pins; the owner re-enables it and deletes the host via `DELETE /api/ssh/connections/:connectionId`; the Runner resolves and pins again.
- Then: Resolve and pin return `{ outcome: "unavailable" }` both while disabled and after deletion, and no secrets are decrypted.

## runner-ssh-019

- Vitest: "official Runner SSH authority > reflects credential rotation and deletion without a cached admission"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host.
- When: The Runner pins the host key via `POST /api/runners/runs/:runId/ssh/pin`; the owner rotates the credential to `new-user` via `PATCH /api/ssh/connections/:connectionId`; the Runner resolves and pins with generation 1; the owner deletes the host; the Runner resolves and pins again.
- Then: The first pin returns `{ outcome: "pinned", generation: 2 }`. After rotation resolve returns generation 3, `new-user`, `rotated-key`, null passphrase and the learned host key, and the stale pin returns `configuration_changed`. After deletion resolve and pin return `unavailable` without decryption.

## runner-ssh-020

- Vitest: "official Runner SSH authority > pins exactly once for concurrent equal observations and only accepts expected plus one"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host at generation 1.
- When: The Runner sends three concurrent identical `POST /api/runners/runs/:runId/ssh/pin` requests with generation 1, then pins with expected generations 2 and 3.
- Then: Exactly one pin returns `pinned` and two return `matched`, with a single `ssh:changed` publication. Generations 2 and 3 return `configuration_changed`. No secrets are decrypted and the host shows generation 2 with the pinned host key.

## runner-ssh-021

- Vitest: "official Runner SSH authority > never overwrites trust when concurrent first observations disagree"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an unpinned SSH host.
- When: The Runner sends two concurrent `POST /api/runners/runs/:runId/ssh/pin` requests with different observed host keys, then pins the losing key with expected generation 999.
- Then: One returns `pinned` and the other `host_key_mismatch`. The host shows generation 2 with the winning key, and the losing key later returns `host_key_mismatch`.

## runner-ssh-022

- Vitest: "official Runner SSH authority > rejects stale endpoint edits and resets instead of silently repinning"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host at generation 1.
- When: The owner changes the host to `new.example.com` via `PATCH /api/ssh/connections/:connectionId`; the Runner pins with generations 1 and 2 via `POST /api/runners/runs/:runId/ssh/pin`; the owner resets the host key via `POST /api/ssh/connections/:connectionId/reset-host-key` with generation 3; the Runner pins with generations 2, 4 and 2 again.
- Then: The generation-1 pin after the edit returns `configuration_changed` and generation 2 returns `{ outcome: "pinned", generation: 3 }`. After the reset, generation 2 returns `configuration_changed`, generation 4 returns `{ outcome: "pinned", generation: 5 }`, and generation 2 again returns `configuration_changed`. The host shows generation 5 with the pinned host key.

## runner-ssh-023

- Vitest: "official Runner SSH authority > rejects malformed or extra authority fields before sensitive work"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an unpinned SSH host.
- When: The official Runner calls `POST /api/runners/runs/:runId/ssh/resolve` with an extra `host`, an extra `command`, an extra `userId`, and heartbeat generation 0, and calls `POST /api/runners/runs/:runId/ssh/pin` with an `ssh-dss` host key and a bad fingerprint.
- Then: Every request returns HTTP 400, no secrets are decrypted, and the host keeps no learned host key.

## runner-ssh-024

- Vitest: "official Runner SSH authority > surfaces KMS failure and does not pin as a side effect of resolving"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host; the secret KMS rejects decryption.
- When: The official Runner calls `POST /api/runners/runs/:runId/ssh/resolve`.
- Then: The response is HTTP 500 and the host keeps no learned host key.

## runner-ssh-025

- Vitest: "official Runner SSH authority > does not hold authorization locks across KMS or pretend to claw back an in-flight handoff"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host enabled by default; the secret KMS holds the first decryption.
- When: While the first `POST /api/runners/runs/:runId/ssh/resolve` is in flight, the owner disables the host for the thread via `PUT /api/chat-threads/:threadId/remote-access/ssh/:connectionId` and the Runner resolves again; then KMS releases the first decryption and the Runner pins.
- Then: The override succeeds and the second resolve returns `{ outcome: "unavailable" }` while the first is pending. The in-flight resolve completes as `resolved` with the private key, and the subsequent pin returns `{ outcome: "unavailable" }`.

## runner-ssh-026

- Vitest: "concurrent winning-Runner pins publish exactly one trust generation"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an unpinned SSH host at generation 1.
- When: The Runner sends two concurrent `POST /api/runners/runs/:runId/ssh/pin` requests with the same host key.
- Then: One returns `pinned` and the other `matched`, each with generation 2. The listed host equals its previous state except generation 2, the learned host key and `updatedAt`.

## runner-ssh-027

- Vitest: "overlapping winning-Runner observations retain the newest clock without changing Host metadata"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH host.
- When: The Runner concurrently posts `POST /api/runners/runs/:runId/ssh/observations` with an older authentication failure and a newer healthy observation; the owner reads `GET /api/ssh/connections/observations` and `GET /api/ssh/connections`.
- Then: The older observation returns `recorded` or `ignored` and the newer returns `recorded`. Observations contain exactly the newer healthy entry with generation 1 and a null failure reason, and the host list is unchanged.

## runner-ssh-028

- Vitest: "ssh override insert revocation preserves metadata and refuses the winning Runner"
- Mode: run
- Given: Row `insert`: a Pro owner has a running chat run on an official Runner and an SSH host enabled by default with no thread override.
- When: The owner disables the host for the thread via `PUT /api/chat-threads/:threadId/remote-access/ssh/:connectionId`; the Runner then resolves, pins and observes an authentication failure.
- Then: Resolve, pin and observation all return `{ outcome: "unavailable" }`, no secrets are decrypted, and the host list is unchanged.

## runner-ssh-029

- Vitest: "ssh override replace revocation preserves metadata and refuses the winning Runner"
- Mode: run
- Given: Row `replace`: a Pro owner has a running chat run on an official Runner and an SSH host whose default is disabled but whose thread override enables it.
- When: The owner replaces the thread override with `enabled: false` via `PUT /api/chat-threads/:threadId/remote-access/ssh/:connectionId`; the Runner then resolves, pins and observes an authentication failure.
- Then: Resolve, pin and observation all return `{ outcome: "unavailable" }`, no secrets are decrypted, and the host list is unchanged.

## runner-ssh-030

- Vitest: "ssh override remove revocation preserves metadata and refuses the winning Runner"
- Mode: run
- Given: Row `remove`: a Pro owner has a running chat run on an official Runner and an SSH host whose default is disabled but whose thread override enables it.
- When: The owner removes the thread override via `DELETE /api/chat-threads/:threadId/remote-access/ssh/:connectionId`; the Runner then resolves, pins and observes an authentication failure.
- Then: Resolve, pin and observation all return `{ outcome: "unavailable" }`, no secrets are decrypted, and the host list is unchanged.
