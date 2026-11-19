# Auth v1 navigation hosts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [auth-v1-navigation-hosts.test.tsx](auth-v1-navigation-hosts.test.tsx).

## auth-v1-navigation-hosts-001

Original test `A nested sign-in route retains its state on the canonical Okou app`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-navigation-hosts.test.tsx#L8).

- **Given** A signed-out user opens the nested sign-in route on the canonical Okou app, with a return URL to the agents page.
- **When** The app loads the route with session, redirect, and hash parameters.
- **Then** The sign-in state is visible, and the canonical origin, full pathname, query, hash, and return URL are retained.

## auth-v1-navigation-hosts-002

Original test `A nested sign-up route retains its state on the canonical Okou app`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/auth-v1/__tests__/auth-v1-navigation-hosts.test.tsx#L8).

- **Given** A signed-out user opens the nested sign-up route on the canonical Okou app, with a return URL to the agents page.
- **When** The app loads the route with session, redirect, and hash parameters.
- **Then** The sign-up state is visible, and the canonical origin, full pathname, query, hash, and return URL are retained.
