# Connector provider pages

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connector-provider-pages.test.tsx](connector-provider-pages.test.tsx).

## connector-provider-pages-001

Original test `A user links GitHub for agent mentions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L106).

- **Given** A user has an unconnected GitHub account and opens a signed GitHub connection link for @octo-dev.
- **When** They select Connect.
- **Then** Okou confirms the account is connected as @octo-dev, explains that mentioning the agent in issues or pull requests starts a chat, and offers Back to workflows.

## connector-provider-pages-002

Original test `A connected Slack workspace shows success and next actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L156).

- **Given** A user returns from Slack with a workspace that is already connected to Okou as Acme Workspace.
- **When** They open the Slack connection page.
- **Then** The page confirms Slack is connected to Acme Workspace and offers Open Slack and Back to settings.

## connector-provider-pages-003

Original test `Slack Connect continues to user OAuth before opening Slack`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L183).

- **Given** A user opens Slack Connect for workspace T_WORKSPACE, Slack user U_MEMBER, channel C_ORIGIN, and thread 42.0; the workspace is not connected.
- **When** They select Connect.
- **Then** Okou requests user OAuth scopes with those workspace, user, channel, and thread details, then opens the returned authorization URL.

## connector-provider-pages-004

Original test `Slack Connect fails closed when link status cannot be checked`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L218).

- **Given** A user opens Slack Connect, but checking link status fails with an unauthorized response.
- **When** The page loads.
- **Then** It displays “Slack link status is unavailable.” and does not offer Connect.

## connector-provider-pages-005

Original test `Slack Connect renders an API error when OAuth cannot start`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L243).

- **Given** A user can start Slack Connect, but the OAuth start request is rejected because only admins can connect the workspace.
- **When** They select Connect.
- **Then** The page displays “Only admins can connect this Slack workspace.”

## connector-provider-pages-006

Original test `Slack Connect blocks an account already connected to another Okou user`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L272).

- **Given** A user opens Slack Connect for a Slack account already connected to another Okou user.
- **When** The page loads.
- **Then** It explains that the Slack account is already connected and must be disconnected there first, and offers Back to settings.

## connector-provider-pages-007

Original test `Slack Connect explains a workspace mismatch`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L295).

- **Given** A user opens Slack Connect for a different workspace while their current Okou organization is connected to Acme Workspace.
- **When** The page loads.
- **Then** It explains that the Slack workspace does not match and identifies Acme Workspace as the organization’s current connection; it offers Back to settings.

## connector-provider-pages-008

Original test `Slack Connect offers an OAuth-verified account switch`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L324).

- **Given** A user opens Slack Connect for a different Slack account than the one currently connected to the workspace.
- **When** They choose to switch to U_NEW_ACCOUNT.
- **Then** Okou requests user OAuth scopes for that workspace and requested account, then opens the returned authorization URL. The page also offers an option to keep U_CURRENT_ACCOUNT.

## connector-provider-pages-009

Original test `An invalid Telegram connection link is rejected at /telegram/connect`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L366).

- **Given** A user opens /telegram/connect with a connection link whose signature is invalid.
- **When** The page loads.
- **Then** It reports that the connection link is invalid because its signature is not valid, and does not offer Connect.

## connector-provider-pages-010

Original test `An invalid Telegram connection link is rejected at /settings/telegram`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L366).

- **Given** A user opens /settings/telegram with a connection link whose signature is invalid.
- **When** The page loads.
- **Then** It reports that the connection link is invalid because its signature is not valid, and does not offer Connect.

## connector-provider-pages-011

Original test `A user links their account to the official Telegram bot at /telegram/connect`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L385).

- **Given** A user opens /telegram/connect with a valid signed link to the official Telegram bot.
- **When** They select Connect.
- **Then** Okou confirms the account is connected and tells them to message the bot to start chatting. Open Telegram links to https://t.me/agent_bot in a new tab; Back to settings points to /works, and the connection signature is absent from the URL.

## connector-provider-pages-012

Original test `A user links their account to the official Telegram bot at /settings/telegram`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L385).

- **Given** A user opens /settings/telegram with a valid signed link to the official Telegram bot.
- **When** They select Connect.
- **Then** Okou confirms the account is connected and tells them to message the bot to start chatting. Open Telegram links to https://t.me/agent_bot in a new tab; Back to settings points to /works, and the connection signature is absent from the URL.

## connector-provider-pages-013

Original test `A successful Feishu callback opens the connected bot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-provider-pages.test.tsx#L469).

- **Given** An unauthenticated user returns from Feishu OAuth with code oauth-code and state oauth-state.
- **When** The callback succeeds with a redirect URL to open the connected bot.
- **Then** The page shows “Connecting Feishu…” with the Feishu icon and navigates to the returned bot URL. The callback includes the code, state, and JSON response mode, and the page reads only the Feishu catalog entry.
