# ssh-tailscale-binding-atomicity

## ssh-tailscale-binding-atomicity-001

- Vitest: "concurrent inline Tailscale Host creation commits only the winner's network and login"
- Mode: run
- Given: A signed-in member can encrypt secrets with KMS.
- When: The member concurrently sends two `POST /api/ssh/connections` requests with the same host ID for `100.64.0.21` port 22, each with an inline password login and an inline Tailscale network (different display names); then replays the create with another name; then another user in the same organization sends the same create.
- Then: One create returns HTTP 201 and the other HTTP 204. The member has exactly the winning host (generation 1) plus one SSH credential and one Tailscale config, and the host references that credential and config. The replay returns HTTP 204 and changes nothing. The other user's create returns HTTP 409 with `SSH_RESOURCE_ID_CONFLICT` and leaves them with no hosts, credentials or Tailscale configs, while the creator's inventory is unchanged.

## ssh-tailscale-binding-atomicity-002

- Vitest: "competing inline Tailscale rebinds leave one winner and no losing network or login"
- Mode: run
- Given: A signed-in member has a direct SSH host `ssh.example.com` with an inline login, at generation 1.
- When: The member concurrently sends two `PATCH /api/ssh/connections/:connectionId` requests at generation 1 that move the host to `100.64.0.21`, replace the login with an inline "Replacement login" and add an inline Tailscale network.
- Then: One edit returns HTTP 200 and the other HTTP 409 with `SSH_GENERATION_CONFLICT`. The member has one host at generation 2 with credential name `Replacement login` on the single Tailscale config, two SSH credentials in total (only one named `Replacement login`), and one Tailscale config.

## ssh-tailscale-binding-atomicity-003

- Vitest: "a visible selected Tailscale configuration does not grant a foreign SSH login"
- Mode: run
- Given: A signed-in member has a Tailscale config, and another user in the same organization owns a saved SSH login.
- When: The member creates a host with `POST /api/ssh/connections` that selects their Tailscale config and the other user's login ID.
- Then: The request returns HTTP 404 with `SSH_CREDENTIAL_NOT_FOUND`. The member still has no hosts, no SSH credentials, and only their Tailscale config.

## ssh-tailscale-binding-atomicity-004

- Vitest: "missing selected Tailscale configuration rejects create without leaving an inline login"
- Mode: run
- Given: A signed-in member has no Tailscale config with the selected ID.
- When: The member creates a host with `POST /api/ssh/connections` that has an inline login and selects the missing Tailscale config ID; then creates a Tailscale config with that ID via `POST /api/tailscale/configs` and retries the host create.
- Then: The first create returns HTTP 404 with `TAILSCALE_NOT_FOUND` and the hosts, credentials and Tailscale configs are unchanged. After the config exists, the retry returns HTTP 201 with the same host ID, generation 1 and the Tailscale transport on that config.

## ssh-tailscale-binding-atomicity-005

- Vitest: "missing selected Tailscale configuration rejects update without leaving an inline login"
- Mode: run
- Given: A signed-in member has a direct SSH host at generation 1 and no Tailscale config with the selected ID.
- When: The member sends `PATCH /api/ssh/connections/:connectionId` that moves the host to `100.64.0.21`, adds an inline login and selects the missing Tailscale config ID; then creates a Tailscale config with that ID and retries the update.
- Then: The first update returns HTTP 404 with `TAILSCALE_NOT_FOUND` and the hosts, credentials and Tailscale configs are unchanged (the host list still shows the original host). After the config exists, the retry returns HTTP 200 with generation 2 and the Tailscale transport on that config.
