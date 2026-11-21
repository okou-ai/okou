# Connectors ssh

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connectors-ssh.test.tsx](connectors-ssh.test.tsx).

## connectors-ssh-001

Original test `Management scope changes show current data on return`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-ssh.test.tsx#L50).

- **Given** The user is viewing remote-control connections and a private-network configuration, with one SSH host and a private-network configuration available.
- **When** The SSH host and private-network data change while the user switches between the two scopes, and the user returns to each scope.
- **Then** Each scope shows the latest data after returning: the SSH host updates from Original SSH host to Updated SSH host and then Latest SSH host; the network updates from Original private network to Network after SSH change and then Latest private network.

## connectors-ssh-002

Original test `SSH warnings use the current connection instance (1, 2026-08-01T00:00:00Z)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-ssh.test.tsx#L113).

- **Given** Host 1 has an SSH authentication-failure observation whose connection creation time is 2026-08-01T00:00:00Z and generation is 1, while Host 2 has a network-failure observation for its current connection.
- **When** The user opens Host 1's details and then returns to the connections list and manages Host 2.
- **Then** Host 1 does not show an SSH authentication-failed warning because the observation is for a different connection instance. Host 2 shows that its last SSH connection failed.

## connectors-ssh-003

Original test `SSH warnings use the current connection instance (2, 2026-09-01T00:00:00Z)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-ssh.test.tsx#L113).

- **Given** Host 1 has an SSH authentication-failure observation with generation 2 and creation time 2026-09-01T00:00:00Z, matching its current connection instance; Host 2 has a network-failure observation for its current connection.
- **When** The user opens Host 1's details and then returns to the connections list and manages Host 2.
- **Then** Host 1 does not show an SSH authentication-failed warning because the observation does not match its current generation. Host 2 shows that its last SSH connection failed.

## connectors-ssh-004

Original test `Remote control keeps saved hosts available when SSH diagnostics fail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-ssh.test.tsx#L150).

- **Given** Two saved SSH hosts are available in the remote-control scope, but loading SSH diagnostic observations returns a server error.
- **When** The user opens the SSH-filtered remote-connections view.
- **Then** Host 2 remains available in the list, and the private server-error message is not shown.

## connectors-ssh-005

Original test `Deleting an SSH host referenced by VNC explains how to resolve the dependency`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-ssh.test.tsx#L176).

- **Given** An SSH host named VNC gateway is referenced by a VNC route, and deleting the host returns an in-use conflict.
- **When** The user attempts to delete the SSH connection.
- **Then** The confirmation dialog explains that the SSH host is used by a VNC route and says to switch the route explicitly to Direct. The private dependency detail is not shown, and the dialog remains open.
