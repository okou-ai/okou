# ssh-host-key-cas

## ssh-host-key-cas-001

- Vitest: "competing direct trust resets accept only one expected generation"
- Mode: run
- Given: A signed-in member has a direct SSH host `ssh.example.com` port 22 with a password login, at generation 1.
- When: The member sends two concurrent `POST /api/ssh/connections/:connectionId/reset-host-key` requests with expected generation 1, then a third reset with the same stale generation.
- Then: One concurrent reset returns HTTP 200 and the other HTTP 409 with `SSH_GENERATION_CONFLICT` and message "SSH connection was modified by another request". The list shows the same host at generation 2. The third reset returns HTTP 409 and the list is unchanged.

## ssh-host-key-cas-002

- Vitest: "competing cloudflare_access trust resets accept only one expected generation"
- Mode: run
- Given: A signed-in member has an SSH host `ssh.example.com` port 443 protected by an inline Cloudflare Access service token, with a password login, at generation 1.
- When: The member sends two concurrent `POST /api/ssh/connections/:connectionId/reset-host-key` requests with expected generation 1, then a third reset with the same stale generation.
- Then: One concurrent reset returns HTTP 200 and the other HTTP 409 with `SSH_GENERATION_CONFLICT` and message "SSH connection was modified by another request". The list shows the same host at generation 2. The third reset returns HTTP 409 and the list is unchanged.

## ssh-host-key-cas-003

- Vitest: "competing tailscale trust resets accept only one expected generation"
- Mode: run
- Given: A signed-in member has an SSH host `peer.tailnet.ts.net` port 22 reached through an inline Tailscale configuration (tag `tag:okou`), with a password login, at generation 1.
- When: The member sends two concurrent `POST /api/ssh/connections/:connectionId/reset-host-key` requests with expected generation 1, then a third reset with the same stale generation.
- Then: One concurrent reset returns HTTP 200 and the other HTTP 409 with `SSH_GENERATION_CONFLICT` and message "SSH connection was modified by another request". The list shows the same host at generation 2. The third reset returns HTTP 409 and the list is unchanged.
