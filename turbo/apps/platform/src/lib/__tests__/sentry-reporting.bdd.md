# Sentry reporting

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [sentry-reporting.test.ts](sentry-reporting.test.ts).

## sentry-reporting-001

Original test `unrelated deferred failures retain their default error report`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/sentry-reporting.test.ts#L19).

- **Given** Sentry is initialized and a background promise rejects with an unrelated error.
- **When** The rejected promise is settled.
- **Then** Sentry reports the original error as a page exception tagged with the Promise logger.

## sentry-reporting-002

Original test `reports only safe CDP request diagnostics from the original exception`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/sentry-reporting.test.ts#L36).

- **Given** A CDP request fails with a private endpoint token, page content, session ID, and provider error details.
- **When** The original exception is passed to Sentry's reporting hook.
- **Then** The event retains the browser operation context and reports only the CDP protocol kind, method, and code (-32000); serialized event data contains none of the private values.

## sentry-reporting-003

Original test `redacts OAuth callback credentials before Sentry reporting (/connectors/slack/callback)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/sentry-reporting.test.ts#L96).

- **Given** An OAuth callback URL at /connectors/slack/callback contains code, state, and integration query parameters.
- **When** The callback URL is sent through Sentry event, navigation breadcrumb, and sign-in redirect reporting.
- **Then** The reported values omit the private code and state, while the breadcrumb retains status 200 and the sign-in event retains its User-Agent.

## sentry-reporting-004

Original test `redacts OAuth callback credentials before Sentry reporting (/connectors/microsoft-365/callback)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/sentry-reporting.test.ts#L96).

- **Given** An OAuth callback URL at /connectors/microsoft-365/callback contains code, state, and integration query parameters.
- **When** The callback URL is sent through Sentry event, navigation breadcrumb, and sign-in redirect reporting.
- **Then** The reported values omit the private code and state, while the breadcrumb retains status 200 and the sign-in event retains its User-Agent.

## sentry-reporting-005

Original test `redacts OAuth callback credentials before Sentry reporting (/connectors/github/callback)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/sentry-reporting.test.ts#L96).

- **Given** An OAuth callback URL at /connectors/github/callback contains code, state, and integration query parameters.
- **When** The callback URL is sent through Sentry event, navigation breadcrumb, and sign-in redirect reporting.
- **Then** The reported values omit the private code and state, while the breadcrumb retains status 200 and the sign-in event retains its User-Agent.

## sentry-reporting-006

Original test `redacts OAuth callback credentials before Sentry reporting (/api/integrations/slack/oauth/callback)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/sentry-reporting.test.ts#L96).

- **Given** An OAuth callback URL at /api/integrations/slack/oauth/callback contains code, state, and integration query parameters.
- **When** The callback URL is sent through Sentry event, navigation breadcrumb, and sign-in redirect reporting.
- **Then** The reported values omit the private code and state, while the breadcrumb retains status 200 and the sign-in event retains its User-Agent.

## sentry-reporting-007

Original test `redacts OAuth callback credentials before Sentry reporting (/api/integrations/teams/oauth/callback)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/sentry-reporting.test.ts#L96).

- **Given** An OAuth callback URL at /api/integrations/teams/oauth/callback contains code, state, and integration query parameters.
- **When** The callback URL is sent through Sentry event, navigation breadcrumb, and sign-in redirect reporting.
- **Then** The reported values omit the private code and state, while the breadcrumb retains status 200 and the sign-in event retains its User-Agent.

## sentry-reporting-008

Original test `redacts OAuth callback credentials before Sentry reporting (/api/github/app/setup/callback)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/sentry-reporting.test.ts#L96).

- **Given** An OAuth callback URL at /api/github/app/setup/callback contains code, state, and integration query parameters.
- **When** The callback URL is sent through Sentry event, navigation breadcrumb, and sign-in redirect reporting.
- **Then** The reported values omit the private code and state, while the breadcrumb retains status 200 and the sign-in event retains its User-Agent.

## sentry-reporting-009

Original test `captures logged errors as exceptions after a shared database transfer`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/sentry-reporting.test.ts#L143).

- **Given** The app is reporting through Sentry, and an error is logged after crossing a shared database transfer, or before transfer.
- **When** Each of these errors is logged: a worker-load error wrapping a worker-script failure, a shared-database HTTP 500 error, an API 500 internal-server error, and a NotReadableError DOM exception.
- **Then** Sentry reports every original and reconstructed error as an exception carrying that same error object.
