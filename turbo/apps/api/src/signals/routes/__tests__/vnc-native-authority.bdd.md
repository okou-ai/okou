# vnc-native-authority

## vnc-native-authority-001

- Vitest: "authorizes cloudflare_access RFB/cloudflare_access KDC through genuine owner publication and only a VNC chat grant"
- Mode: run
- Given: A Pro member has a running chat Run on an authenticated Runner. Parameter row RFB `cloudflare_access` / KDC `cloudflare_access`: the member saves private network configurations (client ID and secret) via `POST /api/cloudflare-access/configs` (the same configuration serves both), and creates a Kerberos VNC host (`qemu_kerberos_password`, `qemu_x509_gssapi`, server name `inner.example.com`) whose RFB connection uses the `cloudflare_access` transport and whose KDC uses the `cloudflare_access` transport. The host's VNC chat default is enabled.
- When: The Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the standard supported profiles, then again declaring support for exactly this Kerberos/native-transport profile; the member then lists `GET /api/vnc/connections`.
- Then: The first resolve returns `{ outcome: "unsupported_profile" }` without any decryption. The second returns `resolved_kerberos` with server name `inner.example.com`, an RFB transport of type `cloudflare_access` carrying the config ID, generation and private client credentials, the Kerberos password, the service principal, and a KDC transport of type `cloudflare_access` with its config ID, generation and credentials; secrets are decrypted. The owner's host list contains neither the client ID, the client secret nor the Kerberos password.

## vnc-native-authority-002

- Vitest: "authorizes cloudflare_access RFB/tailscale KDC through genuine owner publication and only a VNC chat grant"
- Mode: run
- Given: A Pro member has a running chat Run on an authenticated Runner. Parameter row RFB `cloudflare_access` / KDC `tailscale`: the member saves private network configurations (client ID and secret) via `POST /api/cloudflare-access/configs` and `POST /api/tailscale/configs`, and creates a Kerberos VNC host (`qemu_kerberos_password`, `qemu_x509_gssapi`, server name `inner.example.com`) whose RFB connection uses the `cloudflare_access` transport and whose KDC uses the `tailscale` transport. The host's VNC chat default is enabled.
- When: The Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the standard supported profiles, then again declaring support for exactly this Kerberos/native-transport profile; the member then lists `GET /api/vnc/connections`.
- Then: The first resolve returns `{ outcome: "unsupported_profile" }` without any decryption. The second returns `resolved_kerberos` with server name `inner.example.com`, an RFB transport of type `cloudflare_access` carrying the config ID, generation and private client credentials, the Kerberos password, the service principal, and a KDC transport of type `tailscale` with its config ID, generation and credentials; secrets are decrypted. The owner's host list contains neither the client ID, the client secret nor the Kerberos password.

## vnc-native-authority-003

- Vitest: "authorizes tailscale RFB/cloudflare_access KDC through genuine owner publication and only a VNC chat grant"
- Mode: run
- Given: A Pro member has a running chat Run on an authenticated Runner. Parameter row RFB `tailscale` / KDC `cloudflare_access`: the member saves private network configurations (client ID and secret) via `POST /api/tailscale/configs` and `POST /api/cloudflare-access/configs`, and creates a Kerberos VNC host (`qemu_kerberos_password`, `qemu_x509_gssapi`, server name `inner.example.com`) whose RFB connection uses the `tailscale` transport and whose KDC uses the `cloudflare_access` transport. The host's VNC chat default is enabled.
- When: The Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the standard supported profiles, then again declaring support for exactly this Kerberos/native-transport profile; the member then lists `GET /api/vnc/connections`.
- Then: The first resolve returns `{ outcome: "unsupported_profile" }` without any decryption. The second returns `resolved_kerberos` with server name `inner.example.com`, an RFB transport of type `tailscale` carrying the config ID, generation and private client credentials, the Kerberos password, the service principal, and a KDC transport of type `cloudflare_access` with its config ID, generation and credentials; secrets are decrypted. The owner's host list contains neither the client ID, the client secret nor the Kerberos password.

## vnc-native-authority-004

- Vitest: "authorizes tailscale RFB/tailscale KDC through genuine owner publication and only a VNC chat grant"
- Mode: run
- Given: A Pro member has a running chat Run on an authenticated Runner. Parameter row RFB `tailscale` / KDC `tailscale`: the member saves private network configurations (client ID and secret) via `POST /api/tailscale/configs` (the same configuration serves both), and creates a Kerberos VNC host (`qemu_kerberos_password`, `qemu_x509_gssapi`, server name `inner.example.com`) whose RFB connection uses the `tailscale` transport and whose KDC uses the `tailscale` transport. The host's VNC chat default is enabled.
- When: The Runner calls `POST /api/runners/runs/:runId/vnc/resolve` with the standard supported profiles, then again declaring support for exactly this Kerberos/native-transport profile; the member then lists `GET /api/vnc/connections`.
- Then: The first resolve returns `{ outcome: "unsupported_profile" }` without any decryption. The second returns `resolved_kerberos` with server name `inner.example.com`, an RFB transport of type `tailscale` carrying the config ID, generation and private client credentials, the Kerberos password, the service principal, and a KDC transport of type `tailscale` with its config ID, generation and credentials; secrets are decrypted. The owner's host list contains neither the client ID, the client secret nor the Kerberos password.

## vnc-native-authority-005

- Vitest: "rechecks final authority after secret work for cloudflare_access RFB/cloudflare_access KDC without releasing stale payloads"
- Mode: run
- Given: A Pro member has a running chat Run and a chat-enabled Kerberos VNC host whose RFB connection uses a saved `cloudflare_access` configuration and whose KDC uses a saved `cloudflare_access` configuration (parameter row RFB `cloudflare_access` / KDC `cloudflare_access`). During the first secret decryption, the member rotates the KDC configuration's credentials via `PATCH /api/cloudflare-access/configs/:configId` at its current revision.
- When: The Runner calls `POST /api/runners/runs/:runId/vnc/resolve` declaring the Kerberos/native-transport profile, and after the rotation completes calls it again.
- Then: The rotation returns HTTP 200. The first resolve returns exactly `{ outcome: "unavailable" }` instead of the stale secrets. The second resolve returns `resolved_kerberos` at the host's generation plus one.

## vnc-native-authority-006

- Vitest: "rechecks final authority after secret work for cloudflare_access RFB/tailscale KDC without releasing stale payloads"
- Mode: run
- Given: A Pro member has a running chat Run and a chat-enabled Kerberos VNC host whose RFB connection uses a saved `cloudflare_access` configuration and whose KDC uses a saved `tailscale` configuration (parameter row RFB `cloudflare_access` / KDC `tailscale`). During the first secret decryption, the member rotates the KDC configuration's credentials via `PATCH /api/tailscale/configs/:configId` at its current revision.
- When: The Runner calls `POST /api/runners/runs/:runId/vnc/resolve` declaring the Kerberos/native-transport profile, and after the rotation completes calls it again.
- Then: The rotation returns HTTP 200. The first resolve returns exactly `{ outcome: "unavailable" }` instead of the stale secrets. The second resolve returns `resolved_kerberos` at the host's generation plus one.

## vnc-native-authority-007

- Vitest: "rechecks final authority after secret work for tailscale RFB/cloudflare_access KDC without releasing stale payloads"
- Mode: run
- Given: A Pro member has a running chat Run and a chat-enabled Kerberos VNC host whose RFB connection uses a saved `tailscale` configuration and whose KDC uses a saved `cloudflare_access` configuration (parameter row RFB `tailscale` / KDC `cloudflare_access`). During the first secret decryption, the member rotates the KDC configuration's credentials via `PATCH /api/cloudflare-access/configs/:configId` at its current revision.
- When: The Runner calls `POST /api/runners/runs/:runId/vnc/resolve` declaring the Kerberos/native-transport profile, and after the rotation completes calls it again.
- Then: The rotation returns HTTP 200. The first resolve returns exactly `{ outcome: "unavailable" }` instead of the stale secrets. The second resolve returns `resolved_kerberos` at the host's generation plus one.

## vnc-native-authority-008

- Vitest: "rechecks final authority after secret work for tailscale RFB/tailscale KDC without releasing stale payloads"
- Mode: run
- Given: A Pro member has a running chat Run and a chat-enabled Kerberos VNC host whose RFB connection uses a saved `tailscale` configuration and whose KDC uses a saved `tailscale` configuration (parameter row RFB `tailscale` / KDC `tailscale`). During the first secret decryption, the member rotates the KDC configuration's credentials via `PATCH /api/tailscale/configs/:configId` at its current revision.
- When: The Runner calls `POST /api/runners/runs/:runId/vnc/resolve` declaring the Kerberos/native-transport profile, and after the rotation completes calls it again.
- Then: The rotation returns HTTP 200. The first resolve returns exactly `{ outcome: "unavailable" }` instead of the stale secrets. The second resolve returns `resolved_kerberos` at the host's generation plus one.
