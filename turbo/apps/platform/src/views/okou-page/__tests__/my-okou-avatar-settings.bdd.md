# My okou avatar settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [my-okou-avatar-settings.test.tsx](my-okou-avatar-settings.test.tsx).

## my-okou-avatar-settings-001

Original test `The home avatar opens My Okou settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/my-okou-avatar-settings.test.tsx#L20).

- **Given** A member is on the home page with My Okou enabled and workspace instructions available.
- **When** They click the home avatar labeled “My Okou.”
- **Then** A Settings dialog opens showing the workspace instructions and explanatory text. Closing it dismisses the dialog, leaves the home path unchanged, and keeps the avatar present.

## my-okou-avatar-settings-002

Original test `The chat reply avatar opens My Okou settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/my-okou-avatar-settings.test.tsx#L20).

- **Given** A member is viewing a chat reply with My Okou enabled and workspace instructions available.
- **When** They focus the chat reply avatar labeled “My Okou” and press Enter.
- **Then** A Settings dialog opens showing the workspace instructions and explanatory text. Closing it dismisses the dialog, leaves the chat path unchanged, and keeps the avatar present.
