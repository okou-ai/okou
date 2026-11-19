# Remote network order

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [remote-network-order.test.tsx](remote-network-order.test.tsx).

## remote-network-order-001

Original test `Private networks are sorted within their scope`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-network-order.test.tsx#L73).

- **Given** Personal and organization private networks have names with Android and numeric suffixes.
- **When** I open the private-network page.
- **Then** Personal networks appear as Android network, Network-1, Network-2, then Network-11. Organization networks appear as Org-2, then Org-11.

## remote-network-order-002

Original test `A tailscale network shows linked hosts in natural order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-network-order.test.tsx#L103).

- **Given** A Tailscale network is linked to SSH hosts named android, DEV-1, dev-1, dev-2, and dev-11 and VNC hosts named with the same labels prefixed by desktop-.
- **When** I open the connections using that Tailscale network.
- **Then** SSH host labels appear in natural order: android, DEV-1, dev-1, dev-2, dev-11. They are followed by VNC labels in the same order with the desktop- prefix.

## remote-network-order-003

Original test `A cloudflare network shows linked hosts in natural order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-network-order.test.tsx#L103).

- **Given** A Cloudflare network is linked to SSH hosts named android, DEV-1, dev-1, dev-2, and dev-11 and VNC hosts named with the same labels prefixed by desktop-.
- **When** I open the connections using that Cloudflare network.
- **Then** SSH host labels appear in natural order: android, DEV-1, dev-1, dev-2, dev-11. They are followed by VNC labels in the same order with the desktop- prefix.
