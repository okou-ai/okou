# vnc-configuration

## vnc-configuration-001

- Vitest: "explicit Owner Kerberos sources > rejects unavailable cloudflare_access RFB and KDC bindings before encryption without changing saved data"
- Mode: run
- Given: A signed-in workspace admin has one saved VNC host with a VNC password credential. Parameter row `cloudflare_access`: candidate configurations use a `cloudflare_access` transport with an unknown config ID (port 443), either for the RFB connection itself or for a Kerberos (`qemu_x509_gssapi`) KDC.
- When: The admin posts each candidate to `POST /api/vnc/connections` and applies it to the saved host via `PATCH /api/vnc/connections/:connectionId`.
- Then: All four requests return HTTP 404. The host list still equals exactly the original host, there is still one saved credential, no new data keys are generated and nothing is decrypted.

## vnc-configuration-002

- Vitest: "explicit Owner Kerberos sources > rejects unavailable tailscale RFB and KDC bindings before encryption without changing saved data"
- Mode: run
- Given: A signed-in workspace admin has one saved VNC host with a VNC password credential. Parameter row `tailscale`: candidate configurations use a `tailscale` transport with an unknown config ID (RFB port 5900, KDC port 88), either for the RFB connection itself or for a Kerberos (`qemu_x509_gssapi`) KDC.
- When: The admin posts each candidate to `POST /api/vnc/connections` and applies it to the saved host via `PATCH /api/vnc/connections/:connectionId`.
- Then: All four requests return HTTP 404. The host list still equals exactly the original host, there is still one saved credential, no new data keys are generated and nothing is decrypted.

## vnc-configuration-003

- Vitest: "explicit Owner Kerberos sources > selects one concurrent Kerberos rebind using a saved credential without orphaning the loser"
- Mode: run
- Given: A signed-in admin has a Kerberos VNC host (`qemu_kerberos_password`, `qemu_x509_gssapi` with a direct KDC). Parameter row `saved`: the admin saves two new Kerberos password credentials via `POST /api/vnc/credentials`, one per candidate.
- When: The admin concurrently sends two `PATCH /api/vnc/connections/:connectionId` rebinds at the current generation, each with a different service principal and selecting one of the saved credentials by ID.
- Then: One rebind returns HTTP 200 at generation 2 and the other HTTP 409 with `VNC_GENERATION_CONFLICT`. The host list equals exactly the winner. Three credentials exist, and only the winner's credential lists the host as bound.

## vnc-configuration-004

- Vitest: "explicit Owner Kerberos sources > selects one concurrent Kerberos rebind using a inline credential without orphaning the loser"
- Mode: run
- Given: A signed-in admin has a Kerberos VNC host (`qemu_kerberos_password`, `qemu_x509_gssapi` with a direct KDC). Parameter row `inline`: each candidate creates a new Kerberos password credential inline.
- When: The admin concurrently sends two `PATCH /api/vnc/connections/:connectionId` rebinds at the current generation, each with a different service principal and its own inline credential.
- Then: One rebind returns HTTP 200 at generation 2 and the other HTTP 409 with `VNC_GENERATION_CONFLICT`. The host list equals exactly the winner. Two credentials exist (the original and the winner's, no orphan from the loser), and only the winner's credential lists the host as bound.

## vnc-configuration-005

- Vitest: "explicit Owner Kerberos sources > keeps public Kerberos readback complete and metadata-only"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin creates a Kerberos VNC host with an inline `qemu_kerberos_password` credential and `qemu_x509_gssapi` security via `POST /api/vnc/connections`, then lists `GET /api/vnc/connections` and `GET /api/vnc/credentials`.
- Then: The created host reports `kerberosAuthentication: "qemu_kerberos_password"` and the full submitted security profile, and the host list equals exactly the created host. One credential is listed with `authMethod: "qemu_kerberos_password"` and the initiator principal. No response contains the Kerberos password, and exactly one data key is generated.

## vnc-configuration-006

- Vitest: "explicit Owner Kerberos sources > refuses mismatched realm bindings before encryption or an orphan credential"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin creates a Kerberos VNC host via `POST /api/vnc/connections` whose service principal realm `OTHER.INVALID` differs from the initiator realm `EXAMPLE.INVALID`.
- Then: The response is HTTP 400 with `VNC_PROFILE_MISMATCH`, no data key is generated, and the credential list is empty.

## vnc-configuration-007

- Vitest: "explicit Owner Kerberos sources > refuses an online source without an independently saved KDC policy"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin creates a VNC host with an inline Kerberos password credential and `qemu_x509_gssapi` security that has no KDC configuration via `POST /api/vnc/connections`.
- Then: The response is HTTP 400 with `VNC_PROFILE_MISMATCH` and no data key is generated.

## vnc-configuration-008

- Vitest: "explicit Owner Kerberos sources > rejects malformed FILE material before KMS using a generic credential error"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin creates a `qemu_kerberos_ticket` credential with the malformed ticket cache `AAAA` via `POST /api/vnc/credentials`.
- Then: The response is HTTP 400 with `VNC_INVALID_INPUT`, the body does not echo `AAAA`, and no data key is generated.

## vnc-configuration-009

- Vitest: "explicit Owner Kerberos sources > rotates the same source and fences principal changes without encrypting them"
- Mode: run
- Given: A signed-in admin has a Kerberos VNC host with an inline Kerberos password credential for initiator `alice`.
- When: The admin rotates the password via `PATCH /api/vnc/credentials/:credentialId` at revision 1, lists hosts, then sends another rotation at revision 2 that changes the initiator to `bob`.
- Then: The rotation returns HTTP 200 at revision 2 and the bound host moves to generation 2. The principal change returns HTTP 400 with `VNC_PROFILE_MISMATCH`. Exactly two data keys are generated in total (creation and the accepted rotation).

## vnc-configuration-010

- Vitest: "VNC owner configuration > rebinds inline vnc_password with x509_vnc and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `vnc_password` (a VNC password) with security `x509_vnc`, connecting directly to `rebound.example.com`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `x509_vnc` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `x509_vnc` and generation 2; the host list equals exactly that host, and the only credential has auth method `vnc_password`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 still bound to the same credential and security. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-011

- Vitest: "VNC owner configuration > rebinds inline username_password with x509_plain and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `username_password` (a username `operator` and password) with security `x509_plain`, connecting directly to `rebound.example.com`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `x509_plain` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `x509_plain` and generation 2; the host list equals exactly that host, and the only credential has auth method `username_password`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 still bound to the same credential and security. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-012

- Vitest: "VNC owner configuration > rebinds inline qemu_scram_sha256 with qemu_x509_sasl and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `qemu_scram_sha256` (a username `operator` and password) with security `qemu_x509_sasl`, connecting directly to `rebound.example.com`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `qemu_x509_sasl` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `qemu_x509_sasl` and generation 2; the host list equals exactly that host, and the only credential has auth method `qemu_scram_sha256`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 still bound to the same credential and security. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-013

- Vitest: "VNC owner configuration > rebinds inline client_certificate with x509_none and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `client_certificate` (a client certificate chain and private key) with security `x509_none`, connecting directly to `rebound.example.com`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `x509_none` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `x509_none` and generation 2; the host list equals exactly that host, and the only credential has auth method `client_certificate`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 with `credential: { type: "none" }`, the same security and no `credentialId`, and the credential remains at revision 1 with no bound hosts. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-014

- Vitest: "VNC owner configuration > rebinds inline client_certificate_vnc_password with x509_vnc and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `client_certificate_vnc_password` (a client certificate chain, private key and VNC password) with security `x509_vnc`, connecting directly to `rebound.example.com`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `x509_vnc` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `x509_vnc` and generation 2; the host list equals exactly that host, and the only credential has auth method `client_certificate_vnc_password`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 still bound to the same credential and security. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-015

- Vitest: "VNC owner configuration > rebinds inline rsa_aes_password with rsa_aes_ra2 and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `rsa_aes_password` (a password, with a pinned server key) with security `rsa_aes_ra2`, connecting directly to `rebound.example.com`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `rsa_aes_ra2` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `rsa_aes_ra2` and generation 2; the host list equals exactly that host, and the only credential has auth method `rsa_aes_password`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 still bound to the same credential and security. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-016

- Vitest: "VNC owner configuration > rebinds inline rsa_aes_username_password with rsa_aes_ra2_256 and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `rsa_aes_username_password` (a username `operator` and password, with a pinned server key) with security `rsa_aes_ra2_256`, connecting directly to `rebound.example.com`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `rsa_aes_ra2_256` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `rsa_aes_ra2_256` and generation 2; the host list equals exactly that host, and the only credential has auth method `rsa_aes_username_password`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 still bound to the same credential and security. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-017

- Vitest: "VNC owner configuration > rebinds inline rsa_aes_password with rsa_aes_ra2ne and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `rsa_aes_password` (a password, with a pinned server key) with security `rsa_aes_ra2ne`, connecting through an SSH tunnel; the admin creates the SSH connection via `POST /api/ssh/connections` and the host is set to `127.0.0.1`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `rsa_aes_ra2ne` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `rsa_aes_ra2ne` and generation 2; the host list equals exactly that host, and the only credential has auth method `rsa_aes_password`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 still bound to the same credential and security. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-018

- Vitest: "VNC owner configuration > rebinds inline rsa_aes_username_password with rsa_aes_ra2ne_256 and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `rsa_aes_username_password` (a username `operator` and password, with a pinned server key) with security `rsa_aes_ra2ne_256`, connecting through an SSH tunnel; the admin creates the SSH connection via `POST /api/ssh/connections` and the host is set to `127.0.0.1`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `rsa_aes_ra2ne_256` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `rsa_aes_ra2ne_256` and generation 2; the host list equals exactly that host, and the only credential has auth method `rsa_aes_username_password`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 still bound to the same credential and security. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-019

- Vitest: "VNC owner configuration > rebinds inline vnc_password with apple_vnc_password and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `vnc_password` (a VNC password) with security `apple_vnc_password`, connecting through an SSH tunnel; the admin creates the SSH connection via `POST /api/ssh/connections` and the host is set to `127.0.0.1`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `apple_vnc_password` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `apple_vnc_password` and generation 2; the host list equals exactly that host, and the only credential has auth method `vnc_password`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 still bound to the same credential and security. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-020

- Vitest: "VNC owner configuration > rebinds inline apple_dh_username_password with apple_dh and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `apple_dh_username_password` (a username `operator` and password) with security `apple_dh`, connecting through an SSH tunnel; the admin creates the SSH connection via `POST /api/ssh/connections` and the host is set to `127.0.0.1`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `apple_dh` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `apple_dh` and generation 2; the host list equals exactly that host, and the only credential has auth method `apple_dh_username_password`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 still bound to the same credential and security. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-021

- Vitest: "VNC owner configuration > rebinds inline apple_srp_username_password with apple_srp and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `apple_srp_username_password` (the username `操作员` and a password) with security `apple_srp`, connecting through an SSH tunnel; the admin creates the SSH connection via `POST /api/ssh/connections` and the host is set to `127.0.0.1`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `apple_srp` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `apple_srp` and generation 2; the host list equals exactly that host, and the only credential has auth method `apple_srp_username_password`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 still bound to the same credential and security. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-022

- Vitest: "VNC owner configuration > rebinds inline apple_rsa_srp_username_password with apple_rsa_srp and returns persisted metadata"
- Mode: run
- Given: A signed-in workspace admin has a VNC host "Initial desktop" with `x509_none` security and no credential. Parameter row: authentication `apple_rsa_srp_username_password` (the username `操作员` and a password) with security `apple_rsa_srp`, connecting through an SSH tunnel; the admin creates the SSH connection via `POST /api/ssh/connections` and the host is set to `127.0.0.1`.
- When: The admin rebinds the host via `PATCH /api/vnc/connections/:connectionId` at generation 1 with display name "Rebound 桌面", port 5901, security `apple_rsa_srp` and an inline credential named "新 credential", lists hosts and credentials, then renames the host at generation 2.
- Then: The rebind returns HTTP 200 with the same host ID and `createdAt`, the new name, port 5901, the new credential ID and name, security `apple_rsa_srp` and generation 2; the host list equals exactly that host, and the only credential has auth method `apple_rsa_srp_username_password`, revision 1 and the host bound. The rename returns HTTP 200 at generation 3 still bound to the same credential and security. No response contains encrypted fields, the private key or a `"password":` field.

## vnc-configuration-023

- Vitest: "VNC owner configuration > requires session and current membership before exposing configuration"
- Mode: run
- Given: An unauthenticated caller, and then a signed-in user whose organization membership lookup returns no memberships.
- When: The unauthenticated caller lists `GET /api/vnc/credentials`; the non-member lists `GET /api/vnc/credentials` and creates a host via `POST /api/vnc/connections`.
- Then: The unauthenticated request returns HTTP 401. Both non-member requests return HTTP 404, and no data key is generated.

## vnc-configuration-024

- Vitest: "VNC owner configuration > returns secret-free metadata, shared references and an accurate summary"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin creates a VNC password credential named " Shared " via `POST /api/vnc/credentials`, creates two hosts `VNC.EXAMPLE.COM.` and `192.0.2.5` referencing it, reads `GET /api/vnc/connections/summary` and `GET /api/vnc/credentials`, tries to delete the credential, deletes both hosts, deletes the credential and lists credentials again.
- Then: The credential is created with trimmed name "Shared", `vnc_password`, revision 1 and no hosts. Each host creation returns HTTP 201 with `cache-control: no-store`; the first host is normalized to `vnc.example.com`, port 5900, `x509_vnc` system-trust security and no `transport` field. The summary is `{ configuredCount: 2 }`. The credential list (also `no-store`) shows `vnc_password` and both hosts. No response contains the password, a `"password":` field, `encryptedPassword` or `vm0secret:`. Deleting the referenced credential returns HTTP 409; host deletions return HTTP 204, the credential deletion then returns HTTP 204, and the list is empty.

## vnc-configuration-025

- Vitest: "VNC owner configuration > stores two exact client-certificate pairs without changing certificate-free X509None"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin saves a `client_certificate` credential and binds it to an `x509_none` host, saves a `client_certificate_vnc_password` credential and binds it to an `x509_vnc` host, lists credentials and hosts, tries to bind the certificate-and-password credential to an `x509_none` host via `POST /api/vnc/connections`, and rotates the certificate-only credential via `PATCH /api/vnc/credentials/:credentialId`.
- Then: The certificate-only credential is `client_certificate` at revision 1. The first host reports that credential ID, `clientCertificateAuthentication: "client_certificate"`, `x509_none` and generation 1, with no `credential` field; the second reports `client_certificate_vnc_password` and `x509_vnc`. No response contains the private key, `privateKey`, `encryptedClientIdentity` or the password, and exactly three data keys are generated. The downgrade binding returns HTTP 400. The rotation returns revision 2 and the first listed host moves to generation 2.

## vnc-configuration-026

- Vitest: "VNC owner configuration > rejects a malformed or mismatched client identity before KMS"
- Mode: run
- Given: A signed-in workspace admin and an unrelated EC private key.
- When: For both `client_certificate` and `client_certificate_vnc_password`, the admin posts `POST /api/vnc/credentials` with an invalid key, a mismatched key, a chain with trailing garbage, an oversized chain, a doubled key, or an encrypted private key; then, with the clock at 2037-01-01, posts a certificate credential; then creates a host via `POST /api/vnc/connections` with an inline certificate credential whose key is invalid.
- Then: Every credential request returns HTTP 400 without echoing the unrelated key. The expired-certificate credential returns HTTP 400. The inline host creation returns HTTP 400 with `VNC_INVALID_CLIENT_IDENTITY`. No data key is generated.

## vnc-configuration-027

- Vitest: "VNC owner configuration > persists explicitly selected X509None without a credential and requires explicit rebinds"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin creates "No VNC password" with `x509_none` security and `credential: { type: "none" }`, lists hosts and credentials, tries to create an `x509_none` host with a password credential, tries `PATCH /api/vnc/connections/:connectionId` switching to `x509_vnc` without a credential, then rebinds to `x509_vnc` with an inline password credential, and finally rebinds back to `x509_none` with no credential.
- Then: The host is created at generation 1 with `x509_none`, `credential: { type: "none" }` and no `credentialId`; the host list equals that host and the credential list is empty. The password-with-`x509_none` creation and the silent security switch each return HTTP 400. The explicit rebind returns HTTP 200 at generation 2 with `x509_vnc` and a credential ID. Rebinding back returns HTTP 200 at generation 3 with `x509_none`, no credential and no `credentialId`, while one saved credential remains.

## vnc-configuration-028

- Vitest: "VNC owner configuration > persists typed SSH routes, certificate identity and restrictive deletion"
- Mode: run
- Given: A signed-in workspace admin has an SSH connection "VNC gateway". Another user of the same workspace also exists.
- When: The admin posts direct VNC hosts at `127.0.0.1`, `0:0:0:0:0:0:0:1` and `::ffff:192.168.1.8`; creates a host at `127.0.0.1` tunneled through the SSH connection with server name `DESKTOP.Internal.Example.`; the other user creates a host using the admin's SSH connection; the admin tries to delete the SSH connection, renames the host, switches it to a direct transport at `public.example.com`, clears the server name, and finally deletes the SSH connection.
- Then: The private direct hosts each return HTTP 400 with `VNC_INVALID_HOST`. The tunneled host returns HTTP 201 at generation 1 with the SSH transport and normalized server name `desktop.internal.example`, and the host list equals it. The other user receives HTTP 404 with `VNC_SSH_CONNECTION_NOT_FOUND` and has no saved credentials. Deleting the referenced SSH connection returns HTTP 409 with `SSH_CONNECTION_IN_USE`. The rename moves to generation 2 keeping the SSH transport; the direct switch moves to generation 3 with the new host, the kept server name and no `transport` field; clearing the identity moves to generation 4 with plain `x509_vnc` security. The final SSH deletion returns HTTP 204.

## vnc-configuration-029

- Vitest: "VNC owner configuration > rejects non-ASCII and oversized passwords without truncating or echoing them"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin posts `POST /api/vnc/credentials` with VNC passwords `123456789` (9 characters), `秘密`, `x` plus newline, `x` plus tab, DEL, and `é`, then with a password of eight spaces.
- Then: Each invalid password returns HTTP 400 with `VNC_INVALID_INPUT` and no data key is generated. The eight-space password returns HTTP 201.

## vnc-configuration-030

- Vitest: "VNC owner configuration > bounds Apple DH credential fields before encryption and returns no password"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin posts `apple_dh_username_password` credentials via `POST /api/vnc/credentials` with a 32-character `é` username, a 32-character `é` password, a username containing NUL, and a password containing NUL; then with a username of 31 `é` plus `x` and a 63-character password.
- Then: The four invalid requests return HTTP 400 with `VNC_INVALID_INPUT` and no data key is generated. The bounded credential returns HTTP 201 with `authMethod: "apple_dh_username_password"` and the username, and does not contain the password.

## vnc-configuration-031

- Vitest: "VNC owner configuration > bounds Apple SRP UTF-8 credentials before encryption and returns no password"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin posts `apple_srp_username_password` credentials via `POST /api/vnc/credentials` with a 128-character `é` username, a 512-character `é` password, a username containing NUL, and a password containing NUL; then with a username of 127 `é` plus `x` and a 1023-character password.
- Then: The four invalid requests return HTTP 400 with `VNC_INVALID_INPUT` and no data key is generated. The bounded credential returns HTTP 201 with `authMethod: "apple_srp_username_password"` and the username, and does not contain the password.

## vnc-configuration-032

- Vitest: "VNC owner configuration > bounds Apple RSA/SRP credentials at 234 UTF-8 bytes before encryption"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin posts `apple_rsa_srp_username_password` credentials via `POST /api/vnc/credentials` with a 118-character `é` username, a 512-character `é` password, a username containing NUL, and a password containing NUL; then with a 117-character `é` username and a 1023-character password.
- Then: The four invalid requests return HTTP 400 with `VNC_INVALID_INPUT` and no data key is generated. The bounded credential returns HTTP 201 with `authMethod: "apple_rsa_srp_username_password"` and the username, and does not contain the password.

## vnc-configuration-033

- Vitest: "VNC owner configuration > rejects unsupported authentication and security profiles without changing saved configuration"
- Mode: run
- Given: A signed-in admin has one saved VNC host with a VNC password credential.
- When: The admin uses authentication method `none` to create a credential, create a host with an inline credential, and update the saved credential; and uses security `none`, `tls_vnc` and `x509_vnc` with `insecure` trust to create a host and update the saved host.
- Then: Every request returns HTTP 400. The host list still equals exactly the saved host and the credential list is unchanged.

## vnc-configuration-034

- Vitest: "VNC owner configuration > stores only the exact QEMU SCRAM credential and verified-X509 pair without leaking secrets"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin posts `qemu_scram_sha256` credentials via `POST /api/vnc/credentials` with usernames containing a space, comma or `=`, a non-ASCII or 256-character username, or passwords containing NUL, non-ASCII or 1024 characters; then saves a valid credential with a 1023-character space-padded password; tries to bind it to hosts with `x509_plain`, `x509_vnc` and `x509_none` security; binds it with `qemu_x509_sasl`; lists credentials and hosts; and rotates the password at revision 1.
- Then: All invalid credentials return HTTP 400 with no data key generated. The valid credential returns HTTP 201 with `qemu_scram_sha256`, username `operator` and revision 1. The three mismatched bindings return HTTP 400; the `qemu_x509_sasl` binding returns HTTP 201 with the credential ID, the security profile and generation 1. No response contains the password or `encryptedPassword`. The rotation returns revision 2 without the new password, and exactly two data keys are generated.

## vnc-configuration-035

- Vitest: "VNC owner configuration > models username/password credentials and enforces exact profile pairs"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin posts `username_password` credentials with NUL or overlong (128 `é`) usernames or NUL or overlong (512 `é`) passwords; saves a valid one (127 `é` plus `a`, 1023 spaces); binds it to an `x509_plain` host; tries an inline username/password host with `x509_vnc`, the saved credential with `x509_vnc`, and an inline VNC password with `x509_plain`; tries to change the credential to `vnc_password` and the host to `x509_vnc`; then saves a VNC password credential, rebinds the host to it with `x509_vnc`, and changes the now-unreferenced credential to `vnc_password`.
- Then: The invalid credentials return HTTP 400 with `VNC_INVALID_INPUT` and no data key is generated. The valid credential returns HTTP 201 with `username_password`, the username, revision 1, no hosts, and no password or `encryptedPassword`. The `x509_plain` host is created. The three mismatched creations, the method change and the security change each return HTTP 400 with `VNC_PROFILE_MISMATCH`. The rebind returns HTTP 200 at generation 2 with the VNC password credential and `x509_vnc`. The unreferenced credential change returns HTTP 200 with `vnc_password`, revision 2, no hosts and no `username`.

## vnc-configuration-036

- Vitest: "VNC owner configuration > validates canonical endpoints and bounded certificate-only trust"
- Mode: run
- Given: A signed-in workspace admin and a public root CA certificate.
- When: The admin posts `POST /api/vnc/connections` with malformed hosts (URL, user prefix, path, spaces, leading/trailing space, `localhost:5900`, leading hyphen, 254 characters), malformed server names, and invalid trust (insecure, a leaf certificate, a certificate with appended junk or trailing text, `system` with a CA bundle, a private key, malformed text, nine certificates, or 65,537 characters); then creates a host at `2001:0db8::1` trusting the root CA via `custom_ca`.
- Then: Each malformed host and invalid trust returns HTTP 400, and each malformed server name returns HTTP 400 with `VNC_INVALID_SERVER_NAME`. No data key is generated and the credential and host lists are empty. The valid host returns HTTP 201 with host normalized to `2001:db8::1`, security `x509_vnc` and `custom_ca` trust.

## vnc-configuration-037

- Vitest: "VNC owner configuration > isolates owners and rejects foreign creation IDs and credentials"
- Mode: run
- Given: A signed-in admin has a saved VNC credential and a host bound to it. Two other identities exist: a different user in the same organization and the same user in a different organization.
- When: Each other identity lists credentials and hosts, creates a credential reusing the first credential's ID, creates a host reusing the first host's ID, creates a host referencing the first credential, renames the first credential via `PATCH /api/vnc/credentials/:credentialId`, and deletes the first host.
- Then: For each other identity, both lists are empty, the ID-reusing creations return HTTP 409, and the foreign credential reference, the credential update and the host deletion return HTTP 404.

## vnc-configuration-038

- Vitest: "VNC owner configuration > rejects an owned connection rebind to a foreign credential sharing the orgId without changing configuration"
- Mode: run
- Given: A signed-in admin has a VNC host with its own inline credential. Parameter row `orgId`: a different user in the same organization saves a "Foreign credential".
- When: The admin rebinds the host to the foreign credential via `PATCH /api/vnc/connections/:connectionId` at generation 1, lists hosts and credentials, the peer lists its credentials, and the admin then renames the host to "Recovered" at generation 1.
- Then: The rebind returns HTTP 404 with `VNC_CREDENTIAL_NOT_FOUND`; the admin's host and credential lists are unchanged and the peer still sees exactly its credential. The rename returns HTTP 200 with the original credential ID, the new name and generation 2.

## vnc-configuration-039

- Vitest: "VNC owner configuration > rejects an owned connection rebind to a foreign credential sharing the userId without changing configuration"
- Mode: run
- Given: A signed-in admin has a VNC host with its own inline credential. Parameter row `userId`: the same user in a different organization saves a "Foreign credential".
- When: The admin rebinds the host to the foreign credential via `PATCH /api/vnc/connections/:connectionId` at generation 1, lists hosts and credentials, the other-organization identity lists its credentials, and the admin then renames the host to "Recovered" at generation 1.
- Then: The rebind returns HTTP 404 with `VNC_CREDENTIAL_NOT_FOUND`; the admin's host and credential lists are unchanged and the other identity still sees exactly its credential. The rename returns HTTP 200 with the original credential ID, the new name and generation 2.

## vnc-configuration-040

- Vitest: "VNC owner configuration > rejects an owned connection rebind to a foreign SSH route sharing the orgId without storing an inline credential"
- Mode: run
- Given: A signed-in admin has a VNC host with its own inline credential. Parameter row `orgId`: a different user in the same organization creates an SSH connection "Foreign gateway".
- When: The admin rebinds the host to `127.0.0.1` through the foreign SSH connection with a new inline password credential via `PATCH /api/vnc/connections/:connectionId`, lists hosts and credentials, the peer lists its SSH connections and VNC credentials, and the admin renames the host to "Recovered" at generation 1.
- Then: The rebind returns HTTP 404 with `VNC_SSH_CONNECTION_NOT_FOUND`; the admin's hosts and credentials are unchanged, the peer's SSH connections are unchanged and the peer has no VNC credentials. The rename returns HTTP 200 with the original credential ID and host, the new name, generation 2 and no `transport` field.

## vnc-configuration-041

- Vitest: "VNC owner configuration > rejects an owned connection rebind to a foreign SSH route sharing the userId without storing an inline credential"
- Mode: run
- Given: A signed-in admin has a VNC host with its own inline credential. Parameter row `userId`: the same user in a different organization creates an SSH connection "Foreign gateway".
- When: The admin rebinds the host to `127.0.0.1` through the foreign SSH connection with a new inline password credential via `PATCH /api/vnc/connections/:connectionId`, lists hosts and credentials, the other-organization identity lists its SSH connections and VNC credentials, and the admin renames the host to "Recovered" at generation 1.
- Then: The rebind returns HTTP 404 with `VNC_SSH_CONNECTION_NOT_FOUND`; the admin's hosts and credentials are unchanged, the other identity's SSH connections are unchanged and it has no VNC credentials. The rename returns HTTP 200 with the original credential ID and host, the new name, generation 2 and no `transport` field.

## vnc-configuration-042

- Vitest: "VNC owner configuration > makes creation retries no-ops even with changed inline secrets and metadata"
- Mode: run
- Given: A signed-in admin has created a VNC host with an inline credential.
- When: The admin retries `POST /api/vnc/connections` with the same host ID but a different name, address and inline password, then retries `POST /api/vnc/credentials` with the existing credential ID, a different name and password.
- Then: Both retries return HTTP 204. The host list still equals exactly the original host, and the single credential is unchanged.

## vnc-configuration-043

- Vitest: "VNC owner configuration > keeps configurations for one canonical endpoint independent during updates and deletion"
- Mode: run
- Given: A signed-in admin has a VNC host at `vnc.example.com` with an inline password credential.
- When: The admin creates a second host at `VNC.EXAMPLE.COM.` with its own credential and `custom_ca` trust, reads the summary, renames the second host and switches it to system trust, deletes the first host, then deletes the first host's credential.
- Then: The second host has the same normalized host and port as the first with `custom_ca` trust, and the summary is `{ configuredCount: 2 }`. The update returns generation 2 with the second credential, the new name and system-trust security, and both hosts are listed. After deleting the first host (HTTP 204), only the updated host remains. The first credential's deletion returns HTTP 204 and only the second credential remains, at revision 1 bound to "Renamed".

## vnc-configuration-044

- Vitest: "VNC owner configuration > allows a new credential creation to reuse a deleted credential ID"
- Mode: run
- Given: A signed-in admin has saved and then deleted a VNC password credential, leaving the credential list empty.
- When: The admin creates a new credential with the same ID, name "New credential" and a new password via `POST /api/vnc/credentials`.
- Then: The response is HTTP 201 with the reused ID, the new name, revision 1 and no hosts, and the credential list equals exactly the new credential.

## vnc-configuration-045

- Vitest: "VNC owner configuration > allows a new host creation to reuse a deleted host ID with a new inline credential"
- Mode: run
- Given: A signed-in admin has created a VNC host with an inline credential and then deleted both the host and the credential, leaving both lists empty.
- When: The admin creates a host with the same ID, name "New desktop" and a new inline credential "New login" via `POST /api/vnc/connections`.
- Then: The response is HTTP 201 with the reused ID, the new name and generation 1, bound to a different credential ID than before. The host list equals exactly the new host and the only credential is "New login" at revision 1.

## vnc-configuration-046

- Vitest: "VNC owner configuration > acknowledges completed creation retries during a KMS outage"
- Mode: run
- Given: A signed-in admin has created a VNC host with an inline credential, and the key management service then fails every request.
- When: The admin retries the same host creation, retries creating the existing credential ID with a new password, rotates an unknown credential ID, and rebinds an unknown host ID with an inline credential.
- Then: Both creation retries return HTTP 204, and both unknown-target updates return HTTP 404. No data key is requested and the host list still equals exactly the original host.

## vnc-configuration-047

- Vitest: "VNC owner configuration > accepts only one concurrent metadata update at the reviewed credential revision"
- Mode: run
- Given: A signed-in admin has a saved VNC password credential "Original" at revision 1.
- When: The admin concurrently sends two `PATCH /api/vnc/credentials/:credentialId` renames ("First rename", "Second rename") at revision 1.
- Then: One returns HTTP 200 at revision 2 and the other HTTP 409 with `VNC_CREDENTIAL_REVISION_CONFLICT`. The credential list equals exactly the winning credential.

## vnc-configuration-048

- Vitest: "VNC owner configuration > leaves concurrent password rotations recoverable, advances every shared host and rejects stale writes"
- Mode: run
- Given: A signed-in admin has two VNC hosts sharing one saved password credential and an independent third host with its own credential.
- When: The admin concurrently rotates the shared credential's password twice at revision 1; then sends stale writes (credential rename and delete at revision 1, and for each shared host an inline-credential rebind and a delete at generation 1); then renames the credential to "Recovered" at revision 2 and edits the first host's address at generation 2.
- Then: One rotation returns HTTP 200 and the other HTTP 409 with `VNC_CREDENTIAL_REVISION_CONFLICT`. The credential is at revision 2, both shared hosts move to generation 2, and the independent host is unchanged. Every stale write returns HTTP 409 and two credentials remain. The rename returns HTTP 200 at revision 3, and the host list differs only by the shared hosts' credential name "Recovered". The host edit returns HTTP 200 at generation 3 with host `new.example.com`.

## vnc-configuration-049

- Vitest: "VNC owner configuration > preserves the credential and every host when a compatible auth method violates the native profile pin"
- Mode: run
- Given: A signed-in admin has two `x509_vnc` VNC hosts sharing one saved VNC password credential.
- When: The admin updates the credential via `PATCH /api/vnc/credentials/:credentialId` at revision 1 with a new name and `client_certificate_vnc_password` authentication.
- Then: The response is HTTP 400 with `VNC_PROFILE_MISMATCH`, and the credential and host lists are exactly as before.

## vnc-configuration-050

- Vitest: "VNC owner configuration > publishes a delayed rotation after a public host rename and rebind while returning the earlier host snapshot"
- Mode: run
- Given: A signed-in admin has a VNC host with an inline credential and a separate saved "Replacement" credential. The key management service pauses while encrypting the next secret.
- When: The admin starts a password rotation via `PATCH /api/vnc/credentials/:credentialId` at revision 1; while encryption is paused, renames the host to "Rebound desktop" and rebinds it to the replacement credential at generation 1; then encryption resumes.
- Then: The rotation returns HTTP 200 with the original name, revision 2, `vnc_password` and the earlier host snapshot (original host ID and name). The credential list shows the rotated credential with no hosts. The host list shows the host renamed, bound to the replacement credential and name, at generation 2.

## vnc-configuration-051

- Vitest: "VNC owner configuration > keeps a newly bound host at its generation when a delayed rotation initially observed no hosts"
- Mode: run
- Given: A signed-in admin has a saved, unused VNC password credential. The key management service pauses while encrypting the next secret.
- When: The admin starts a password rotation at revision 1; while encryption is paused, creates a host bound to that credential via `POST /api/vnc/connections`; then encryption resumes.
- Then: The rotation returns HTTP 200 at revision 2 with no hosts. The single host stays bound to the credential at generation 1, and the credential list shows the rotated credential with that host bound.

## vnc-configuration-052

- Vitest: "VNC owner configuration > reports a credential deleted through the public API during encryption as missing"
- Mode: run
- Given: A signed-in admin has a saved, unused VNC password credential. The key management service pauses while encrypting the next secret.
- When: The admin starts a password rotation at revision 1; while encryption is paused, deletes the credential via `DELETE /api/vnc/credentials/:credentialId`; then encryption resumes.
- Then: The deletion returns HTTP 204, the rotation returns HTTP 404 with `VNC_CREDENTIAL_NOT_FOUND`, and the credential list is empty.

## vnc-configuration-053

- Vitest: "VNC owner configuration > rejects a concurrent creation by another owner without leaving an inline credential"
- Mode: run
- Given: Two signed-in admins in different workspaces.
- When: Both concurrently create a VNC host with an inline credential via `POST /api/vnc/connections` using the same host ID (one lowercase, one uppercase), then each lists hosts and credentials.
- Then: One creation returns HTTP 201 and the other HTTP 409 with `VNC_RESOURCE_ID_CONFLICT`. The rejected owner has no hosts and no credentials. The successful owner's host has the lowercase ID, its host list equals that host, and its only credential is "Desktop password" bound to the "Desktop" host.

## vnc-configuration-054

- Vitest: "VNC owner configuration > serializes concurrent duplicate creation and binding against credential deletion"
- Mode: run
- Given: A signed-in workspace admin.
- When: The admin concurrently sends the same host creation twice; then deletes the host and concurrently creates a new host bound to its credential while deleting that credential via `DELETE /api/vnc/credentials/:credentialId`.
- Then: The duplicate creations return HTTP 201 and HTTP 204, leaving one host and one credential, and the host deletion returns HTTP 204. The race resolves either as binding HTTP 201 with deletion HTTP 409, or as binding HTTP 404 with deletion HTTP 204.
