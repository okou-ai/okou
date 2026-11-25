# ssh-network-binding-publication

## ssh-network-binding-publication-001

- Vitest: "cloudflare_access creation, retained edits and rebind preserve logical configuration metadata"
- Mode: run
- Given: A signed-in member has two personal Cloudflare Access configs, each with one SSH host `peer.example.com` port 443 bound to it through an inline password login.
- When: The member edits the first host with `PATCH /api/ssh/connections/:connectionId` to rename it and replace its login (transport omitted), edits it again with the same Access config explicitly selected, then rebinds it to the second Access config; after each step the member reads `GET /api/cloudflare-access/configs?view=scoped` and the host list.
- Then: After creation the first config lists exactly the first host. The retained edits return HTTP 200 and leave the host at generation +2 still on the first config, which lists the host under its new name, while the second config still lists only its own host. The rebind returns HTTP 200 at generation +3 on the second config, which then lists both hosts, and the first config lists no hosts. The unrelated host is unchanged throughout.

## ssh-network-binding-publication-002

- Vitest: "tailscale creation, retained edits and rebind preserve logical configuration metadata"
- Mode: run
- Given: A signed-in member has two personal Tailscale configs (tag `tag:okou`), each with one SSH host `peer.example.com` port 443 bound to it through an inline password login.
- When: The member edits the first host with `PATCH /api/ssh/connections/:connectionId` to rename it and replace its login (transport omitted), edits it again with the same Tailscale config explicitly selected, then rebinds it to the second Tailscale config; after each step the member reads `GET /api/tailscale/configs` and the host list.
- Then: After creation the first config lists exactly the first host. The retained edits return HTTP 200 and leave the host at generation +2 still on the first config, which lists the host under its new name, while the second config still lists only its own host. The rebind returns HTTP 200 at generation +3 on the second config, which then lists both hosts, and the first config lists no hosts. The unrelated host is unchanged throughout.

## ssh-network-binding-publication-003

- Vitest: "cloudflare_access rotation during retained inline-login preparation rejects the stale edit without an orphan login"
- Mode: run
- Given: A signed-in member has a Cloudflare Access config with a bound SSH host and an unrelated config with its own host. While the host edit is preparing its new inline login, the member rotates the first config's service-token credentials with `PATCH /api/cloudflare-access/configs/:configId`.
- When: The member sends `PATCH /api/ssh/connections/:connectionId` at the original generation with a new name and a new inline login "Losing login".
- Then: The edit returns HTTP 409 with `SSH_GENERATION_CONFLICT`. The SSH credential list is unchanged (no orphan login). The host remains at generation +1 with its original data, the unrelated host is unchanged, and the Access config shows revision +1, generation +1 and the host still linked.

## ssh-network-binding-publication-004

- Vitest: "tailscale rotation during retained inline-login preparation rejects the stale edit without an orphan login"
- Mode: run
- Given: A signed-in member has a Tailscale config with a bound SSH host and an unrelated config with its own host. While the host edit is preparing its new inline login, the member rotates the first config's OAuth credentials with `PATCH /api/tailscale/configs/:configId`.
- When: The member sends `PATCH /api/ssh/connections/:connectionId` at the original generation with a new name and a new inline login "Losing login".
- Then: The edit returns HTTP 409 with `SSH_GENERATION_CONFLICT`. The SSH credential list is unchanged (no orphan login). The host remains at generation +1 with its original data, the unrelated host is unchanged, and the Tailscale config shows revision +1, generation +1 and the host still linked.

## ssh-network-binding-publication-005

- Vitest: "cloudflare_access rotation includes a retained binding edit completed during external secret preparation"
- Mode: run
- Given: A signed-in member has a Cloudflare Access config with one bound SSH host. While the config rotation is preparing its new secret, the member renames the host to "Retained during rotation" via `PATCH /api/ssh/connections/:connectionId`.
- When: The member rotates the config's credentials with `PATCH /api/cloudflare-access/configs/:configId`.
- Then: The rename returns HTTP 200 at generation +1 still bound to the same config. The rotation returns HTTP 200 with revision +1, generation +1 and the host listed as `Retained during rotation`. The host then shows that name at generation +2.

## ssh-network-binding-publication-006

- Vitest: "tailscale rotation includes a retained binding edit completed during external secret preparation"
- Mode: run
- Given: A signed-in member has a Tailscale config with one bound SSH host. While the config rotation is preparing its new secret, the member renames the host to "Retained during rotation" via `PATCH /api/ssh/connections/:connectionId`.
- When: The member rotates the config's credentials with `PATCH /api/tailscale/configs/:configId`.
- Then: The rename returns HTTP 200 at generation +1 still bound to the same config. The rotation returns HTTP 200 with revision +1, generation +1 and the host listed as `Retained during rotation`. The host then shows that name at generation +2.
