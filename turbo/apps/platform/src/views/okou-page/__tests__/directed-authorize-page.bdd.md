# Directed authorize page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [directed-authorize-page.test.tsx](directed-authorize-page.test.tsx).

## directed-authorize-page-001

Original test `Authorize an agent to use an already connected connector`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-authorize-page.test.tsx#L184).

- **Given** Gmail is connected but not yet authorized for the agent, and the authorization page includes a callback prompt and chat thread.
- **When** The user chooses to authorize Okou.
- **Then** Gmail becomes authorized, and the callback prompt is sent as the continuation prompt and text user message.

## directed-authorize-page-002

Original test `Show an unavailable state for a deleted agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-authorize-page.test.tsx#L242).

- **Given** Gmail is connected, but the agent lookup returns not found.
- **When** The user opens the Gmail authorization page for that agent.
- **Then** The page shows “Agent not found” and does not offer the “Authorize Okou” action.

## directed-authorize-page-003

Original test `Connect a manual-token connector while authorizing an agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-authorize-page.test.tsx#L267).

- **Given** Public Axiom requires a manual API token, and is not yet connected or authorized for the agent.
- **When** The user chooses to authorize Okou, enters “xaat-directed-authorize” as the API token, and saves.
- **Then** That token is submitted to connect Axiom, and the page confirms Public Axiom is authorized.

## directed-authorize-page-004

Original test `Connect and authorize an agent through OpenID`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-authorize-page.test.tsx#L364).

- **Given** Steam is not connected or authorized for the agent, and supports OpenID authentication.
- **When** The user chooses to authorize Okou.
- **Then** The OpenID authorization page opens without an in-app Steam dialog, and the page confirms Steam is authorized.

## directed-authorize-page-005

Original test `Connect and authorize an agent to use a no-auth connector`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-authorize-page.test.tsx#L444).

- **Given** Public Stripe requires no authentication and is not yet connected or authorized for the agent.
- **When** The user chooses to authorize Okou.
- **Then** Stripe connects with one request and no account dialog, and the page confirms Public Stripe is authorized.

## directed-authorize-page-006

Original test `Leave an agent unauthorized when OAuth progress is closed`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/directed-authorize-page.test.tsx#L524).

- **Given** GitHub is not yet authorized for the agent and its OAuth authorization flow is open.
- **When** The user closes the provider window before completing OAuth.
- **Then** The agent remains unauthorized: no authorization update occurs and the page does not show GitHub authorized.
