# Shared database browser

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-database-browser.test.ts](shared-database-browser.test.ts).

## shared-database-browser-001

Original test `Pass the page identity through the Vite shared worker URL`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/shared-database-browser.test.ts#L152).

- **Given** A member is signed in with an active organization while visiting the app at /chats.
- **When** The shared database worker is started.
- **Then** Its Vite worker URL uses the app origin and includes the organization ID and user ID. The module worker is named for that user and organization.

## shared-database-browser-002

Original test `Return Clerk's cached token when the shared worker requests it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/shared-database-browser.test.ts#L171).

- **Given** A signed-in member has a cached Clerk token and the shared database worker is connected.
- **When** The worker requests a token.
- **Then** The bridge returns the cached token for that request, asking Clerk for the default token.

## shared-database-browser-003

Original test `Report a token-error for Clerk's missing session and serve a later valid token`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/shared-database-browser.test.ts#L193).

- **Given** The shared database worker is connected, but Clerk has no session.
- **When** The worker requests a token, then requests one more after the session becomes available.
- **Then** The first request receives a token-unavailable error, and the later request receives the valid cached token.

## shared-database-browser-004

Original test `Report a token-error for Clerk's SDK null and serve a later valid token`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/shared-database-browser.test.ts#L193).

- **Given** The shared database worker is connected, but Clerk's token SDK returns null.
- **When** The worker requests a token, then makes a later request that can retrieve a valid token.
- **Then** The first request receives a token-unavailable error, and the later request receives the valid cached token.

## shared-database-browser-005

Original test `Open the force-upgrade dialog when the worker requires an upgrade`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/shared-database-browser.test.ts#L233).

- **Given** The worker's indicators request receives an HTTP response requiring a client upgrade.
- **When** The member opens the app.
- **Then** A dialog named “Update required” is shown.

## shared-database-browser-006

Original test `Expose worker construction failures to bridge consumers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/shared-database-browser.test.ts#L250). · **intent review**

- **Given** The browser fails to construct the shared database worker.
- **When** Bridge setup is attempted and a consumer checks its connection.
- **Then** Both operations reject with the original worker-construction error.

## shared-database-browser-007

Original test `Reject pending requests when the worker fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/shared-database-browser.test.ts#L265). · **intent review**

- **Given** The shared database worker has connected, and a query and computed-value request are pending.
- **When** The browser reports that the worker failed to load.
- **Then** Both pending requests and a subsequent computed-value request reject with a worker-load failure; no replacement worker is constructed.
