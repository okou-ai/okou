# Connectors cloudflare access

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connectors-cloudflare-access.test.tsx](connectors-cloudflare-access.test.tsx).

## connectors-cloudflare-access-001

Original test `Private network lists Cloudflare Access configurations`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-cloudflare-access.test.tsx#L56).

- **Given** A private-network connectors page has one Cloudflare Access configuration named “Protected applications,” alongside configured SSH and VNC connections.
- **When** The user opens the private-network scope.
- **Then** The private-network connectors view is visible, “Protected applications” is listed, and the page provides an “Add network” button and a “Manage Protected applications” link.
