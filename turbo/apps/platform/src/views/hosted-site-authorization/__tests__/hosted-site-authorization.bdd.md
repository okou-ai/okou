# Hosted site authorization

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [hosted-site-authorization.test.tsx](hosted-site-authorization.test.tsx).

## hosted-site-authorization-001

Original test `the trusted App returns only a one-use authorization code to the exact site`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-authorization.test.tsx#L15).

- **Given** A signed-in user starts site authorization for the trusted site, with a state value and PKCE challenge.
- **When** The authorization succeeds with a callback URL containing a one-use code.
- **Then** The browser navigates to that exact callback URL; no Clerk JWT is sent in the navigation.

## hosted-site-authorization-002

Original test `a denied website navigates to the dedicated access page`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-authorization.test.tsx#L34).

- **Given** A signed-in user starts authorization for a website that is denied access.
- **When** The authorization returns 403 Forbidden.
- **Then** The browser navigates to the dedicated access page with the website’s root URL and reason `denied`.

## hosted-site-authorization-003

Original test `authorization status 401 preserves the website destination for recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-authorization.test.tsx#L51).

- **Given** A user starts site authorization with `/report?view=summary` as the return destination.
- **When** Authorization returns 401 Unauthorized.
- **Then** The browser navigates to the access page for `https://demo.okou.app/report?view=summary` with reason `authenticate`.

## hosted-site-authorization-004

Original test `authorization status 500 preserves the website destination for recovery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-authorization.test.tsx#L51).

- **Given** A user starts site authorization with `/report?view=summary` as the return destination.
- **When** Authorization returns 500 Internal Server Error.
- **Then** The browser navigates to the access page for `https://demo.okou.app/report?view=summary` with reason `unavailable`.

## hosted-site-authorization-005

Original test `sign-in returns to the trusted App bridge with the complete browser state`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-authorization.test.tsx#L78).

- **Given** A user is signed out and opens the hosted-site authorization bridge with its complete site, state, and challenge parameters.
- **When** The user opens the bridge.
- **Then** The app shows sign-in and preserves the complete bridge URL as the redirect destination.

## hosted-site-authorization-006

Original test `organization selection preserves the bridge continuation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/hosted-site-authorization/__tests__/hosted-site-authorization.test.tsx#L91).

- **Given** A signed-in user has no active organization or memberships and opens the hosted-site authorization bridge.
- **When** The user is sent to organization selection.
- **Then** The app preserves the complete bridge URL as the continuation destination.
