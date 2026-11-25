# vnc-native-publication

## vnc-native-publication-001

- Vitest: "cloudflare_access public native publication on PostgreSQL > creates both roles, retains logical config metadata and rotates a dual-role Host exactly once"
- Mode: run
- Given: A signed-in workspace admin has saved a personal Cloudflare Access configuration with private client credentials. Parameter row `cloudflare_access`: a Kerberos VNC host uses that configuration for both its RFB route and its KDC route.
- When: The admin creates the host via `POST /api/vnc/connections` (referencing the config ID in upper case), retries the creation, lists `GET /api/cloudflare-access/configs`, renames the host, rotates the configuration's credentials via `PATCH /api/cloudflare-access/configs/:configId`, reads the host and configurations again, and tries to delete the configuration via `DELETE /api/cloudflare-access/configs/:configId`.
- Then: Creation returns HTTP 201 and the retry HTTP 204 with no new data key. The configuration lists the host once with roles `rfb` and `kdc`. The rename returns HTTP 200 at the next generation with unchanged transport and security. The rotation returns HTTP 200, the host advances one more generation, and the configuration moves to the next revision and generation still listing the renamed host with both roles. The configuration list contains neither the client ID, client secret nor Kerberos password. Deleting the referenced configuration returns HTTP 409.

## vnc-native-publication-002

- Vitest: "cloudflare_access public native publication on PostgreSQL > publishes independent configurations, rebinds only KDC and preserves all credential/trust fields on a failed edit"
- Mode: run
- Given: A signed-in admin has three personal Cloudflare Access configurations (RFB, KDC and replacement). Parameter row `cloudflare_access`: a Kerberos VNC host uses the first for its RFB route and the second for its KDC route.
- When: The admin updates the host via `PATCH /api/vnc/connections/:connectionId` to an unknown cloudflare_access config ID with an inline credential, then rebinds only the KDC to the replacement configuration, and lists `GET /api/cloudflare-access/configs`.
- Then: The unknown-config edit returns HTTP 404 and leaves the host and credential list exactly unchanged. The KDC rebind returns HTTP 200 at the next generation with the original RFB transport and the replacement KDC security. The RFB configuration lists the host with role `rfb`, the original KDC configuration lists no hosts, and the replacement lists the host with role `kdc`.

## vnc-native-publication-003

- Vitest: "cloudflare_access public native publication on PostgreSQL > removes native KDC bindings when changing profile and clears the RFB reference only on an explicit route change"
- Mode: run
- Given: A signed-in admin has a personal Cloudflare Access configuration and a Kerberos VNC host that uses it for both RFB and KDC routes. Parameter row `cloudflare_access`.
- When: The admin changes the host to `x509_none` security with no credential via `PATCH /api/vnc/connections/:connectionId`, lists `GET /api/cloudflare-access/configs`, then switches the host to a direct transport at `direct.example.com:5900`, and lists configurations and VNC credentials.
- Then: The profile change returns HTTP 200 with `x509_none` security, no `kdc`, and the cloudflare_access transport kept; the configuration lists the host with role `rfb` only. After the direct switch the host has no `transport` field, the configuration lists no hosts, and the saved credential has no hosts.

## vnc-native-publication-004

- Vitest: "cloudflare_access public native publication on PostgreSQL > rejects deletion during inline credential preparation without any partial Host, config or credential publication"
- Mode: run
- Given: A signed-in admin has a personal Cloudflare Access configuration. Parameter row `cloudflare_access`: while the inline Kerberos credential for a new host is being encrypted, the admin deletes the configuration via `DELETE /api/cloudflare-access/configs/:configId`.
- When: The admin creates a Kerberos VNC host using the configuration for both roles via `POST /api/vnc/connections`.
- Then: The concurrent configuration deletion returns HTTP 204 and the host creation returns HTTP 404 after exactly one data key request. No hosts are listed, the credential list is unchanged, and no configurations remain.

## vnc-native-publication-005

- Vitest: "cloudflare_access public native publication on PostgreSQL > rejects a stale retained inline edit after rotation without orphaning its prepared credential"
- Mode: run
- Given: A signed-in admin has a personal Cloudflare Access configuration and a Kerberos VNC host using it for both roles. Parameter row `cloudflare_access`: while a new inline credential is being encrypted, the admin rotates the configuration's credentials.
- When: The admin renames the host to "Losing draft" with a new inline credential via `PATCH /api/vnc/connections/:connectionId` at the original generation.
- Then: The rotation returns HTTP 200 and the edit returns HTTP 409. Exactly three data keys are requested (one for the host credential and two for the configuration). The credential list is unchanged, and the host keeps its name and security at the next generation.

## vnc-native-publication-006

- Vitest: "cloudflare_access public native publication on PostgreSQL > keeps SSH/VNC UUID collisions distinct in shared reference accounting"
- Mode: run
- Given: A signed-in admin has an organization-scoped Cloudflare Access configuration and a Kerberos VNC host using it for both roles. Parameter row `cloudflare_access`.
- When: The admin creates an SSH connection via `POST /api/ssh/connections` with the same ID as the VNC host, routed through the same configuration, then lists `GET /api/cloudflare-access/configs` and reads the configuration's delete impact preview.
- Then: The SSH creation returns HTTP 201. The configuration lists the SSH host under `sshHosts` and the VNC host under `vncHosts` with roles `rfb` and `kdc`. The impact preview reports `ownHostCount: 2` and `otherHostCount: 0`.

## vnc-native-publication-007

- Vitest: "cloudflare_access public native publication on PostgreSQL > commits only one concurrent entering edit and its inline credential"
- Mode: run
- Given: A signed-in admin has three personal Cloudflare Access configurations and a Kerberos VNC host routed through the first. Parameter row `cloudflare_access`: encryption of new credentials waits until both edits are preparing.
- When: The admin concurrently rebinds the host's RFB route to the second and to the third configuration, each with a new inline Kerberos credential, via `PATCH /api/vnc/connections/:connectionId` at the same generation, then lists hosts, credentials and configurations.
- Then: One edit returns HTTP 200 and the other HTTP 409, with exactly two data key requests. The host advances one generation, exactly two credentials exist, and only the winning configuration lists the host with role `rfb` while the other lists none.

## vnc-native-publication-008

- Vitest: "cloudflare_access public native publication on PostgreSQL > includes a newly published dual-role Host admitted during configuration encryption"
- Mode: run
- Given: A signed-in admin has a personal Cloudflare Access configuration. Parameter row `cloudflare_access`: while the configuration's rotated credentials are being encrypted, the admin creates a Kerberos VNC host using it for both roles.
- When: The admin rotates the configuration via `PATCH /api/cloudflare-access/configs/:configId`.
- Then: The host creation returns HTTP 201. The rotation returns HTTP 200 and lists the new host with roles `rfb` and `kdc`. The host reads back at generation 2 with its transport and security unchanged.

## vnc-native-publication-009

- Vitest: "cloudflare_access public native publication on PostgreSQL > does not reveal or encrypt for another member's personal configuration"
- Mode: run
- Given: A workspace member has saved a personal Cloudflare Access configuration. Parameter row `cloudflare_access`: a different member of the same workspace is signed in.
- When: The other member creates a Kerberos VNC host referencing that configuration via `POST /api/vnc/connections`, then lists `GET /api/cloudflare-access/configs` and `GET /api/vnc/credentials`.
- Then: The creation returns HTTP 404 with no data key requested. The other member sees no configurations and no credentials.

## vnc-native-publication-010

- Vitest: "cloudflare_access public native publication on PostgreSQL > detaches both roles once after reviewed others-only deletion and requires an explicit rebind"
- Mode: run
- Given: A workspace admin has an organization-scoped Cloudflare Access configuration. Parameter row `cloudflare_access`: another member created a Kerberos VNC host using it for both roles.
- When: The admin reads the delete impact preview; the member renames the host; the admin deletes with the old preview snapshot, reads a new preview and deletes with it; the member reads the host, tries to rename it, and then rebinds it to a new personal Cloudflare Access configuration for both roles.
- Then: The first preview reports `ownHostCount: 0`, `otherHostCount: 1`, lists the member as the affected owner and omits the host name. Deletion with the stale snapshot returns HTTP 409; deletion with the current snapshot returns HTTP 204. The host is then two generations newer with both its RFB and KDC transports marked `needsRebind: true`. The rename returns HTTP 400 and leaves the host unchanged. The explicit rebind returns HTTP 200 at the next generation with the original credential and the new transport and security.

## vnc-native-publication-011

- Vitest: "tailscale public native publication on PostgreSQL > creates both roles, retains logical config metadata and rotates a dual-role Host exactly once"
- Mode: run
- Given: A signed-in workspace admin has saved a personal Tailscale configuration with private client credentials. Parameter row `tailscale`: a Kerberos VNC host uses that configuration for both its RFB route and its KDC route.
- When: The admin creates the host via `POST /api/vnc/connections` (referencing the config ID in upper case), retries the creation, lists `GET /api/tailscale/configs`, renames the host, rotates the configuration's credentials via `PATCH /api/tailscale/configs/:configId`, reads the host and configurations again, and tries to delete the configuration via `DELETE /api/tailscale/configs/:configId`.
- Then: Creation returns HTTP 201 and the retry HTTP 204 with no new data key. The configuration lists the host once with roles `rfb` and `kdc`. The rename returns HTTP 200 at the next generation with unchanged transport and security. The rotation returns HTTP 200, the host advances one more generation, and the configuration moves to the next revision and generation still listing the renamed host with both roles. The configuration list contains neither the client ID, client secret nor Kerberos password. Deleting the referenced configuration returns HTTP 409.

## vnc-native-publication-012

- Vitest: "tailscale public native publication on PostgreSQL > publishes independent configurations, rebinds only KDC and preserves all credential/trust fields on a failed edit"
- Mode: run
- Given: A signed-in admin has three personal Tailscale configurations (RFB, KDC and replacement). Parameter row `tailscale`: a Kerberos VNC host uses the first for its RFB route and the second for its KDC route.
- When: The admin updates the host via `PATCH /api/vnc/connections/:connectionId` to an unknown tailscale config ID with an inline credential, then rebinds only the KDC to the replacement configuration, and lists `GET /api/tailscale/configs`.
- Then: The unknown-config edit returns HTTP 404 and leaves the host and credential list exactly unchanged. The KDC rebind returns HTTP 200 at the next generation with the original RFB transport and the replacement KDC security. The RFB configuration lists the host with role `rfb`, the original KDC configuration lists no hosts, and the replacement lists the host with role `kdc`.

## vnc-native-publication-013

- Vitest: "tailscale public native publication on PostgreSQL > removes native KDC bindings when changing profile and clears the RFB reference only on an explicit route change"
- Mode: run
- Given: A signed-in admin has a personal Tailscale configuration and a Kerberos VNC host that uses it for both RFB and KDC routes. Parameter row `tailscale`.
- When: The admin changes the host to `x509_none` security with no credential via `PATCH /api/vnc/connections/:connectionId`, lists `GET /api/tailscale/configs`, then switches the host to a direct transport at `direct.example.com:5900`, and lists configurations and VNC credentials.
- Then: The profile change returns HTTP 200 with `x509_none` security, no `kdc`, and the tailscale transport kept; the configuration lists the host with role `rfb` only. After the direct switch the host has no `transport` field, the configuration lists no hosts, and the saved credential has no hosts.

## vnc-native-publication-014

- Vitest: "tailscale public native publication on PostgreSQL > rejects deletion during inline credential preparation without any partial Host, config or credential publication"
- Mode: run
- Given: A signed-in admin has a personal Tailscale configuration. Parameter row `tailscale`: while the inline Kerberos credential for a new host is being encrypted, the admin deletes the configuration via `DELETE /api/tailscale/configs/:configId`.
- When: The admin creates a Kerberos VNC host using the configuration for both roles via `POST /api/vnc/connections`.
- Then: The concurrent configuration deletion returns HTTP 204 and the host creation returns HTTP 404 after exactly one data key request. No hosts are listed, the credential list is unchanged, and no configurations remain.

## vnc-native-publication-015

- Vitest: "tailscale public native publication on PostgreSQL > rejects a stale retained inline edit after rotation without orphaning its prepared credential"
- Mode: run
- Given: A signed-in admin has a personal Tailscale configuration and a Kerberos VNC host using it for both roles. Parameter row `tailscale`: while a new inline credential is being encrypted, the admin rotates the configuration's credentials.
- When: The admin renames the host to "Losing draft" with a new inline credential via `PATCH /api/vnc/connections/:connectionId` at the original generation.
- Then: The rotation returns HTTP 200 and the edit returns HTTP 409. Exactly three data keys are requested (one for the host credential and two for the configuration). The credential list is unchanged, and the host keeps its name and security at the next generation.

## vnc-native-publication-016

- Vitest: "tailscale public native publication on PostgreSQL > keeps SSH/VNC UUID collisions distinct in shared reference accounting"
- Mode: run
- Given: A signed-in admin has an organization-scoped Tailscale configuration and a Kerberos VNC host using it for both roles. Parameter row `tailscale`.
- When: The admin creates an SSH connection via `POST /api/ssh/connections` with the same ID as the VNC host, routed through the same configuration, then lists `GET /api/tailscale/configs` and reads the configuration's delete impact preview.
- Then: The SSH creation returns HTTP 201. The configuration lists the SSH host under `sshHosts` and the VNC host under `vncHosts` with roles `rfb` and `kdc`. The impact preview reports `ownHostCount: 2` and `otherHostCount: 0`.

## vnc-native-publication-017

- Vitest: "tailscale public native publication on PostgreSQL > commits only one concurrent entering edit and its inline credential"
- Mode: run
- Given: A signed-in admin has three personal Tailscale configurations and a Kerberos VNC host routed through the first. Parameter row `tailscale`: encryption of new credentials waits until both edits are preparing.
- When: The admin concurrently rebinds the host's RFB route to the second and to the third configuration, each with a new inline Kerberos credential, via `PATCH /api/vnc/connections/:connectionId` at the same generation, then lists hosts, credentials and configurations.
- Then: One edit returns HTTP 200 and the other HTTP 409, with exactly two data key requests. The host advances one generation, exactly two credentials exist, and only the winning configuration lists the host with role `rfb` while the other lists none.

## vnc-native-publication-018

- Vitest: "tailscale public native publication on PostgreSQL > includes a newly published dual-role Host admitted during configuration encryption"
- Mode: run
- Given: A signed-in admin has a personal Tailscale configuration. Parameter row `tailscale`: while the configuration's rotated credentials are being encrypted, the admin creates a Kerberos VNC host using it for both roles.
- When: The admin rotates the configuration via `PATCH /api/tailscale/configs/:configId`.
- Then: The host creation returns HTTP 201. The rotation returns HTTP 200 and lists the new host with roles `rfb` and `kdc`. The host reads back at generation 2 with its transport and security unchanged.

## vnc-native-publication-019

- Vitest: "tailscale public native publication on PostgreSQL > does not reveal or encrypt for another member's personal configuration"
- Mode: run
- Given: A workspace member has saved a personal Tailscale configuration. Parameter row `tailscale`: a different member of the same workspace is signed in.
- When: The other member creates a Kerberos VNC host referencing that configuration via `POST /api/vnc/connections`, then lists `GET /api/tailscale/configs` and `GET /api/vnc/credentials`.
- Then: The creation returns HTTP 404 with no data key requested. The other member sees no configurations and no credentials.

## vnc-native-publication-020

- Vitest: "tailscale public native publication on PostgreSQL > detaches both roles once after reviewed others-only deletion and requires an explicit rebind"
- Mode: run
- Given: A workspace admin has an organization-scoped Tailscale configuration. Parameter row `tailscale`: another member created a Kerberos VNC host using it for both roles.
- When: The admin reads the delete impact preview; the member renames the host; the admin deletes with the old preview snapshot, reads a new preview and deletes with it; the member reads the host, tries to rename it, and then rebinds it to a new personal Tailscale configuration for both roles.
- Then: The first preview reports `ownHostCount: 0`, `otherHostCount: 1`, lists the member as the affected owner and omits the host name. Deletion with the stale snapshot returns HTTP 409; deletion with the current snapshot returns HTTP 204. The host is then two generations newer with both its RFB and KDC transports marked `needsRebind: true`. The rename returns HTTP 400 and leaves the host unchanged. The explicit rebind returns HTTP 200 at the next generation with the original credential and the new transport and security.

## vnc-native-publication-021

- Vitest: "keeps cloudflare_access RFB and tailscale KDC authority independent"
- Mode: run
- Given: A signed-in admin has a personal `cloudflare_access` configuration and a personal `tailscale` configuration (parameter row RFB `cloudflare_access` / KDC `tailscale`).
- When: The admin creates a Kerberos VNC host via `POST /api/vnc/connections` routing RFB through the first and KDC through the second, then lists both providers' configurations.
- Then: The host is created with the requested transport and security. The `cloudflare_access` configuration lists the host with role `rfb` only, and the `tailscale` configuration lists it with role `kdc` only.

## vnc-native-publication-022

- Vitest: "keeps tailscale RFB and cloudflare_access KDC authority independent"
- Mode: run
- Given: A signed-in admin has a personal `tailscale` configuration and a personal `cloudflare_access` configuration (parameter row RFB `tailscale` / KDC `cloudflare_access`).
- When: The admin creates a Kerberos VNC host via `POST /api/vnc/connections` routing RFB through the first and KDC through the second, then lists both providers' configurations.
- Then: The host is created with the requested transport and security. The `tailscale` configuration lists the host with role `rfb` only, and the `cloudflare_access` configuration lists it with role `kdc` only.

## vnc-native-publication-023

- Vitest: "cloudflare_access raw-profile owner validation > admits apple_vnc_password only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `cloudflare_access` configuration. Parameter row: security `apple_vnc_password` with authentication `vnc_password`.
- When: The admin creates a VNC host with security `apple_vnc_password` and an inline `vnc_password` credential via `POST /api/vnc/connections` routed through the configuration without origin TLS, then with origin TLS (server name `origin.example.com`, system trust), then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation without origin TLS returns HTTP 400. The creation with origin TLS returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-024

- Vitest: "cloudflare_access raw-profile owner validation > admits apple_dh only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `cloudflare_access` configuration. Parameter row: security `apple_dh` with authentication `apple_dh_username_password`.
- When: The admin creates a VNC host with security `apple_dh` and an inline `apple_dh_username_password` credential via `POST /api/vnc/connections` routed through the configuration without origin TLS, then with origin TLS (server name `origin.example.com`, system trust), then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation without origin TLS returns HTTP 400. The creation with origin TLS returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-025

- Vitest: "cloudflare_access raw-profile owner validation > admits apple_srp only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `cloudflare_access` configuration. Parameter row: security `apple_srp` with authentication `apple_srp_username_password`.
- When: The admin creates a VNC host with security `apple_srp` and an inline `apple_srp_username_password` credential via `POST /api/vnc/connections` routed through the configuration without origin TLS, then with origin TLS (server name `origin.example.com`, system trust), then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation without origin TLS returns HTTP 400. The creation with origin TLS returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-026

- Vitest: "cloudflare_access raw-profile owner validation > admits apple_rsa_srp only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `cloudflare_access` configuration. Parameter row: security `apple_rsa_srp` with authentication `apple_rsa_srp_username_password`.
- When: The admin creates a VNC host with security `apple_rsa_srp` and an inline `apple_rsa_srp_username_password` credential via `POST /api/vnc/connections` routed through the configuration without origin TLS, then with origin TLS (server name `origin.example.com`, system trust), then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation without origin TLS returns HTTP 400. The creation with origin TLS returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-027

- Vitest: "cloudflare_access raw-profile owner validation > admits rsa_aes_ra2ne only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `cloudflare_access` configuration. Parameter row: security `rsa_aes_ra2ne` with authentication `rsa_aes_password`.
- When: The admin creates a VNC host with security `rsa_aes_ra2ne` with a pinned server key and an inline `rsa_aes_password` credential via `POST /api/vnc/connections` routed through the configuration without origin TLS, then with origin TLS (server name `origin.example.com`, system trust), then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation without origin TLS returns HTTP 400. The creation with origin TLS returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-028

- Vitest: "cloudflare_access raw-profile owner validation > admits rsa_aes_ra2ne only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `cloudflare_access` configuration. Parameter row: security `rsa_aes_ra2ne` with authentication `rsa_aes_username_password`.
- When: The admin creates a VNC host with security `rsa_aes_ra2ne` with a pinned server key and an inline `rsa_aes_username_password` credential via `POST /api/vnc/connections` routed through the configuration without origin TLS, then with origin TLS (server name `origin.example.com`, system trust), then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation without origin TLS returns HTTP 400. The creation with origin TLS returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-029

- Vitest: "cloudflare_access raw-profile owner validation > admits rsa_aes_ra2ne_256 only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `cloudflare_access` configuration. Parameter row: security `rsa_aes_ra2ne_256` with authentication `rsa_aes_password`.
- When: The admin creates a VNC host with security `rsa_aes_ra2ne_256` with a pinned server key and an inline `rsa_aes_password` credential via `POST /api/vnc/connections` routed through the configuration without origin TLS, then with origin TLS (server name `origin.example.com`, system trust), then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation without origin TLS returns HTTP 400. The creation with origin TLS returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-030

- Vitest: "cloudflare_access raw-profile owner validation > admits rsa_aes_ra2ne_256 only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `cloudflare_access` configuration. Parameter row: security `rsa_aes_ra2ne_256` with authentication `rsa_aes_username_password`.
- When: The admin creates a VNC host with security `rsa_aes_ra2ne_256` with a pinned server key and an inline `rsa_aes_username_password` credential via `POST /api/vnc/connections` routed through the configuration without origin TLS, then with origin TLS (server name `origin.example.com`, system trust), then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation without origin TLS returns HTTP 400. The creation with origin TLS returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-031

- Vitest: "tailscale raw-profile owner validation > admits apple_vnc_password only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `tailscale` configuration. Parameter row: security `apple_vnc_password` with authentication `vnc_password`.
- When: The admin creates a VNC host with security `apple_vnc_password` and an inline `vnc_password` credential via `POST /api/vnc/connections` routed through the Tailscale configuration, then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-032

- Vitest: "tailscale raw-profile owner validation > admits apple_dh only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `tailscale` configuration. Parameter row: security `apple_dh` with authentication `apple_dh_username_password`.
- When: The admin creates a VNC host with security `apple_dh` and an inline `apple_dh_username_password` credential via `POST /api/vnc/connections` routed through the Tailscale configuration, then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-033

- Vitest: "tailscale raw-profile owner validation > admits apple_srp only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `tailscale` configuration. Parameter row: security `apple_srp` with authentication `apple_srp_username_password`.
- When: The admin creates a VNC host with security `apple_srp` and an inline `apple_srp_username_password` credential via `POST /api/vnc/connections` routed through the Tailscale configuration, then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-034

- Vitest: "tailscale raw-profile owner validation > admits apple_rsa_srp only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `tailscale` configuration. Parameter row: security `apple_rsa_srp` with authentication `apple_rsa_srp_username_password`.
- When: The admin creates a VNC host with security `apple_rsa_srp` and an inline `apple_rsa_srp_username_password` credential via `POST /api/vnc/connections` routed through the Tailscale configuration, then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-035

- Vitest: "tailscale raw-profile owner validation > admits rsa_aes_ra2ne only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `tailscale` configuration. Parameter row: security `rsa_aes_ra2ne` with authentication `rsa_aes_password`.
- When: The admin creates a VNC host with security `rsa_aes_ra2ne` with a pinned server key and an inline `rsa_aes_password` credential via `POST /api/vnc/connections` routed through the Tailscale configuration, then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-036

- Vitest: "tailscale raw-profile owner validation > admits rsa_aes_ra2ne only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `tailscale` configuration. Parameter row: security `rsa_aes_ra2ne` with authentication `rsa_aes_username_password`.
- When: The admin creates a VNC host with security `rsa_aes_ra2ne` with a pinned server key and an inline `rsa_aes_username_password` credential via `POST /api/vnc/connections` routed through the Tailscale configuration, then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-037

- Vitest: "tailscale raw-profile owner validation > admits rsa_aes_ra2ne_256 only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `tailscale` configuration. Parameter row: security `rsa_aes_ra2ne_256` with authentication `rsa_aes_password`.
- When: The admin creates a VNC host with security `rsa_aes_ra2ne_256` with a pinned server key and an inline `rsa_aes_password` credential via `POST /api/vnc/connections` routed through the Tailscale configuration, then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-038

- Vitest: "tailscale raw-profile owner validation > admits rsa_aes_ra2ne_256 only with its protective route"
- Mode: run
- Given: A signed-in admin has a personal `tailscale` configuration. Parameter row: security `rsa_aes_ra2ne_256` with authentication `rsa_aes_username_password`.
- When: The admin creates a VNC host with security `rsa_aes_ra2ne_256` with a pinned server key and an inline `rsa_aes_username_password` credential via `POST /api/vnc/connections` routed through the Tailscale configuration, then tries to switch it to a direct transport at `public.example.com`.
- Then: The creation returns HTTP 201 with the requested transport and security. The direct switch returns HTTP 400 and the host is unchanged.

## vnc-native-publication-039

- Vitest: "validates independent origin and inner certificate identities and preserves a failed trust edit"
- Mode: run
- Given: A signed-in admin has a personal Cloudflare Access configuration and a personal Tailscale configuration.
- When: The admin creates a credential-free `x509_none` host with inner server name `inner.example.com` routed through Cloudflare Access with origin TLS server name `origin.example.com` and a custom CA; updates the origin trust to an invalid CA bundle; then switches the host to the Tailscale configuration at `desktop.tailnet:5900` and lists Cloudflare Access configurations.
- Then: The host is created at `rfb-gateway.example.com` with inner server name `inner.example.com` and origin server name `origin.example.com`. The invalid-CA edit returns HTTP 400 and the host is unchanged. The Tailscale switch returns HTTP 200 keeping the inner security, with the Tailscale transport and no `originTls`, and the Cloudflare Access configuration lists no VNC hosts.
