# Connector redirect pages

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connector-redirect-pages.test.tsx](connector-redirect-pages.test.tsx).

## connector-redirect-pages-001

Original test `The Mercury redirect page shows its required disclosure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-redirect-pages.test.tsx#L12).

- **Given** An unauthenticated user opens the Mercury redirect page.
- **When** The page loads.
- **Then** It shows “Redirecting to Mercury…” and the required disclosure that Mercury is not an FDIC-insured bank, with banking services provided through Choice Financial Group and Column N.A., Members FDIC. “Powered by Mercury” links to https://mercury.com.

## connector-redirect-pages-002

Original test `An unsafe route icon is not loaded`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-redirect-pages.test.tsx#L34).

- **Given** An unauthenticated user opens a redirect page whose icon URL uses insecure HTTP.
- **When** The page loads.
- **Then** It shows “Redirecting to Server Only…” and does not load the supplied HTTP icon.
