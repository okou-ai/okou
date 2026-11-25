# ssh-authorization

## ssh-authorization-001

- Vitest: "SSH chat authorization > approves just this host in this chat and enqueues one continuation across repeated decisions"
- Mode: run
- Given: A member has a running chat Run whose Thread has SSH host `Work Mac` (`ssh.example.com`, user `deploy`) disabled by a Thread override.
- When: The Run's Agent token calls `POST /api/ssh/authorizations` twice; the member and the Agent token try `POST /api/ssh/authorizations/:id/approve` while the Run is active; after the Run completes the member sends two concurrent approvals, approves once more, reads `GET /api/chat-threads/:threadId/remote-access` for another and the original Thread, then disables the host override.
- Then: Creation returns HTTP 200 `pending`, not enabled, blocked by `run_active`, username `deploy`, and the repeat returns the same ID. During the Run the member's approval returns 409 and the Agent token's returns 401 or 403. Both concurrent approvals return 200 with `approved`, enabled and no pending continuation, and exactly one continuation prompt is launched; its Run's Agent token lists the host as `ready` in `GET /api/ssh/hosts`. The extra approval returns 200, the other Thread shows the host disabled, the original Thread shows it enabled by `override` with default off, and after disabling the override the request reads `revoked` and approval returns 409.

## ssh-authorization-002

- Vitest: "SSH chat authorization > keeps companion connector permissions separate and permits denial without granting host access"
- Mode: run
- Given: A member has a running chat Run whose Thread has an SSH host disabled by a Thread override. The Run's Agent token requests access with `POST /api/ssh/authorizations` that also requires Cloudflare `dns.write`, and the Run then completes.
- When: The member reads `GET /api/ssh/authorizations/:id`, tries `POST /api/ssh/authorizations/:id/approve`, then calls `POST /api/ssh/authorizations/:id/deny` twice.
- Then: The request is blocked by `permissions_required` and approval returns HTTP 409. The first denial returns HTTP 200 with `denied` and not enabled, and the repeated denial also returns HTTP 200.

## ssh-authorization-003

- Vitest: "SSH chat authorization > requires fresh review after a host configuration change and hides requests from other owners"
- Mode: run
- Given: A member has a completed chat Run whose Agent token requested SSH access with `POST /api/ssh/authorizations`. Another user exists in the same organization.
- When: The other user reads `GET /api/ssh/authorizations/:id`; the member changes the host to `replacement.example.com` with `PATCH /api/ssh/connections/:connectionId`, reads the request and tries `POST /api/ssh/authorizations/:id/approve`.
- Then: The other user receives HTTP 404. The host update returns HTTP 200, the request reads `stale`, not enabled, blocked by `host_changed`, and approval returns HTTP 409.

## ssh-authorization-004

- Vitest: "SSH chat authorization > expires the request without adding a temporary lifetime to the chat host selection"
- Mode: run
- Given: A member has a completed chat Run whose Agent token requested SSH access with `POST /api/ssh/authorizations`, and the clock then advances just over one hour.
- When: The member reads `GET /api/ssh/authorizations/:id` and tries `POST /api/ssh/authorizations/:id/approve`.
- Then: The request reads `expired` and not enabled, and approval returns HTTP 410.

## ssh-authorization-005

- Vitest: "SSH chat authorization > revokes approved access through the review endpoint and keeps repeated decisions safe"
- Mode: run
- Given: A member has a completed chat Run whose Agent token requested SSH access with `POST /api/ssh/authorizations`.
- When: The member approves with `POST /api/ssh/authorizations/:id/approve`, then revokes twice with `POST /api/ssh/authorizations/:id/revoke`, reads the Thread's remote access, and tries approving again.
- Then: Approval returns HTTP 200 and launches a continuation Run whose appended system prompt mentions `okou ssh request-access <connection-id> --reason <purpose>` and "attach continuation only to the SSH request". The revoke returns HTTP 200 with `revoked`, not enabled and no pending continuation; the Thread shows the host disabled by `override`. The repeated revoke returns 200 and the later approval returns 409.

## ssh-authorization-006

- Vitest: "SSH chat authorization > continues only after the shared companion permission is approved"
- Mode: run
- Given: A member has a running chat Run with an SSH host disabled for its Thread, and connected Slack through connector OAuth. The Run's Agent token requests SSH access with `POST /api/ssh/authorizations` requiring Slack `chat:write`, and the Run then completes.
- When: The member reads `GET /api/ssh/authorizations/:id`, grants Slack `chat:write` for one hour with `PUT /api/connector-permissions`, reads the request again, and approves with `POST /api/ssh/authorizations/:id/approve`.
- Then: Before the grant the request is blocked by `permissions_required`; the grant returns HTTP 200 and the block reason becomes null. Approval returns HTTP 200, enabled with no pending continuation, and a continuation prompt Run is launched in the Thread.
