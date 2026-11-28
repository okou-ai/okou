# tailscale-parity

## tailscale-parity-001

- Vitest: "preserves trust through protected endpoint/carrier edits, resets only explicitly or for Direct-to-Direct endpoint changes"
- Mode: run
- Given: A signed-in member has a personal Tailscale config, a Cloudflare Access gateway, and a direct SSH host `direct.example.com` whose host key an official Runner has pinned for the member's Run.
- When: The member moves the host onto Tailscale at `peer:2222` and then `other-peer:65535` with `PATCH /api/ssh/connections/:connectionId`, resets the host key with `POST /api/ssh/connections/:connectionId/reset-host-key`, lets the Runner pin it again, moves it through direct `direct2.example.com:22`, Cloudflare Access `access.example.com:443`, Tailscale `peer:2222` and direct `direct3.example.com:22`, and finally changes only the host to `direct4.example.com`.
- Then: Each Tailscale endpoint edit returns HTTP 200 and keeps the learned host key. The explicit reset returns HTTP 200 and clears it. After repinning, every carrier transition returns HTTP 200, keeps the learned host key and keeps the original login. The final direct-to-direct host change returns HTTP 200 and clears the learned host key.

## tailscale-parity-002

- Vitest: "promotes Personal configuration and requires fresh admin impact review for conversion, retaining SSH identity and explicit private rebind"
- Mode: run
- Given: An organization admin has a personal Tailscale config with one of their own SSH hosts. A regular member of the organization later adds a host on the config whose key an official Runner pins for the member's Run.
- When: The admin promotes the config with `POST /api/tailscale/configs/:configId/convert-to-organization` at a wrong and then the current revision; the member requests impact previews and promotion; the admin previews conversion, the member renames their host, the admin converts back with `POST /api/tailscale/configs/:configId/convert-to-personal` using the stale preview and then a fresh one; the member reads hosts and configs, the Runner resolves the member's host, and the member edits, rebinds to the old config, and rebinds to a new personal config before the Runner resolves again.
- Then: Promotion at the wrong revision returns HTTP 409; at the current revision HTTP 200 with scope `organization`, revision 2, generation 2 and the admin's host, whose generation increases by one. The member's previews and promotion return HTTP 403. The admin's preview shows one own host, one other host and the member as affected owner, without exposing the member's host ID. Conversion with the stale preview returns HTTP 409; with the fresh preview HTTP 200 with scope `personal`, revision 3, generation 3 and only the admin's host. The member's host keeps its ID, login, learned key, host and port, with generation +1 and a Tailscale transport marked `needsRebind`, and the member sees no configs. The Runner then gets `unavailable` without any KMS decryption. A plain rename returns HTTP 400, rebinding to the old config HTTP 404, and rebinding to a new personal config at `replacement-peer:22` HTTP 200 keeping the key and login with generation +1. The Runner then resolves `resolved_tailscale` with the new config.

## tailscale-parity-003

- Vitest: "allows another current admin to adopt shared configuration but hides the resulting Personal configuration from its former creator"
- Mode: run
- Given: An organization admin (the creator) has a shared Tailscale config with their own SSH host, and a second current admin also has a host on it.
- When: The second admin previews conversion and converts the config to personal with `POST /api/tailscale/configs/:configId/convert-to-personal`; the creator lists configs, reads their host, and tries to promote the config with `POST /api/tailscale/configs/:configId/convert-to-organization` at revision 2; then the second admin promotes it at revision 2.
- Then: The conversion returns HTTP 200 and the second admin's host remains bound to the config with generation +1. The creator sees no configs, their host's Tailscale transport is marked `needsRebind`, and their promotion returns HTTP 404. The second admin's promotion returns HTTP 200.

## tailscale-parity-004

- Vitest: "refuses own-reference deletion and requires a current impact snapshot before deleting shared configuration referenced only by others"
- Mode: run
- Given: An organization admin has a shared Tailscale config with one of their own SSH hosts.
- When: The admin previews and tries `DELETE /api/tailscale/configs/:configId` while their host references it, deletes their host, then a regular member adds a host on the config (pinned by an official Runner); the admin previews deletion, deletes without a snapshot, the member moves their host to `next-peer:65535`, the admin deletes with the stale snapshot and then with a fresh one; the member reads configs and host, the Runner resolves, and the member moves the host to direct `direct.example.com:22`.
- Then: Deleting while the admin's own host references the config returns HTTP 409, and the admin's host deletion returns HTTP 204. The delete without a snapshot returns HTTP 409, the member's endpoint edit HTTP 200, the stale-snapshot delete HTTP 409 and the fresh-snapshot delete HTTP 204. The member then sees no configs; their host keeps its endpoint, learned key and login with generation +1 and a Tailscale transport marked `needsRebind`. The Runner gets `unavailable` without any KMS decryption. The direct move returns HTTP 200 keeping the learned key and login with no `transport` property.

## tailscale-parity-005

- Vitest: "fences a first network binding created while credential replacement is externally preparing"
- Mode: run
- Given: A signed-in member has a personal Tailscale config with no hosts. A credential replacement for it is stalled while KMS encrypts the new secret.
- When: While the replacement is stalled, the member creates the first SSH host bound to the config with `POST /api/ssh/connections`; then the replacement completes; then the member edits the host at its original generation.
- Then: The replacement returns HTTP 200 with generation +1 and the new host listed. The host's generation is one higher than at creation, and the edit at the original generation returns HTTP 409.

## tailscale-parity-006

- Vitest: "rejects a late member binding after reviewed shared conversion without orphaning a prepared login"
- Mode: run
- Given: An organization admin has a shared Tailscale config. A regular member's host creation bound to it (with an inline login) is stalled while KMS encrypts the login.
- When: While the member's create is stalled, the admin previews and converts the config to personal with `POST /api/tailscale/configs/:configId/convert-to-personal`; then the member's create completes.
- Then: The conversion returns HTTP 200. The member's create returns HTTP 404, and the member has no SSH hosts and an empty SSH credential list.

## tailscale-parity-007

- Vitest: "rejects invisible tailscale host-update configuration before login encryption even when KMS fails"
- Mode: run
- Given: A signed-in member has a direct SSH host `peer.example.com:443` with a login. Another member of the same organization has a personal Tailscale config, the same user has one in another organization, and the member has their own visible Tailscale config. KMS encryption fails.
- When: The member updates the host with `PATCH /api/ssh/connections/:connectionId` selecting a random Tailscale config ID, the peer's personal config, or the other organization's config, each with a new inline login; then selects their own visible config with a new inline login.
- Then: Each invisible selection returns HTTP 404 with `TAILSCALE_NOT_FOUND`, without any KMS data-key generation, and the host and SSH credential list are unchanged. The visible selection reaches KMS once and returns HTTP 500, leaving the host and credentials unchanged.

## tailscale-parity-008

- Vitest: "rejects invisible cloudflare_access host-update configuration before login encryption even when KMS fails"
- Mode: run
- Given: A signed-in member has a direct SSH host `peer.example.com:443` with a login. Another member of the same organization has a personal Cloudflare Access gateway, the same user has one in another organization, and the member has their own visible gateway. KMS encryption fails.
- When: The member updates the host with `PATCH /api/ssh/connections/:connectionId` selecting a random Cloudflare Access config ID, the peer's personal gateway, or the other organization's gateway, each with a new inline login; then selects their own visible gateway with a new inline login.
- Then: Each invisible selection returns HTTP 404 with `CLOUDFLARE_ACCESS_NOT_FOUND`, without any KMS data-key generation, and the host and SSH credential list are unchanged. The visible selection reaches KMS once and returns HTTP 500, leaving the host and credentials unchanged.

## tailscale-parity-009

- Vitest: "rechecks Tailscale binding visibility after the unlocked preflight without leaving an inline login"
- Mode: run
- Given: An organization admin has a shared Tailscale config, and a regular member has a direct SSH host `peer.example.com` with a login. The member's update that binds the host to the shared config with a new inline login is stalled while KMS encrypts the login.
- When: While the member's `PATCH /api/ssh/connections/:connectionId` is stalled, the admin previews and converts the config to personal with `POST /api/tailscale/configs/:configId/convert-to-personal`; then the member's update completes.
- Then: The conversion returns HTTP 200. The member's update returns HTTP 404 with `TAILSCALE_NOT_FOUND`, the host is unchanged, and the member's SSH credential list is unchanged.

## tailscale-parity-010

- Vitest: "treats tag permutations as metadata-only while real tag additions and removals invalidate all referencing hosts"
- Mode: run
- Given: An organization admin has a shared Tailscale config with tags `tag:prod`, `tag:ci`, used by the admin's host and a regular member's host, each pinned by an official Runner for a running Run.
- When: The admin reorders the tags twice with `PATCH /api/tailscale/configs/:configId` (to `tag:ci`, `tag:prod` and back), then changes them to `tag:prod`, `tag:ci`, `tag:extra` and then `tag:ci`, `tag:extra`.
- Then: Each reorder returns HTTP 200 with the new order, revision +1 and unchanged generation, publishes exactly one realtime `tailscale:changed` event for the organization, and leaves both hosts unchanged. Each real tag change returns HTTP 200 with revision +1 and generation +1; both hosts advance their generation by the same offset while keeping their login, username and learned host key, and realtime `ssh-authority-invalidated` events are published for each host's Run and connection.

## tailscale-parity-011

- Vitest: "rotates shared credentials and all current member host generations atomically while name-only changes preserve effective authority"
- Mode: run
- Given: An organization admin has a shared Tailscale config used by the admin's host and a regular member's host.
- When: The admin renames the config with `PATCH /api/tailscale/configs/:configId`, then rotates its OAuth credentials; the member then edits their host at its original generation.
- Then: The rename returns HTTP 200 with unchanged generation and leaves the admin's host generation unchanged. The rotation returns HTTP 200 with generation +1, and both the admin's and the member's hosts advance by one generation. The member's stale edit returns HTTP 409.
