# Auth oauth consent

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [auth-oauth-consent.test.ts](auth-oauth-consent.test.ts).

## auth-oauth-consent-001

Original test `Accept the exact local development app origin for OAuth consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/auth-oauth-consent.test.ts#L10).

- **Given** The browser is on the local development app origin, https://app.vm7.ai:8443.
- **When** OAuth consent receives a continuation URL on that exact origin.
- **Then** It accepts and returns the continuation URL.

## auth-oauth-consent-002

Original test `Accept the exact production app origin for OAuth consent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/auth-oauth-consent.test.ts#L10).

- **Given** The browser is on the production app origin, https://app.okou.ai.
- **When** OAuth consent receives a continuation URL on that exact origin.
- **Then** It accepts and returns the continuation URL.

## auth-oauth-consent-003

Original test `Reject a consent continuation on the Marketing origin`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/auth-oauth-consent.test.ts#L22).

- **Given** The browser is on the local development app origin, and the consent continuation uses the Marketing origin, https://www.vm7.ai:8443.
- **When** OAuth consent checks the continuation URL.
- **Then** It rejects the continuation and returns null.
