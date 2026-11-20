# Connectors remote control

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connectors-remote-control.test.tsx](connectors-remote-control.test.tsx).

## connectors-remote-control-001

Original test `Remote control lists each connection and filters credentials by type`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-remote-control.test.tsx#L19).

- **Given** The remote-control scope has two SSH connections, Deployment and Analytics, and one VNC connection, Design desktop, with matching SSH and VNC credentials available.
- **When** The user opens Manage credentials and selects the VNC credential type.
- **Then** The remote connections list shows Deployment, Analytics, and Design desktop, and the remote-control count is 3. The credentials view initially shows Deployment login, then shows Desktop login for VNC and includes Add credential.
