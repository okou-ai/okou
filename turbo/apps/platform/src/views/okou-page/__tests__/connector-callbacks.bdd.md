# Connector callbacks

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connector-callbacks.test.tsx](connector-callbacks.test.tsx).

## connector-callbacks-001

Original test `Complete a custom connector authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-callbacks.test.tsx#L28).

- **Given** I am unauthenticated and have returned from a custom connector authorization with an OAuth code, state, and integration context.
- **When** The callback completes successfully.
- **Then** A “Custom connector connected” heading appears, and the page moves to the success route with the query string cleared.

## connector-callbacks-002

Original test `Complete a GitHub connector authorization`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-callbacks.test.tsx#L57).

- **Given** I am unauthenticated and have returned from GitHub authorization with an OAuth code and state; saved-account lookup is unauthorized.
- **When** GitHub authorization completes successfully while its catalog information loads afterward.
- **Then** The callback runs before the catalog request. A “GitHub connected” heading, GitHub icon, and connected-as-octocat message appear; the page moves to the success route and removes the OAuth code and state from the query string.

## connector-callbacks-003

Original test `Refreshing a completed connector callback does not reconnect it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-callbacks.test.tsx#L136).

- **Given** I am unauthenticated and open the completed GitHub callback success page with username octocat in the query.
- **When** I refresh the page.
- **Then** The page shows “GitHub connected” and the connected-as-octocat message without reconnecting through the callback.

## connector-callbacks-004

Original test `Complete a native Link wallet authorization without a catalog entry`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-callbacks.test.tsx#L160).

- **Given** I am unauthenticated and return from Link wallet authorization with an OAuth code and state; Link has no catalog entry.
- **When** The authorization callback completes successfully.
- **Then** A “Link connected” heading and Link icon appear, and the page moves to the success route with the query string cleared without requiring a catalog entry.

## connector-callbacks-005

Original test `Show the Link wallet icon on a refreshed success page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-callbacks.test.tsx#L196).

- **Given** I am unauthenticated and open the refreshed Link callback success page; catalog lookup and callback requests do not complete.
- **When** The success page loads.
- **Then** The page shows “Link connected” and the Link wallet icon.

## connector-callbacks-006

Original test `Show the Link wallet icon on a refreshed error page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-callbacks.test.tsx#L196).

- **Given** I am unauthenticated and open the refreshed Link callback error page; catalog lookup and callback requests do not complete.
- **When** The error page loads.
- **Then** The page shows “Couldn’t connect Link” and the Link wallet icon.

## connector-callbacks-007

Original test `Show Mercury attribution on a completed connector callback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-callbacks.test.tsx#L222).

- **Given** I am unauthenticated and open Mercury’s completed callback success page with a username query value.
- **When** The success page loads.
- **Then** It shows “Mercury connected,” a “Powered by Mercury” link to https://mercury.com, and Mercury’s fintech and banking-services disclosure.

## connector-callbacks-008

Original test `Show a provider error safely without an authenticated session`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-callbacks.test.tsx#L253).

- **Given** I am unauthenticated and return from Notion authorization with an access_denied error and state.
- **When** The provider callback reports “Provider denied access.”
- **Then** The page safely shows “Couldn’t connect NOTION,” the provider error, and instructions to close the window and try again. It moves to the error route and removes the error and state from the query string.
