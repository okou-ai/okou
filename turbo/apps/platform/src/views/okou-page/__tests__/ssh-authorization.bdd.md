# Ssh authorization

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [ssh-authorization.test.tsx](ssh-authorization.test.tsx).

## ssh-authorization-001

Original test `The inline card allows only this chat and shows the remote user and access effect`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-authorization.test.tsx#L70).

- **Given** A pending SSH access request appears in a chat that owns the request. It identifies deploy@ssh.example.com:22 and states that access is limited to this host and chat.
- **When** The user opens Access details, allows access, and then revokes it.
- **Then** The details explain commands and file transfers and show the request reason. Access is allowed after one approval and can then be revoked.

## ssh-authorization-002

Original test `The direct page waits for connector approvals and requesting Run completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-authorization.test.tsx#L104).

- **Given** An SSH request requires the accompanying Cloudflare dns.write permission, and the requesting Run is initially blocked by that requirement.
- **When** The user opens the request page, then connector permission and Run state updates arrive.
- **Then** Approval is disabled while connector approval is required and the required permission is shown. If the Run is active, the page says to wait for it to finish; after the block clears, approval becomes available and succeeds.

## ssh-authorization-003

Original test `A forwarded card cannot approve a request belonging to a different chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-authorization.test.tsx#L139).

- **Given** A chat contains a forwarded link to an SSH request owned by a different chat.
- **When** The user opens the forwarded request card.
- **Then** The request is unavailable, and the user is told to ask for a new request.

## ssh-authorization-004

Original test `Continuation failure can be retried on the approved request without a second grant`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ssh-authorization.test.tsx#L155).

- **Given** An SSH access request is pending approval.
- **When** The user approves it, continuation fails with a service-unavailable response, and the user retries Continue task.
- **Then** The approved access remains in place while continuation is pending. The retry succeeds without another grant; two continuation attempts occur and only Revoke remains available.
