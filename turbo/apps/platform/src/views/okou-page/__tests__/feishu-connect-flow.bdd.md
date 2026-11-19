# Feishu connect flow

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [feishu-connect-flow.test.tsx](feishu-connect-flow.test.tsx).

## feishu-connect-flow-001

Original test `feishu account connection > signed connection links require login and retain the complete return URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L32).

- **Given** A signed Feishu account-connection link is opened while the user is logged out.
- **When** The connection URL is loaded.
- **Then** The user is sent to sign-in, with the complete original URL preserved as the return URL.

## feishu-connect-flow-002

Original test `feishu account connection > authenticated message links pass their signed identity to account connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L46).

- **Given** An authenticated user opens a signed Feishu message connection link, with the Feishu feature switch off.
- **When** The link is processed.
- **Then** The complete signed identity, installation, chat, and timestamp data is submitted for account connection, and the browser opens the returned bot URL.

## feishu-connect-flow-003

Original test `feishu account connection > shows recovery guidance when a signed connection link is rejected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L73).

- **Given** A signed Feishu connection link is rejected as invalid or expired.
- **When** The user opens the link.
- **Then** A connection-failed page shows recovery guidance to return to Feishu and message the bot for a new link, along with a Back to settings link to /works.

## feishu-connect-flow-004

Original test `feishu account connection > shows the same recovery guidance for an incomplete connection link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L109).

- **Given** A Feishu connection URL is missing the signed connection details.
- **When** The user opens the incomplete URL.
- **Then** The page shows the same invalid-or-expired-link recovery guidance, directing the user to Feishu for a new link.

## feishu-connect-flow-005

Original test `feishu account connection > preserves other client errors`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L136).

- **Given** A signed Feishu account-connection request fails with a 400 BAD_REQUEST response stating “Finish setting up this bot before connecting.”
- **When** The user opens the connection link.
- **Then** Page startup rejects with that error message, which is also displayed on the page.

## feishu-connect-flow-006

Original test `feishu account connection > preserves server errors`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L136).

- **Given** A signed Feishu account-connection request fails with a 500 INTERNAL_SERVER_ERROR response stating “The connection service is unavailable.”
- **When** The user opens the connection link.
- **Then** Page startup rejects with that error message, which is also displayed on the page.

## feishu-connect-flow-007

Original test `feishu account connection > shows the provider on OAuth callbacks and returns to its bot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L158).

- **Given** A logged-out user opens a Feishu OAuth callback URL with signed state and an authorization code, and the callback response is pending.
- **When** The callback begins and then returns a bot URL.
- **Then** The page displays “Connecting Feishu…” while pending, submits the state, code, and JSON response mode, then redirects to the returned Feishu bot URL.

## feishu-connect-flow-008

Original test `lark account connection > signed connection links require login and retain the complete return URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L32).

- **Given** A signed Lark account-connection link is opened while the user is logged out.
- **When** The connection URL is loaded.
- **Then** The user is sent to sign-in, with the complete original URL preserved as the return URL.

## feishu-connect-flow-009

Original test `lark account connection > authenticated message links pass their signed identity to account connection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L46).

- **Given** An authenticated user opens a signed Lark message connection link, with the Lark feature switch off.
- **When** The link is processed.
- **Then** The complete signed identity, installation, chat, and timestamp data is submitted for account connection, and the browser opens the returned bot URL.

## feishu-connect-flow-010

Original test `lark account connection > shows recovery guidance when a signed connection link is rejected`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L73).

- **Given** A signed Lark connection link is rejected as invalid or expired.
- **When** The user opens the link.
- **Then** A connection-failed page shows recovery guidance to return to Lark and message the bot for a new link, along with a Back to settings link to /works.

## feishu-connect-flow-011

Original test `lark account connection > shows the same recovery guidance for an incomplete connection link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L109).

- **Given** A Lark connection URL is missing the signed connection details.
- **When** The user opens the incomplete URL.
- **Then** The page shows the same invalid-or-expired-link recovery guidance, directing the user to Lark for a new link.

## feishu-connect-flow-012

Original test `lark account connection > preserves other client errors`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L136).

- **Given** A signed Lark account-connection request fails with a 400 BAD_REQUEST response stating “Finish setting up this bot before connecting.”
- **When** The user opens the connection link.
- **Then** Page startup rejects with that error message, which is also displayed on the page.

## feishu-connect-flow-013

Original test `lark account connection > preserves server errors`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L136).

- **Given** A signed Lark account-connection request fails with a 500 INTERNAL_SERVER_ERROR response stating “The connection service is unavailable.”
- **When** The user opens the connection link.
- **Then** Page startup rejects with that error message, which is also displayed on the page.

## feishu-connect-flow-014

Original test `lark account connection > shows the provider on OAuth callbacks and returns to its bot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/feishu-connect-flow.test.tsx#L158).

- **Given** A logged-out user opens a Lark OAuth callback URL with signed state and an authorization code, and the callback response is pending.
- **When** The callback begins and then returns a bot URL.
- **Then** The page displays “Connecting Lark…” while pending, submits the state, code, and JSON response mode, then redirects to the returned Lark bot URL.
