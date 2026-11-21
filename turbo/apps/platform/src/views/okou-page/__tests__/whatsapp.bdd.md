# Whatsapp

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [whatsapp.test.tsx](whatsapp.test.tsx).

## whatsapp-001

Original test `WhatsApp connects with the same shared number and a prefilled code, updates in realtime and disconnects`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/whatsapp.test.tsx#L24).

- **Given** WhatsApp integration is enabled, configured with the shared number +12025550199, and initially unlinked; creating a link code returns 12345678.
- **When** The user connects WhatsApp, then the integration becomes linked and the user disconnects it.
- **Then** The dialog's link and QR destination are https://wa.me/12025550199?text=12345678, and it displays the code and Meta policy notice. A realtime update shows Connected (+4915123456789) and closes the dialog; disconnecting restores the Connect WhatsApp action.

## whatsapp-002

Original test `WhatsApp does not offer a connection before the shared number is configured`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/whatsapp.test.tsx#L96).

- **Given** WhatsApp integration is enabled but the shared number is not configured.
- **When** The user views the integration card.
- **Then** The card says “WhatsApp is not configured yet,” and Connect WhatsApp is disabled.

## whatsapp-003

Original test `WhatsApp opens from the keyboard and returns focus after Escape`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/whatsapp.test.tsx#L116).

- **Given** WhatsApp integration is enabled and configured, and the Connect WhatsApp button is focused.
- **When** The user presses Enter to open the connection dialog, then presses Escape.
- **Then** The dialog displays the link code, closes on Escape, and focus returns to the Connect WhatsApp button.

## whatsapp-004

Original test `WhatsApp stays hidden while its feature switch is off`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/whatsapp.test.tsx#L158).

- **Given** The WhatsApp feature switch is off.
- **When** The user views the integrations page.
- **Then** Phone is visible and WhatsApp is not shown.
