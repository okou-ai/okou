# Vnc access

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [vnc-access.test.tsx](vnc-access.test.tsx).

## vnc-access-001

Original test `Chat VNC setup appears and filters`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/vnc-access.test.tsx#L19).

- **Given** The user is viewing Scout’s chat, and the VNC connection summary reports zero configured connections.
- **When** They open Connectors, choose Add connectors, and search for “vnc.”
- **Then** The connector dialog includes a “Manage VNC” link to /connectors?scope=remote-control&type=vnc and does not show “Manage SSH hosts.”
