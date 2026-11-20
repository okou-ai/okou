# Vnc authorization

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [vnc-authorization.test.tsx](vnc-authorization.test.tsx).

## vnc-authorization-001

Original test `The inline card allows only this chat and shows the desktop and access effect`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-authorization.test.tsx#L75).

- **Given** A chat contains a VNC access request for Work Mac at ssh.example.com:5900, with access limited to this chat.
- **When** The user opens access details, dismisses them, allows access, and then revokes it.
- **Then** The card describes viewing and controlling the desktop and shows the request reason. Allowing and revoking access each display the corresponding confirmation.

## vnc-authorization-002

Original test `The direct page waits for connector approvals and requesting Run completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-authorization.test.tsx#L116).

- **Given** A VNC request is blocked by a required Cloudflare dns.write permission.
- **When** The connector permission changes to a requesting Run in progress, then the Run finishes and the user allows access.
- **Then** Allowing is disabled while either prerequisite remains, with the relevant explanation displayed. Once both prerequisites clear, allowing is enabled and access is approved.

## vnc-authorization-003

Original test `A forwarded card cannot approve a request belonging to a different chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-authorization.test.tsx#L151).

- **Given** A VNC request linked in one chat belongs to a different chat thread.
- **When** The user opens the forwarded request card.
- **Then** The card says the request is unavailable and asks for a new request; it cannot be approved.

## vnc-authorization-004

Original test `Continuation failure can be retried on the approved request without a second grant`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-authorization.test.tsx#L167).

- **Given** A VNC request can be approved, but continuing its task initially fails with a service error.
- **When** The user allows access, then retries the task continuation.
- **Then** The retry completes without granting access a second time; the card ends with only the revoke action available.

## vnc-authorization-005

Original test `VNC and SSH requests with the same ID remain separate actionable cards`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-authorization.test.tsx#L206).

- **Given** A chat contains VNC and SSH authorization links that share the same ID.
- **When** The user views the chat cards.
- **Then** Separate actionable cards appear for VNC and SSH, identifying VNC access and operator@ssh.example.com:22 respectively.

## vnc-authorization-006

Original test `The VNC review waits for separate tunnel and KDC approvals and refreshes on SSH changes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-authorization.test.tsx#L234).

- **Given** A VNC request requires separate Desktop tunnel and KDC tunnel SSH approvals, both initially disabled.
- **When** The SSH host approvals change so both tunnels are enabled.
- **Then** The VNC approval starts disabled with a required-SSH-host explanation and names both tunnels. After the SSH change, approval becomes enabled.

## vnc-authorization-007

Original test `The review disables an obsolete request after the VNC configuration publishes cloudflare-access:changed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-authorization.test.tsx#L273).

- **Given** A VNC request is initially current and can be approved.
- **When** The VNC host configuration changes and the request becomes obsolete.
- **Then** The card explains that the host configuration changed and a new request is needed, marks the VNC request changed, and offers no actions.

## vnc-authorization-008

Original test `The review disables an obsolete request after the VNC configuration publishes tailscale:changed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-authorization.test.tsx#L273).

- **Given** A VNC request is initially current and can be approved.
- **When** The Tailscale configuration changes and the request becomes obsolete.
- **Then** The card explains that the host configuration changed and a new request is needed, marks the VNC request changed, and offers no actions.
