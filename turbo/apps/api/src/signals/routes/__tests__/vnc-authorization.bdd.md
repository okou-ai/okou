# vnc-authorization

## vnc-authorization-001

- Vitest: "VNC chat authorization > approves just this host in this chat and enqueues one continuation across repeated decisions"
- Mode: run
- Given: A member has a chat Run executing on an official Runner, and a VNC host "Work Mac" that is explicitly disabled for the Run's chat thread. The Run's Agent token is available.
- When: The Agent calls `POST /api/vnc/authorizations` twice with the host, a reason and a callback prompt; the member tries `POST /api/vnc/authorizations/:id/approve` while the Run is active, and the Agent tries to approve with its own token. After the Run completes, the member sends two concurrent approvals, the continuation Run's Agent lists `GET /api/vnc/hosts`, the member approves again, reads `GET /api/chat-threads/:threadId/remote-access` for a new chat and for the original chat, disables the host for the original chat via `PUT /api/chat-threads/:threadId/remote-access/vnc/:connectionId`, reads `GET /api/vnc/authorizations/:id` and approves once more.
- Then: The request returns HTTP 200 as `pending`, not enabled, blocked by `run_active` with no required SSH hosts, and the repeated request returns the same ID. The early member approval returns HTTP 409 and the Agent approval returns HTTP 401 or 403. Both concurrent approvals return HTTP 200 with `approved`, enabled and no pending continuation, and the thread gains exactly one `input.prompt` continuation event linked to the request. The continuation Agent's inventory includes the host as `ready`. The later approval returns HTTP 200. The new chat shows the host disabled, while the original chat shows it enabled from an `override` with the default off. After the chat override is disabled, the request reads `revoked` and approval returns HTTP 409.

## vnc-authorization-002

- Vitest: "VNC chat authorization > keeps companion connector permissions separate and permits denial without granting host access"
- Mode: run
- Given: A member has a chat Run executing on an official Runner and a VNC host disabled for the chat. The Agent requests host access via `POST /api/vnc/authorizations` together with a required `cloudflare` `dns.write` connector permission, and the Run then completes.
- When: The member reads `GET /api/vnc/authorizations/:id`, calls `POST /api/vnc/authorizations/:id/approve`, then calls `POST /api/vnc/authorizations/:id/deny` twice.
- Then: The read shows `approvalBlockedReason: "permissions_required"`. Approval returns HTTP 409. The first denial returns HTTP 200 with status `denied` and not enabled, and the repeated denial also returns HTTP 200.

## vnc-authorization-003

- Vitest: "VNC chat authorization > requires fresh review after a host configuration change and hides requests from other owners"
- Mode: run
- Given: A member has a chat Run whose Agent requested access to a VNC host via `POST /api/vnc/authorizations`; the Run has completed. Another user of the same workspace exists.
- When: The other user reads `GET /api/vnc/authorizations/:id`; the owner then changes the host address via `PATCH /api/vnc/connections/:connectionId`, reads the request and tries to approve it.
- Then: The other user receives HTTP 404. After the host change, the request reads `stale`, not enabled, blocked by `host_changed`, and approval returns HTTP 409.

## vnc-authorization-004

- Vitest: "VNC chat authorization > expires the request without adding a temporary lifetime to the chat host selection"
- Mode: run
- Given: A member has a chat Run whose Agent requested access to a VNC host; the Run has completed. The clock then advances just over one hour.
- When: The member reads `GET /api/vnc/authorizations/:id` and calls `POST /api/vnc/authorizations/:id/approve`.
- Then: The read shows status `expired` and not enabled, and approval returns HTTP 410.

## vnc-authorization-005

- Vitest: "VNC chat authorization > revokes approved access through the review endpoint and keeps repeated decisions safe"
- Mode: run
- Given: A member has a chat Run whose Agent requested access to a VNC host; the Run has completed.
- When: The member approves via `POST /api/vnc/authorizations/:id/approve`, the continuation Run is inspected, the member calls `POST /api/vnc/authorizations/:id/revoke`, reads `GET /api/chat-threads/:threadId/remote-access`, revokes again and then tries to approve.
- Then: Approval returns HTTP 200 and creates a continuation `input.prompt` linked to the request, whose system prompt includes `okou vnc request-access <connection-id> --reason <purpose>` and "continuation only on the host request". Revocation returns HTTP 200 with `revoked`, not enabled and no pending continuation, and the chat shows the host disabled from an `override`. The repeated revocation returns HTTP 200 and the later approval returns HTTP 409.

## vnc-authorization-006

- Vitest: "VNC chat authorization > waits for both SSH transport and KDC hosts without implicitly enabling either"
- Mode: run
- Given: A member has a chat Run and two SSH connections, "Desktop tunnel" and "KDC tunnel". The member creates a Kerberos VNC host (`qemu_kerberos_password`, `qemu_x509_gssapi`) reached through "Desktop tunnel" with its KDC reached through "KDC tunnel". The Agent requests access to this host and the Run completes.
- When: For each SSH dependency in turn, the member reads `GET /api/vnc/authorizations/:id`, tries to approve, reads the chat's remote access, and enables that SSH host for the chat via `PUT /api/chat-threads/:threadId/remote-access/ssh/:connectionId`; finally the member reads and approves the request.
- Then: The request lists two required SSH hosts. Before each SSH host is enabled, the request is blocked by `ssh_access_required`, approval returns HTTP 409, and the chat shows that SSH host disabled. Once both are enabled, the blocked reason is null, approval returns HTTP 200 with `approved` and enabled, and a continuation `input.prompt` linked to the request is created.

## vnc-authorization-007

- Vitest: "VNC chat authorization > approves a saved cloudflare_access VNC route without requiring an SSH host"
- Mode: run
- Given: A member has a chat Run and a VNC host. Parameter row `cloudflare_access`: the member saves a Cloudflare Access configuration via `POST /api/cloudflare-access/configs` and switches the host to a `cloudflare_access` transport on port 443 with `x509_vnc` security. The Agent requests access to the host and the Run completes.
- When: The member reads `GET /api/vnc/authorizations/:id` and approves via `POST /api/vnc/authorizations/:id/approve`.
- Then: The request lists no required SSH hosts, the blocked reason is null, approval returns HTTP 200 with the host enabled, and a continuation `input.prompt` linked to the request is created.

## vnc-authorization-008

- Vitest: "VNC chat authorization > approves a saved tailscale VNC route without requiring an SSH host"
- Mode: run
- Given: A member has a chat Run and a VNC host. Parameter row `tailscale`: the member saves a Tailscale configuration with tag `tag:okou` via `POST /api/tailscale/configs` and switches the host to a `tailscale` transport on port 5900 with `x509_vnc` security. The Agent requests access to the host and the Run completes.
- When: The member reads `GET /api/vnc/authorizations/:id` and approves via `POST /api/vnc/authorizations/:id/approve`.
- Then: The request lists no required SSH hosts, the blocked reason is null, approval returns HTTP 200 with the host enabled, and a continuation `input.prompt` linked to the request is created.
