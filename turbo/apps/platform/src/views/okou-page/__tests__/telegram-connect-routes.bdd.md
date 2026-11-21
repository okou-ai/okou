# Telegram connect routes

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [telegram-connect-routes.test.tsx](telegram-connect-routes.test.tsx).

## telegram-connect-routes-001

Original test `/settings/telegram keeps the standalone connection page and complete URL context`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-connect-routes.test.tsx#L29).

- **Given** A signed Telegram connection URL with repeated context parameters and a fragment opens at /settings/telegram, and the account is already linked.
- **When** The connection page loads.
- **Then** The standalone page says Telegram is already connected and links to the bot. The URL is normalized to /settings/telegram while retaining its complete query and fragment, and no dialog appears.

## telegram-connect-routes-002

Original test `/telegram/connect keeps the standalone connection page and complete URL context`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-connect-routes.test.tsx#L29).

- **Given** A signed Telegram connection URL with repeated context parameters and a fragment opens at /telegram/connect, and the account is already linked.
- **When** The connection page loads.
- **Then** The standalone page says Telegram is already connected and links to the bot. The URL is normalized to /settings/telegram while retaining its complete query and fragment, and no dialog appears.

## telegram-connect-routes-003

Original test `/settings/telegram requires sign-in with the full connection URL as its return destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-connect-routes.test.tsx#L60).

- **Given** A signed Telegram connection URL with repeated context parameters and a fragment opens at /settings/telegram for a signed-out user.
- **When** The page requires authentication.
- **Then** The user is sent to sign-in with the full original connection URL, including its query and fragment, as the return destination.

## telegram-connect-routes-004

Original test `/telegram/connect requires sign-in with the full connection URL as its return destination`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-connect-routes.test.tsx#L60).

- **Given** A signed Telegram connection URL with repeated context parameters and a fragment opens at /telegram/connect for a signed-out user.
- **When** The page requires authentication.
- **Then** The user is sent to sign-in with the full original connection URL, including its query and fragment, as the return destination.

## telegram-connect-routes-005

Original test `/settings/telegram keeps the signed link while setup opens separately`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-connect-routes.test.tsx#L75).

- **Given** A signed Telegram connection URL with prompt and repeated context parameters opens at /settings/telegram, and the account still needs setup.
- **When** The page loads.
- **Then** The setup page appears while the browser remains on /settings/telegram with all query parameters preserved. An Open setup link opens /onboarding in a new tab, and Connect is not shown.

## telegram-connect-routes-006

Original test `/telegram/connect keeps the signed link while setup opens separately`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-connect-routes.test.tsx#L75).

- **Given** A signed Telegram connection URL with prompt and repeated context parameters opens at /telegram/connect, and the account still needs setup.
- **When** The page loads.
- **Then** The setup page appears while the browser is on /settings/telegram with all query parameters preserved. An Open setup link opens /onboarding in a new tab, and Connect is not shown.
