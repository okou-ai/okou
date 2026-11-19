# Telegram settings

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [telegram-settings.test.tsx](telegram-settings.test.tsx).

## telegram-settings-001

Original test `/settings/telegram reads the official bot and offers a real connect action without trusting result markers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L69).

- **Given** The official Telegram bot is not connected.
- **When** The user opens /settings/telegram.
- **Then** The official bot is shown with an enabled “Continue with Telegram” action. The page does not show an already-connected message and is at /settings/telegram.

## telegram-settings-002

Original test `/settings/telegram?status=connected reads the official bot and offers a real connect action without trusting result markers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L69).

- **Given** The official Telegram bot is not connected.
- **When** The user opens /settings/telegram?status=connected.
- **Then** The official bot is shown with an enabled “Continue with Telegram” action. The status marker does not imply a connection, and the page is at /settings/telegram.

## telegram-settings-003

Original test `/telegram/connect reads the official bot and offers a real connect action without trusting result markers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L69).

- **Given** The official Telegram bot is not connected.
- **When** The user opens /telegram/connect.
- **Then** The official bot is shown with an enabled “Continue with Telegram” action. The page is at /settings/telegram.

## telegram-settings-004

Original test `A bare result and reload display the verified connection and never bind or launch Telegram`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L88).

- **Given** The official Telegram bot is already connected to Telegram user 99001.
- **When** The user opens /settings/telegram?status=connected and the page reloads.
- **Then** The verified connected state displays “Send the bot a message in Telegram to start chatting” and links to https://t.me/support_bot in a new tab. Reloading sends no link request and does not open or launch Telegram.

## telegram-settings-005

Original test `Signed identity mismatch is a controlled account-management choice, with no silent unlink or bind`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L119).

- **Given** A signed connect link requests Telegram user 99001, but the connected Telegram account is user 99002 with username actual_name.
- **When** The user opens the settings page with that signed link.
- **Then** The page says a different Telegram account is connected and shows the actual username and requested user ID. It offers “Manage connected account” linking to /works, does not offer Connect, and keeps the signature in the URL.

## telegram-settings-006

Original test `Signed confirmation consumes proof only after the POST and displays a real readback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L138).

- **Given** The official bot is not connected, and the user has a signed link for Telegram user 99001.
- **When** The user confirms Connect while the server request is pending, then the server accepts it and the connection is read back.
- **Then** The signature remains in the URL and no success message appears while the request is pending. After acceptance, the page shows the connected chat instructions, removes the signature and Telegram user from the query, preserves both context values and the URL hash, and makes only one link request.

## telegram-settings-007

Original test `A signed server rejection 400 stays visible without consuming the pending link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L203).

- **Given** The official bot is not connected, and the user has a signed connect link.
- **When** The user confirms Connect and the server rejects the link with status 400.
- **Then** The alert says “Invalid or expired connect link.” Connect remains enabled, the signature remains in the URL, and the Open Telegram link still points to https://t.me/support_bot.

## telegram-settings-008

Original test `A signed server rejection 409 stays visible without consuming the pending link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L203).

- **Given** The official bot is not connected, and the user has a signed connect link.
- **When** The user confirms Connect and the server rejects the link with status 409.
- **Then** The alert says “This Telegram account is already connected elsewhere.” Connect remains enabled, the signature remains in the URL, and the Open Telegram link still points to https://t.me/support_bot.

## telegram-settings-009

Original test `Foreground focus recovers a missed connection without replaying proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L243).

- **Given** The official bot initially appears disconnected in standalone display mode.
- **When** The connection becomes established while the page is open, and the window receives a focus event.
- **Then** The page recovers the connected state and shows “Send the bot a message in Telegram to start chatting.” It does not need to replay connect proof.

## telegram-settings-010

Original test `Foreground visibilitychange recovers a missed connection without replaying proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L243).

- **Given** The official bot initially appears disconnected in standalone display mode.
- **When** The connection becomes established while the page is open, and the document receives a visibilitychange event.
- **Then** The page recovers the connected state and shows “Send the bot a message in Telegram to start chatting.” It does not need to replay connect proof.

## telegram-settings-011

Original test `A member without a default agent sees the administrator prerequisite with the link intact`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L268).

- **Given** The user is not an administrator and the workspace has no default agent; the user has a signed connect link.
- **When** The user opens the Telegram settings page.
- **Then** The page asks the user to ask a workspace administrator. It offers neither Open setup nor Connect, and keeps the signature in the URL.

## telegram-settings-012

Original test `Returning from setup restores signed confirmation without copying or consuming proof`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L288).

- **Given** The workspace has no default agent, and the user has a signed connect link and a URL hash.
- **When** The user opens the page, then setup becomes complete and the page receives a focus event.
- **Then** The page initially offers “Finish account setup” with an Open setup link to /onboarding. After setup completes, Connect becomes enabled; the signature and URL hash remain intact.

## telegram-settings-013

Original test `An unsupported or incomplete entry bot=unknown fails closed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L328).

- **Given** The user opens Telegram settings with the unsupported query bot=unknown.
- **When** The page processes the incomplete connect-link query.
- **Then** It displays “Connect link is incomplete” and offers no Connect button.

## telegram-settings-014

Original test `An unsupported or incomplete entry bot=official&bot=official fails closed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L328).

- **Given** The user opens Telegram settings with duplicate bot values: bot=official&bot=official.
- **When** The page processes the incomplete connect-link query.
- **Then** It displays “Connect link is incomplete” and offers no Connect button.

## telegram-settings-015

Original test `An unsupported or incomplete entry bot=official&tgUser=99001 fails closed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/telegram-settings.test.tsx#L328).

- **Given** The user opens Telegram settings with bot=official&tgUser=99001 but no signed proof.
- **When** The page processes the incomplete connect-link query.
- **Then** It displays “Connect link is incomplete” and offers no Connect button.
