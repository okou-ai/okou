# Remote credential order

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [remote-credential-order.test.tsx](remote-credential-order.test.tsx).

## remote-credential-order-001

Original test `ssh credentials and their associated hosts use natural order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-credential-order.test.tsx#L108).

- **Given** SSH and VNC credentials are saved with hosts whose names include mixed case, numeric suffixes, and Android; host IDs are deliberately in a different order.
- **When** I open the remote-control credentials view for SSH.
- **Then** Credential cards appear as Android login, login-2, and login-11. The hosts listed under login-11 appear as android, then dev-11.

## remote-credential-order-002

Original test `vnc credentials and their associated hosts use natural order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-credential-order.test.tsx#L108).

- **Given** SSH and VNC credentials are saved with hosts whose names include mixed case, numeric suffixes, and Android; host IDs are deliberately in a different order.
- **When** I open the remote-control credentials view for VNC.
- **Then** Credential cards appear as Android login, login-2, and login-11. The hosts listed under login-11 appear as desktop-android, then desktop-dev-11.

## remote-credential-order-003

Original test `ssh saved login choices sort their displayed host labels`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-credential-order.test.tsx#L140).

- **Given** Saved SSH and VNC logins have hosts named android, DEV-1, dev-1, dev-2, and dev-11, with host IDs in a different order.
- **When** I start setting up an SSH connection and open the saved login details chooser.
- **Then** Host labels appear in this order: android, dev-11; DEV-1, dev-1; dev-2. Selecting the first label shows the login description operator-0 · Password.

## remote-credential-order-004

Original test `vnc saved login choices sort their displayed host labels`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-credential-order.test.tsx#L140).

- **Given** Saved SSH and VNC logins have hosts named android, DEV-1, dev-1, dev-2, and dev-11, with host IDs in a different order.
- **When** I start setting up a VNC connection, enter screen.example.com, and open the saved login details chooser.
- **Then** Host labels appear in this order: desktop-android, desktop-dev-11; desktop-DEV-1, desktop-dev-1; desktop-dev-2. Selecting the first label shows the description VNC password.
