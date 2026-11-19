# Auth v1 ui load

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [auth-v1-ui-load.test.tsx](auth-v1-ui-load.test.tsx).

## auth-v1-ui-load-001

Original test `A Clerk UI load failure reports the error without a partial auth form`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-ui-load.test.tsx#L10).

- **Given** A signed-out user visits /sign-in and the Clerk UI resource fails to load.
- **When** The auth page finishes handling the load failure.
- **Then** An alert reports “Oops! Something went sideways”; no partial Clerk sign-in form appears, and the bootstrap skeleton is hidden.
