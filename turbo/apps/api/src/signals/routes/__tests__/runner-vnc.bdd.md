# runner-vnc

## runner-vnc-001

- Vitest: "private Runner VNC authority > rejects native snapshots and failure reasons for a Direct VNC route"
- Mode: run
- Given: The clock is 2026-10-14T00:00:30Z. A Pro owner has a running chat run on an official Runner and a direct VNC desktop enabled by default.
- When: The official Runner posts `POST /api/runners/runs/:runId/vnc/observations` with Cloudflare Access and Tailscale expected transports and KDC transports, then with failure reasons `access_rejected`, `access_tls_failure`, `access_protocol_failure`, `origin_tls_failure` and `tailscale_unavailable`, then a plain direct authentication failure.
- Then: Every native-transport and native-failure observation returns `{ outcome: "ignored" }` and `GET /api/vnc/connections/observations` stays empty; the plain direct observation returns `recorded`.

## runner-vnc-002

- Vitest: "private Runner VNC authority > records bounded owner evidence, recovers and ignores reordered, duplicate and future VNC observations"
- Mode: run
- Given: The clock is 2026-10-14T00:00:30Z. A Pro owner has a running chat run on an official Runner and a direct VNC desktop enabled by default.
- When: The official Runner posts `POST /api/runners/runs/:runId/vnc/observations` with an authentication failure at 00:00:00, one at 00:03:00 (future), one from another Runner ID and one from the next heartbeat generation, then concurrent network failure at 00:00:10 and recovery at 00:00:20, then replays; the owner reads `GET /api/vnc/connections/observations`.
- Then: Observations start empty; the first failure is `recorded` and listed with generation 1 and the creation time (with `Cache-Control: no-store`). The future observation is `ignored`, and the wrong Runner ID and generation return `unavailable`. After the concurrent pair the list holds only the 00:00:20 recovery with a null failure reason. Replays of the original failure and of 00:00:20 are `ignored`, leaving the failure reason null.

## runner-vnc-003

- Vitest: "private Runner VNC authority > isolates VNC observations by owner, configuration generation and deletion"
- Mode: run
- Given: The clock is 2026-10-14T00:00:30Z. Two Pro owners each have a running chat run on an official Runner and a direct VNC desktop enabled by default.
- When: The first owner's Runner records an observation; the second owner's run observes the first owner's connection; the first owner renames the desktop via `PATCH /api/vnc/connections/:connectionId`; the Runner observes at generations 1 and 2; the owner deletes it via `DELETE /api/vnc/connections/:connectionId`; the Runner observes at generation 2.
- Then: The first observation is `recorded` while the other owner's observations stay empty, and the cross-owner observation returns `unavailable`. After the rename observations are empty, generation 1 is `ignored` and generation 2 is `recorded` with generation 2. After deletion observations are empty and the observation returns `unavailable`.

## runner-vnc-004

- Vitest: "private Runner VNC authority > ignores delayed evidence when a deleted VNC ID is recreated"
- Mode: run
- Given: The clock is 2026-10-14T00:00:30Z. A Pro owner has a running chat run on an official Runner and a direct VNC desktop enabled by default.
- When: The Runner resolves via `POST /api/runners/runs/:runId/vnc/resolve` and records a failure; the owner deletes and recreates the desktop with the same ID on a new host and re-enables it; the Runner observes a delayed failure, a recovery bound to the new creation time at 00:00:05, and a failure at 00:00:20 bound to the old creation time.
- Then: The resolve carries `x-vnc-connection-created-at` equal to the microsecond-precision creation time and the failure is `recorded`. The recreated desktop has generation 1 and a different creation time, and observations are empty. The delayed failure is `ignored`; the recovery is `recorded`; the stale failure is `ignored`. Observations list only the recovery with the new creation time, generation 1 and null failure reason.

## runner-vnc-005

- Vitest: "private Runner VNC authority > rejects secret-bearing and non-connection observation payloads without reflecting their values"
- Mode: run
- Given: The clock is 2026-10-14T00:00:30Z. A Pro owner has a running chat run on an official Runner and a direct VNC desktop enabled by default.
- When: The official Runner posts `POST /api/runners/runs/:runId/vnc/observations` with failure reasons `sensitive-secret-provider-error`, `cancelled` and `stale_geometry`, and with an extra `password` field.
- Then: Each request returns HTTP 400 without echoing the sensitive value, and observations stay empty.

## runner-vnc-006

- Vitest: "private Runner VNC authority > hides old rfb carrier evidence and accepts its successor despite clock skew"
- Mode: run
- Given: Row `rfb`: the clock is 2026-10-14T00:00:30Z. A Pro owner has a running chat run on an official Runner, a VNC desktop, and an SSH gateway enabled by default; the owner switches the desktop to the SSH transport (generation 2).
- When: The Runner records a failure bound to the SSH carrier generation 1 at 00:00:20; the owner changes the SSH gateway host via `PATCH /api/ssh/connections/:connectionId`; the Runner replays the old binding, then observes a recovery at 00:00:10 bound to carrier generation 2.
- Then: The first observation is `recorded` (one entry). After the gateway edit the desktop remains generation 2, its observations are hidden (empty), and the old-carrier observation is `ignored`. The successor recovery at the earlier clock is `recorded` and listed with generation 2 and a null failure reason.

## runner-vnc-007

- Vitest: "private Runner VNC authority > hides old kdc carrier evidence and accepts its successor despite clock skew"
- Mode: run
- Given: Row `kdc`: the clock is 2026-10-14T00:00:30Z. A Pro owner has a running chat run on an official Runner, a VNC desktop, and an SSH gateway enabled by default; the owner switches the desktop to QEMU X.509 GSSAPI with a KDC reached over the SSH gateway and a Kerberos password credential (generation 2).
- When: The Runner records a failure bound to credential revision 1 and KDC carrier generation 1 at 00:00:20; the owner changes the SSH gateway host via `PATCH /api/ssh/connections/:connectionId`; the Runner replays the old binding, then observes a recovery at 00:00:10 bound to KDC carrier generation 2.
- Then: The first observation is `recorded` (one entry). After the gateway edit the desktop remains generation 2, its observations are hidden (empty), and the old-carrier observation is `ignored`. The successor recovery at the earlier clock is `recorded` and listed with generation 2 and a null failure reason.

## runner-vnc-008

- Vitest: "private Runner VNC authority > checks current membership and chat access before recording or handing off VNC authority"
- Mode: run
- Given: The clock is 2026-10-14T00:00:30Z. A Pro owner has a running chat run on an official Runner and a direct VNC desktop.
- When: The owner disables the desktop default and the Runner observes; the owner re-enables it and the Runner resolves; then the identity provider reports the owner has no organization memberships, and the Runner observes, resolves via `POST /api/runners/runs/:runId/vnc/resolve` and checks via `POST /api/runners/runs/:runId/vnc/check`.
- Then: While disabled the observation returns `unavailable` and observations stay empty. After membership is lost, observe, resolve and check all return `{ outcome: "unavailable" }` without decrypting secrets.

## runner-vnc-009

- Vitest: "private Runner VNC authority > admits exact online Kerberos capabilities before KMS and independently fences source revision and KDC route"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a VNC desktop, updated to QEMU X.509 GSSAPI with a direct KDC and a `qemu_kerberos_password` credential (generation 2).
- When: The official Runner resolves with the default profile list, then with the exact Kerberos password profile; checks via `POST /api/runners/runs/:runId/vnc/check` without and with the credential revision and KDC transport; the owner rotates the credential password via `PATCH /api/vnc/credentials/:credentialId`; the Runner checks again.
- Then: The default-profile resolve returns `unsupported_profile` with no decryption. The exact profile returns `resolved_kerberos` with generation 2, credential revision 1, the initiator and password, and a direct KDC transport after one decryption. A check without the binding returns `configuration_changed`, with it `valid`; after rotation it returns `configuration_changed`, with still one decryption in total.

## runner-vnc-010

- Vitest: "private Runner VNC authority > independently authorizes and fences qemu_kerberos_password / direct RFB / direct KDC routes"
- Mode: run
- Given: Row `qemu_kerberos_password / direct RFB / direct KDC`: a Pro owner has a running chat run on an official Runner and a VNC desktop enabled by default, plus two SSH gateways (RFB and KDC) not enabled by default. The owner updates the desktop to QEMU X.509 GSSAPI directly to `desktop.example.com` with a direct KDC and a Kerberos password credential (generation 2).
- When: The official Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the exact `qemu_kerberos_password` profile (direct transport, direct KDC transport) and with the opposite KDC transport type, and `POST /api/runners/runs/:runId/vnc/check` with the expected transports and credential revision 1.
- Then: The mismatched KDC transport profile returns `unsupported_profile` without decryption. The exact profile returns `resolved_kerberos` with the expected transport, credential revision 1, the saved authentication and KDC transport, and check returns `valid` after exactly one decryption.

## runner-vnc-011

- Vitest: "private Runner VNC authority > independently authorizes and fences qemu_kerberos_password / direct RFB / ssh KDC routes"
- Mode: run
- Given: Row `qemu_kerberos_password / direct RFB / ssh KDC`: a Pro owner has a running chat run on an official Runner and a VNC desktop enabled by default, plus two SSH gateways (RFB and KDC) not enabled by default. The owner updates the desktop to QEMU X.509 GSSAPI directly to `desktop.example.com` with a KDC reached through the KDC SSH gateway and a Kerberos password credential (generation 2).
- When: The official Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the exact `qemu_kerberos_password` profile (direct transport, ssh KDC transport) and with the opposite KDC transport type, and `POST /api/runners/runs/:runId/vnc/check` with the expected transports and credential revision 1; the owner enables the KDC gateway for the run, then for each SSH route disables and re-enables the gateway default and renames the gateway via `PATCH /api/ssh/connections/:connectionId`.
- Then: Before the SSH gateways are enabled, resolve returns `unavailable` without decrypting. The mismatched KDC transport profile returns `unsupported_profile` without decryption. The exact profile returns `resolved_kerberos` with the expected transport, credential revision 1, the saved authentication and KDC transport, and check returns `valid` after exactly one decryption. Disabling a gateway makes check and resolve `unavailable` without further decryption; re-enabling restores `valid`. A check naming the other gateway, or the renamed gateway's old generation 1, returns `configuration_changed`, while generation 2 returns `valid`.

## runner-vnc-012

- Vitest: "private Runner VNC authority > independently authorizes and fences qemu_kerberos_password / ssh RFB / direct KDC routes"
- Mode: run
- Given: Row `qemu_kerberos_password / ssh RFB / direct KDC`: a Pro owner has a running chat run on an official Runner and a VNC desktop enabled by default, plus two SSH gateways (RFB and KDC) not enabled by default. The owner updates the desktop to QEMU X.509 GSSAPI through the RFB SSH gateway to `127.0.0.1` with a direct KDC and a Kerberos password credential (generation 2).
- When: The official Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the exact `qemu_kerberos_password` profile (ssh transport, direct KDC transport) and with the opposite KDC transport type, and `POST /api/runners/runs/:runId/vnc/check` with the expected transports and credential revision 1; the owner enables the RFB gateway for the run, then for each SSH route disables and re-enables the gateway default and renames the gateway via `PATCH /api/ssh/connections/:connectionId`.
- Then: Before the SSH gateways are enabled, resolve returns `unavailable` without decrypting. The mismatched KDC transport profile returns `unsupported_profile` without decryption. The exact profile returns `resolved_kerberos` with the expected transport, credential revision 1, the saved authentication and KDC transport, and check returns `valid` after exactly one decryption. Disabling a gateway makes check and resolve `unavailable` without further decryption; re-enabling restores `valid`. A check naming the other gateway, or the renamed gateway's old generation 1, returns `configuration_changed`, while generation 2 returns `valid`.

## runner-vnc-013

- Vitest: "private Runner VNC authority > independently authorizes and fences qemu_kerberos_password / ssh RFB / ssh KDC routes"
- Mode: run
- Given: Row `qemu_kerberos_password / ssh RFB / ssh KDC`: a Pro owner has a running chat run on an official Runner and a VNC desktop enabled by default, plus two SSH gateways (RFB and KDC) not enabled by default. The owner updates the desktop to QEMU X.509 GSSAPI through the RFB SSH gateway to `127.0.0.1` with a KDC reached through the KDC SSH gateway and a Kerberos password credential (generation 2).
- When: The official Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the exact `qemu_kerberos_password` profile (ssh transport, ssh KDC transport) and with the opposite KDC transport type, and `POST /api/runners/runs/:runId/vnc/check` with the expected transports and credential revision 1; the owner enables the RFB and KDC gateways for the run, then for each SSH route disables and re-enables the gateway default and renames the gateway via `PATCH /api/ssh/connections/:connectionId`.
- Then: Before the SSH gateways are enabled, resolve returns `unavailable` without decrypting. The mismatched KDC transport profile returns `unsupported_profile` without decryption. The exact profile returns `resolved_kerberos` with the expected transport, credential revision 1, the saved authentication and KDC transport, and check returns `valid` after exactly one decryption. Disabling a gateway makes check and resolve `unavailable` without further decryption; re-enabling restores `valid`. A check naming the other gateway, or the renamed gateway's old generation 1, returns `configuration_changed`, while generation 2 returns `valid`.

## runner-vnc-014

- Vitest: "private Runner VNC authority > independently authorizes and fences qemu_kerberos_keytab / direct RFB / direct KDC routes"
- Mode: run
- Given: Row `qemu_kerberos_keytab / direct RFB / direct KDC`: a Pro owner has a running chat run on an official Runner and a VNC desktop enabled by default, plus two SSH gateways (RFB and KDC) not enabled by default. The owner updates the desktop to QEMU X.509 GSSAPI directly to `desktop.example.com` with a direct KDC and a Kerberos keytab credential (generation 2).
- When: The official Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the exact `qemu_kerberos_keytab` profile (direct transport, direct KDC transport) and with the opposite KDC transport type, and `POST /api/runners/runs/:runId/vnc/check` with the expected transports and credential revision 1.
- Then: The mismatched KDC transport profile returns `unsupported_profile` without decryption. The exact profile returns `resolved_kerberos` with the expected transport, credential revision 1, the saved authentication and KDC transport, and check returns `valid` after exactly one decryption.

## runner-vnc-015

- Vitest: "private Runner VNC authority > independently authorizes and fences qemu_kerberos_keytab / direct RFB / ssh KDC routes"
- Mode: run
- Given: Row `qemu_kerberos_keytab / direct RFB / ssh KDC`: a Pro owner has a running chat run on an official Runner and a VNC desktop enabled by default, plus two SSH gateways (RFB and KDC) not enabled by default. The owner updates the desktop to QEMU X.509 GSSAPI directly to `desktop.example.com` with a KDC reached through the KDC SSH gateway and a Kerberos keytab credential (generation 2).
- When: The official Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the exact `qemu_kerberos_keytab` profile (direct transport, ssh KDC transport) and with the opposite KDC transport type, and `POST /api/runners/runs/:runId/vnc/check` with the expected transports and credential revision 1; the owner enables the KDC gateway for the run, then for each SSH route disables and re-enables the gateway default and renames the gateway via `PATCH /api/ssh/connections/:connectionId`.
- Then: Before the SSH gateways are enabled, resolve returns `unavailable` without decrypting. The mismatched KDC transport profile returns `unsupported_profile` without decryption. The exact profile returns `resolved_kerberos` with the expected transport, credential revision 1, the saved authentication and KDC transport, and check returns `valid` after exactly one decryption. Disabling a gateway makes check and resolve `unavailable` without further decryption; re-enabling restores `valid`. A check naming the other gateway, or the renamed gateway's old generation 1, returns `configuration_changed`, while generation 2 returns `valid`.

## runner-vnc-016

- Vitest: "private Runner VNC authority > independently authorizes and fences qemu_kerberos_keytab / ssh RFB / direct KDC routes"
- Mode: run
- Given: Row `qemu_kerberos_keytab / ssh RFB / direct KDC`: a Pro owner has a running chat run on an official Runner and a VNC desktop enabled by default, plus two SSH gateways (RFB and KDC) not enabled by default. The owner updates the desktop to QEMU X.509 GSSAPI through the RFB SSH gateway to `127.0.0.1` with a direct KDC and a Kerberos keytab credential (generation 2).
- When: The official Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the exact `qemu_kerberos_keytab` profile (ssh transport, direct KDC transport) and with the opposite KDC transport type, and `POST /api/runners/runs/:runId/vnc/check` with the expected transports and credential revision 1; the owner enables the RFB gateway for the run, then for each SSH route disables and re-enables the gateway default and renames the gateway via `PATCH /api/ssh/connections/:connectionId`.
- Then: Before the SSH gateways are enabled, resolve returns `unavailable` without decrypting. The mismatched KDC transport profile returns `unsupported_profile` without decryption. The exact profile returns `resolved_kerberos` with the expected transport, credential revision 1, the saved authentication and KDC transport, and check returns `valid` after exactly one decryption. Disabling a gateway makes check and resolve `unavailable` without further decryption; re-enabling restores `valid`. A check naming the other gateway, or the renamed gateway's old generation 1, returns `configuration_changed`, while generation 2 returns `valid`.

## runner-vnc-017

- Vitest: "private Runner VNC authority > independently authorizes and fences qemu_kerberos_keytab / ssh RFB / ssh KDC routes"
- Mode: run
- Given: Row `qemu_kerberos_keytab / ssh RFB / ssh KDC`: a Pro owner has a running chat run on an official Runner and a VNC desktop enabled by default, plus two SSH gateways (RFB and KDC) not enabled by default. The owner updates the desktop to QEMU X.509 GSSAPI through the RFB SSH gateway to `127.0.0.1` with a KDC reached through the KDC SSH gateway and a Kerberos keytab credential (generation 2).
- When: The official Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the exact `qemu_kerberos_keytab` profile (ssh transport, ssh KDC transport) and with the opposite KDC transport type, and `POST /api/runners/runs/:runId/vnc/check` with the expected transports and credential revision 1; the owner enables the RFB and KDC gateways for the run, then for each SSH route disables and re-enables the gateway default and renames the gateway via `PATCH /api/ssh/connections/:connectionId`.
- Then: Before the SSH gateways are enabled, resolve returns `unavailable` without decrypting. The mismatched KDC transport profile returns `unsupported_profile` without decryption. The exact profile returns `resolved_kerberos` with the expected transport, credential revision 1, the saved authentication and KDC transport, and check returns `valid` after exactly one decryption. Disabling a gateway makes check and resolve `unavailable` without further decryption; re-enabling restores `valid`. A check naming the other gateway, or the renamed gateway's old generation 1, returns `configuration_changed`, while generation 2 returns `valid`.

## runner-vnc-018

- Vitest: "private Runner VNC authority > admits an offline ticket through direct without a KDC and refuses expiry before KMS"
- Mode: run
- Given: Row `direct`: the clock is at 200 seconds. A Pro owner has a running chat run on an official Runner and a VNC desktop updated to QEMU X.509 GSSAPI reached directly, with an offline `qemu_kerberos_ticket` credential (service ticket cache) and no KDC.
- When: The official Runner resolves via `POST /api/runners/runs/:runId/vnc/resolve` with the exact ticket profile (KDC transport `none`) and checks via `POST /api/runners/runs/:runId/vnc/check`; the clock advances to 1,000 seconds and it resolves and checks again; the clock returns to 200 seconds and the ticket expires while the KMS decryption is in flight.
- Then: The first resolve returns `resolved_kerberos` with the ticket authentication, no KDC and a direct transport, and check returns `valid` after one decryption. After expiry, resolve and check return `unavailable` without further decryption. When expiry happens during decryption, resolve returns `unavailable` after one decryption and check returns `unavailable`.

## runner-vnc-019

- Vitest: "private Runner VNC authority > admits an offline ticket through ssh without a KDC and refuses expiry before KMS"
- Mode: run
- Given: Row `ssh`: the clock is at 200 seconds. A Pro owner has a running chat run on an official Runner and a VNC desktop updated to QEMU X.509 GSSAPI at `127.0.0.1` through an SSH gateway (enabled by default), with an offline `qemu_kerberos_ticket` credential and no KDC.
- When: The official Runner resolves via `POST /api/runners/runs/:runId/vnc/resolve` with the exact ticket profile (SSH transport, KDC transport `none`) and checks via `POST /api/runners/runs/:runId/vnc/check`; the clock advances to 1,000 seconds and it resolves and checks again; the clock returns to 200 seconds and the ticket expires while the KMS decryption is in flight.
- Then: The first resolve returns `resolved_kerberos` with the ticket authentication, no KDC and the SSH transport at gateway generation 1, and check returns `valid` after one decryption. After expiry, resolve and check return `unavailable` without further decryption. When expiry happens during decryption, resolve returns `unavailable` after one decryption and check returns `unavailable`.

## runner-vnc-020

- Vitest: "private Runner VNC authority > uses current chat VNC and exact SSH dependency access during an active Run"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a direct VNC desktop not enabled by default.
- When: The owner toggles the VNC default and thread override via `PUT /api/remote-access/hosts/vnc/:connectionId/default` and `PUT`/`DELETE /api/chat-threads/:threadId/remote-access/vnc/:connectionId`, moves the desktop behind a new SSH gateway, enables the gateway default, then disables the gateway for the thread; the official Runner resolves and checks between steps.
- Then: Resolve is `unavailable` while disabled, `resolved_transport` with check `valid` once enabled, and `unavailable` (check `unavailable`) when the thread override disables it. After moving behind the gateway, resolve is `unavailable` until the gateway default is enabled, then `resolved_transport`. Disabling the gateway for the thread makes resolve and the generation-2 check `unavailable`.

## runner-vnc-021

- Vitest: "private Runner VNC authority > rejects a delayed stale credential rotation without changing shared hosts or the Runner secret"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a VNC desktop, plus a "Shared desktop" using the same saved VNC password credential; KMS encryption for the next write is held.
- When: The owner sends a password rotation via `PATCH /api/vnc/credentials/:credentialId` with `expectedRevision: 1`, and while it is held renames the credential with `expectedRevision: 1`; then the held rotation finishes.
- Then: The rename returns HTTP 200 with revision 2. The delayed rotation returns HTTP 409 `VNC_CREDENTIAL_REVISION_CONFLICT`. The credential and host lists equal those read right after the rename, and the Runner still resolves the original password at generation 1.

## runner-vnc-022

- Vitest: "private Runner VNC authority > returns the exact Direct snapshot and secret only in the no-store Runner handoff"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a direct VNC desktop with a VNC password.
- When: The official Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the X.509 VNC password profiles, the owner lists `GET /api/vnc/connections`, and the Runner checks via `POST /api/runners/runs/:runId/vnc/check` with the direct transport and with a random SSH transport.
- Then: The resolve has `Cache-Control: no-store` and returns exactly `resolved_transport` with host `vnc.example.com`, port 5900, generation 1, server name, direct transport, the VNC password and the X.509 VNC security. The owner's list does not contain the password. The direct check returns `valid`; the SSH-transport check returns `configuration_changed`.

## runner-vnc-023

- Vitest: "private Runner VNC authority > requires an exact X509None capability and resolves without decrypting a credential"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a direct VNC desktop updated to `x509_none` security with no credential (generation 2).
- When: The official Runner resolves with the default profile list, checks generation 1, resolves with the exact `none`/`x509_none`/direct profile, and checks generation 2.
- Then: The default-profile resolve returns `unsupported_profile` and the generation-1 check `configuration_changed`. The exact profile returns `resolved_transport` with authentication `none`, `x509_none` system-trust security and generation 2, without any decryption, and the generation-2 check is `valid`.

## runner-vnc-024

- Vitest: "private Runner VNC authority > requires exact client_certificate capability before KMS and hands identity only to the Runner"
- Mode: run
- Given: Row `client_certificate`: a Pro owner has a running chat run on an official Runner and a new direct mTLS QEMU desktop with `x509_none` security and a client certificate chain and private key credential, enabled by default.
- When: The official Runner resolves via `POST /api/runners/runs/:runId/vnc/resolve` with the default profile list, then with the exact `client_certificate`/`x509_none`/direct profile; the owner lists `GET /api/vnc/connections`; the Runner checks generation 1.
- Then: The default list returns `unsupported_profile` with no decryption. The exact profile returns `resolved_transport` with method `client_certificate`, a DER certificate chain and PKCS#8 private key and `x509_none` security after one decryption. The owner's list contains neither the private key nor `privateKeyPkcs8Der`, and the check is `valid`.

## runner-vnc-025

- Vitest: "private Runner VNC authority > requires exact client_certificate_vnc_password capability before KMS and hands identity only to the Runner"
- Mode: run
- Given: Row `client_certificate_vnc_password`: a Pro owner has a running chat run on an official Runner and a new direct mTLS QEMU desktop with `x509_vnc` security and a client certificate, private key and VNC password credential, enabled by default.
- When: The official Runner resolves via `POST /api/runners/runs/:runId/vnc/resolve` with the default profile list, then with the exact `client_certificate_vnc_password`/`x509_vnc`/direct profile; the owner lists `GET /api/vnc/connections`; the Runner checks generation 1.
- Then: The default list returns `unsupported_profile` with no decryption. The exact profile returns `resolved_transport` with the DER certificate chain, PKCS#8 private key and the password and `x509_vnc` security after two decryptions. The owner's list contains neither the private key nor `privateKeyPkcs8Der`, and the check is `valid`.

## runner-vnc-026

- Vitest: "private Runner VNC authority > requires independent SSH access and the exact certificate/SSH tuple before decrypting a client key"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner, an SSH gateway not enabled by default, and a tunnelled QEMU desktop at `127.0.0.1` over that gateway with `x509_none` security and a client certificate credential, enabled by default.
- When: The official Runner resolves with the exact `client_certificate`/`x509_none`/ssh profile; the owner enables the gateway default; the Runner resolves with the direct-transport variant and then the exact SSH profile.
- Then: Before the gateway is enabled resolve returns `unavailable`; the direct variant returns `unsupported_profile`; neither decrypts. The exact SSH profile returns `resolved_transport` with the PKCS#8 private key and the SSH transport for the gateway after one decryption.

## runner-vnc-027

- Vitest: "private Runner VNC authority > requires the SSH-specific X509None capability and independent SSH authority"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a VNC desktop moved behind a new SSH gateway (not enabled by default) with `x509_none` security and no credential.
- When: The official Runner resolves with the `none`/`x509_none`/ssh profile; the owner enables the gateway default; the Runner resolves with the direct variant and with the SSH profile.
- Then: Before the gateway is enabled resolve returns `unavailable`. The direct variant returns `unsupported_profile`. The SSH profile returns `resolved_transport` with authentication `none`, `x509_none` security, the gateway transport and generation 2. No secrets are decrypted.

## runner-vnc-028

- Vitest: "private Runner VNC authority > rejects wrong auth classes and exact winning-process mismatches before KMS"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a resolvable direct VNC desktop; another user holds a CLI personal access token.
- When: `POST /api/runners/runs/:runId/vnc/resolve` and `POST /api/runners/runs/:runId/vnc/check` are sent with no authorization, a wrong official secret, a Clerk session and the sandbox token; then with the CLI token; then with the official secret using a random connection ID, another Runner ID, heartbeat generation 7, and a random run ID.
- Then: The four bad credentials return HTTP 401 with `Cache-Control: no-store` on both routes; the CLI token returns HTTP 403 on both. Each wrong connection, Runner identity or run returns `{ outcome: "unavailable" }` for resolve and check. No secrets are decrypted.

## runner-vnc-029

- Vitest: "private Runner VNC authority > keeps cross-owner connections opaque"
- Mode: run
- Given: Two Pro owners each have a running chat run on an official Runner and their own direct VNC desktop.
- When: The first owner's Runner resolves and checks the other owner's connection ID via `POST /api/runners/runs/:runId/vnc/resolve` and `.../vnc/check`.
- Then: Both return `{ outcome: "unavailable" }` and no secrets are decrypted.

## runner-vnc-030

- Vitest: "private Runner VNC authority > reports unsupported exact profiles before decrypting and rejects injected authority fields"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a direct VNC desktop.
- When: The official Runner resolves via `POST /api/runners/runs/:runId/vnc/resolve` with an empty profile list, then with an injected `host`, `userId`, or `authentication` field.
- Then: The empty list returns `{ outcome: "unsupported_profile" }`. Each injected-field request returns HTTP 400 without echoing the injected value, and no secrets are decrypted.

## runner-vnc-031

- Vitest: "private Runner VNC authority > requires both chat host permissions and binds SSH-backed handoff and checks to the exact SSH generation"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a VNC desktop moved behind an SSH gateway (server name `desktop.internal`, generation 2); the gateway default is then disabled.
- When: The Runner resolves and checks while the gateway is disabled; the owner re-enables it; the Runner resolves with direct-only profiles and then all profiles, checks with the exact and mismatched transports; while a resolve's decryption is held the owner renames the gateway via `PATCH /api/ssh/connections/:connectionId`; the Runner checks and resolves again; the owner disables the gateway and the Runner checks.
- Then: While disabled resolve and check are `unavailable` with no decryption; direct-only profiles return `unsupported_profile`. The full resolve returns exactly host `vnc.example.com`, port 5900, generation 2, server name `desktop.internal`, SSH transport at gateway generation 1, the VNC password and security, with no SSH key material; check is `valid` for that transport and `configuration_changed` for direct, another gateway ID or gateway generation 2. The rename returns generation 2, the held resolve returns `unavailable`, the old-generation check is `configuration_changed`, and a new resolve returns gateway generation 2. After disabling the gateway the check is `unavailable`.

## runner-vnc-032

- Vitest: "private Runner VNC authority > resolves QEMU SCRAM only for the exact Runner capability, before and after rotation"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a new direct QEMU desktop with `qemu_x509_sasl` security and a `qemu_scram_sha256` credential (`operator`), enabled by default.
- When: The Runner resolves with the default profiles, an `x509_plain` profile, an SSH SCRAM profile, and the exact direct SCRAM profile, then checks; the owner rotates the password via `PATCH /api/vnc/credentials/:credentialId`; the Runner checks and resolves; the owner moves the desktop behind an enabled SSH gateway at `127.0.0.1`; the Runner resolves with direct and SSH SCRAM profiles; the owner disables the gateway and the Runner resolves.
- Then: The three mismatched profiles return `unsupported_profile` without decryption. The exact profile returns exactly `resolved_transport` for `qemu.example.com:5900`, generation 1, direct transport, the SCRAM username and password and system-trust `qemu_x509_sasl` security after one decryption; check is `valid`. Rotation returns revision 2 without echoing the password, the generation-1 check is `configuration_changed`, and resolve returns generation 2 with `new-secret`. After the move (generation 3) the direct profile is `unsupported_profile` and the SSH profile resolves `127.0.0.1`, `qemu.internal`, gateway generation 1 and `new-secret`; with the gateway disabled it is `unavailable`.

## runner-vnc-033

- Vitest: "private Runner VNC authority > admits Mac classic password only for an exact authorized SSH loopback profile"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH gateway to `mac.example.com` enabled by default.
- When: The owner creates Apple classic VNC password desktops via `POST /api/vnc/connections` with host `localhost`, with a direct transport, with mismatched `apple_dh` security, and with `127.0.0.1` over the gateway; the Runner resolves with default and wrong profiles, with the exact profile while the gateway is disabled and enabled, and checks; the owner rotates the password and tries to change the host to `localhost`; then disables the gateway.
- Then: `localhost` and direct routes return HTTP 400 `VNC_INVALID_APPLE_VNC_PASSWORD_ROUTE` and `apple_dh` returns `VNC_PROFILE_MISMATCH`; the loopback desktop is created without echoing the password. Default and `x509_vnc` profiles return `unsupported_profile` and the disabled gateway returns `unavailable`, without decryption. With the gateway enabled resolve returns exactly `resolved_apple_vnc_password` for `127.0.0.1:5900`, generation 1, gateway generation 1 and the password after one decryption; check is `valid`. After rotation the check is `configuration_changed` and resolve returns generation 2 with the rotated password. The host change returns HTTP 400 `VNC_INVALID_APPLE_VNC_PASSWORD_ROUTE`; with the gateway disabled the check is `unavailable`.

## runner-vnc-034

- Vitest: "private Runner VNC authority > admits Apple DH only for an authorized SSH-to-Mac-loopback profile"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH gateway to `mac.example.com` enabled by default.
- When: The owner creates Apple DH desktops via `POST /api/vnc/connections` with a direct transport, with host `mac.example.com`, and with `127.0.0.1` over the gateway; the Runner resolves with the default profiles, with the exact `apple_dh_username_password` SSH profile while the gateway is disabled and enabled, and checks; the owner rotates the password via `PATCH /api/vnc/credentials/:credentialId`; then disables the gateway.
- Then: The direct route returns HTTP 400 `VNC_INVALID_HOST` and the non-loopback host `VNC_INVALID_APPLE_DH_ROUTE`; the loopback desktop is saved with security `apple_dh`. Default profiles return `unsupported_profile` and the disabled gateway `unavailable`, with no decryption. With the gateway enabled resolve returns exactly `resolved_apple_dh` for `127.0.0.1:5900`, generation 1, gateway generation 1 and the username and password after one decryption; check is `valid`. Rotation returns revision 2 with method and username but not the password; the old check is `configuration_changed` and resolve returns generation 2 with `new-secret`. With the gateway disabled the check is `unavailable`.

## runner-vnc-035

- Vitest: "private Runner VNC authority > admits Apple SRP only for an authorized SSH-to-Mac-loopback profile"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH gateway to `mac.example.com` enabled by default.
- When: The owner creates Apple SRP desktops with host `localhost`, with mismatched `apple_dh` security, and with `127.0.0.1` over the gateway; the Runner resolves with default and exact `apple_srp_username_password` SSH profiles while the gateway is disabled and enabled, and checks; the owner tries to change the host to `localhost` or security to `apple_dh`, rotates the password, then rebinds the desktop to a second enabled gateway; finally disables that gateway.
- Then: `localhost` returns HTTP 400 `VNC_INVALID_APPLE_SRP_ROUTE` and `apple_dh` returns `VNC_PROFILE_MISMATCH`; the loopback desktop is saved with `apple_srp`. Default profiles return `unsupported_profile` and the disabled gateway `unavailable` without decryption; with it enabled resolve returns exactly `resolved_apple_srp` for `127.0.0.1:5900`, generation 1 and the credentials after one decryption, and check is `valid`. The rejected edits return the same error codes and leave the check `valid`. Rotation returns revision 2 without the password, the old check becomes `configuration_changed` and resolve returns generation 2 with `new-secret`. The rebind returns generation 3 with the new gateway; the generation-2 check is `configuration_changed`, resolve returns generation 3 with the new gateway, and disabling that gateway makes the check `unavailable`.

## runner-vnc-036

- Vitest: "private Runner VNC authority > admits Apple RSA/SRP only for a matching saved SSH loopback and exact Runner capability"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and an SSH gateway to `mac.example.com` enabled by default.
- When: The owner creates Apple RSA/SRP desktops with host `localhost`, host `mac.example.com`, a direct transport, mismatched `apple_dh` and `apple_srp` security, and `127.0.0.1` over the gateway; the Runner resolves with default, Apple SRP and exact `apple_rsa_srp_username_password` SSH profiles while the gateway is disabled and enabled, and checks; the owner tries to change the host to `localhost` and rotates the password.
- Then: `localhost` and `mac.example.com` return HTTP 400 `VNC_INVALID_APPLE_RSA_SRP_ROUTE`, direct returns `VNC_INVALID_HOST`, and both mismatched securities return `VNC_PROFILE_MISMATCH`. Default and Apple SRP profiles return `unsupported_profile` and the disabled gateway `unavailable`, without decryption. With the gateway enabled resolve returns exactly `resolved_apple_rsa_srp` for `127.0.0.1:5900`, generation 1, gateway generation 1 and the credentials after one decryption; check is `valid`. The host edit returns `VNC_INVALID_APPLE_RSA_SRP_ROUTE`. Rotation does not echo the password; the old check becomes `configuration_changed` and resolve returns generation 2 with `new-secret`.

## runner-vnc-037

- Vitest: "private Runner VNC authority > rejects X509Plain for an old Runner before KMS and resolves it for a capable Runner"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and creates a direct "Plain desktop" with `x509_plain` security and a username/password credential, enabled by default.
- When: The official Runner resolves it with only X.509 VNC password profiles (an old Runner), then with the full profile list, then checks its generation.
- Then: The old-Runner resolve returns `unsupported_profile` with no decryption. The full list returns exactly `resolved_transport` for `plain.example.com:5900`, generation 1, direct transport, the username and password and system-trust `x509_plain` security after one decryption; check is `valid`.

## runner-vnc-038

- Vitest: "private Runner VNC authority > rejects pending and real terminal Runs before decrypting VNC credentials"
- Mode: run
- Given: A chat user has a direct VNC desktop enabled by default and a dispatched run on an official Runner that resolves it; the user starts a further pending run and runs that end `completed`, `cancelled` and `failed`.
- When: The official Runner calls `POST /api/runners/runs/:runId/vnc/resolve` and `POST /api/runners/runs/:runId/vnc/check` for the pending run and for each terminal run.
- Then: Every call returns `{ outcome: "unavailable" }` and no secrets are decrypted.

## runner-vnc-039

- Vitest: "private Runner VNC authority > authorizes independent Runs concurrently without reserving the connection or decrypting on checks"
- Mode: run
- Given: A Pro owner has two running chat runs dispatched to official Runners and a direct VNC desktop enabled by default.
- When: Both Runners resolve the desktop concurrently via `POST /api/runners/runs/:runId/vnc/resolve`, then check concurrently via `POST /api/runners/runs/:runId/vnc/check`.
- Then: Both resolves return the same generation. Both checks return `{ outcome: "valid" }` with `Cache-Control: no-store`, and checks decrypt no secrets.

## runner-vnc-040

- Vitest: "private Runner VNC authority > preserves a rejected profile edit and checks generation through rotation, deletion and recreation"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a direct VNC desktop with a VNC password credential that resolves at generation 1.
- When: The owner tries to change the credential to `client_certificate_vnc_password` via `PATCH /api/vnc/credentials/:credentialId`, then rotates the VNC password; deletes the desktop; recreates it with the same ID and a new password and re-enables it; the Runner resolves and checks generations 1 and 2 between steps.
- Then: The profile change returns HTTP 400 `VNC_PROFILE_MISMATCH`, resolve is unchanged and generation 1 checks `valid`. After rotation resolve returns generation 2; generation 1 checks `configuration_changed` and generation 2 `valid`. After deletion generation 2 checks `unavailable`. The recreated desktop resolves at generation 1 with the replacement password; generation 1 checks `valid` and generation 2 `configuration_changed`.

## runner-vnc-041

- Vitest: "private Runner VNC authority > surfaces KMS failure as a sanitized error"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a direct VNC desktop; the secret KMS rejects decryption with an error containing a canary string.
- When: The official Runner calls `POST /api/runners/runs/:runId/vnc/resolve`.
- Then: The response is HTTP 500 with `Cache-Control: no-store`, and the body contains neither the KMS error text nor the VNC password.

## runner-vnc-042

- Vitest: "private Runner VNC authority > allows rotation while KMS is pending and discards the old secret handoff"
- Mode: run
- Given: A Pro owner has a running chat run on an official Runner and a direct VNC desktop; the secret KMS holds the first decryption.
- When: While a `POST /api/runners/runs/:runId/vnc/resolve` is in flight, the owner rotates the VNC password via `PATCH /api/vnc/credentials/:credentialId`; then decryption completes and the Runner resolves again.
- Then: The rotation returns HTTP 200, the in-flight resolve returns `{ outcome: "unavailable" }`, and the next resolve returns the rotated password at generation 2.

## runner-vnc-043

- Vitest: "private Runner VNC authority > discards an in-flight direct VNC password when its Run is cancelled before KMS returns"
- Mode: run
- Given: Two Pro owners each have a running chat run on an official Runner and a direct VNC desktop; the secret KMS holds the first decryption.
- When: While the first owner's `POST /api/runners/runs/:runId/vnc/resolve` is in flight, the owner cancels the run via `POST /api/runs/:id/cancel`; then decryption completes, the Runner checks generation 1, and the peer's Runner resolves its own desktop.
- Then: The cancel returns HTTP 200 with status `cancelled`. The in-flight resolve returns `{ outcome: "unavailable" }` and the check returns `unavailable`. The peer's resolve returns `resolved_transport`.
