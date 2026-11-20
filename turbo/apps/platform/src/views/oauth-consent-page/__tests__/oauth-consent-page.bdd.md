# Oauth consent page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [oauth-consent-page.test.tsx](oauth-consent-page.test.tsx).

## oauth-consent-page-001

Original test `app.vm7.ai renders the app-hosted OAuth consent request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/oauth-consent-page/__tests__/oauth-consent-page.test.tsx#L33).

- **Given** A user opens an OAuth consent request on `app.vm7.ai`.
- **When** The consent request loads.
- **Then** The app-hosted consent screen shows the requested client ID, simple theme, home link, configured colors, auth layout, background, theme control, and original OAuth URL and challenge.

## oauth-consent-page-002

Original test `app.okou.ai renders the app-hosted OAuth consent request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/oauth-consent-page/__tests__/oauth-consent-page.test.tsx#L33).

- **Given** A user opens an OAuth consent request on `app.okou.ai`.
- **When** The consent request loads.
- **Then** The app-hosted consent screen shows the requested client ID, simple theme, home link, configured colors, auth layout, background, theme control, and original OAuth URL and challenge.

## oauth-consent-page-003

Original test `A signed-out consent request returns through app sign-in`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/oauth-consent-page/__tests__/oauth-consent-page.test.tsx#L71).

- **Given** A user is signed out and opens an OAuth consent request on `app.vm7.ai`.
- **When** The consent request requires sign-in.
- **Then** The app redirects once to sign-in on `app.vm7.ai`, preserving the complete consent URL, and does not show the consent screen.
