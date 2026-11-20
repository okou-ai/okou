# Remote connection order

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [remote-connection-order.test.tsx](remote-connection-order.test.tsx).

## remote-connection-order-001

Original test `Remote host names follow the active Chinese locale`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-connection-order.test.tsx#L30).

- **Given** The remote-connections page is open in the Simplified Chinese locale and shows hosts named 上海-11, 广州-2, and 北京.
- **When** The remote host list loads.
- **Then** The hosts appear in this order: 北京, 广州-2, 上海-11.

## remote-connection-order-002

Original test `Remote connections use natural name order`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-connection-order.test.tsx#L59).

- **Given** The remote-connections page has SSH and VNC hosts whose names include android and numbered dev names, including dev-1 and DEV-1.
- **When** The remote host list loads.
- **Then** SSH hosts appear in natural name order—android, DEV-1, dev-1, dev-2, dev-11—followed by VNC hosts in the corresponding natural order, with desktop- prefixed names.

## remote-connection-order-003

Original test `A chat keeps remote choices in natural name order across access states with existing thread false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-connection-order.test.tsx#L81).

- **Given** A user opens a new chat, and remote access choices include SSH and VNC hosts named android and numbered dev names; dev-11 is enabled by default, while dev-2 has no default enabled state.
- **When** The user opens Connectors and then Remote access.
- **Then** Computer Use hosts are listed in natural name order. The Connections list contains 10 choices, with naturally ordered SSH choices followed by naturally ordered VNC choices. SSH dev-11 shows Default (On), and SSH dev-2 shows Default (Off).

## remote-connection-order-004

Original test `A chat keeps remote choices in natural name order across access states with existing thread true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/remote-connection-order.test.tsx#L81).

- **Given** A user opens an existing chat, and remote access choices include SSH and VNC hosts named android and numbered dev names; dev-11 is enabled by default, while dev-2 has no default enabled state and is enabled for this thread.
- **When** The user opens Connectors and then Remote access.
- **Then** Computer Use hosts are listed in natural name order. The Connections list contains 10 choices, with naturally ordered SSH choices followed by naturally ordered VNC choices. SSH dev-11 shows Default (On), and SSH dev-2 shows On.
