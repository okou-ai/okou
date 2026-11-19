# Browser authorization page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-authorization-page.test.tsx](browser-authorization-page.test.tsx).

## browser-authorization-page-001

Original test `Cloud-browser authorization uses the current app's brand`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-authorization/__tests__/browser-authorization-page.test.tsx#L40).

- **Given** A user opens a valid cloud-browser authorization link in the Okou app with the browser capability unavailable in the current environment.
- **When** The authorization page loads.
- **Then** It shows “Enable cloud browser,” links the Okou brand to `/connectors`, and displays the app’s Okou wordmark.

## browser-authorization-page-002

Original test `An unavailable authorization link does not offer browser access (404)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-authorization/__tests__/browser-authorization-page.test.tsx#L66).

- **Given** A user opens a cloud-browser authorization link that returns HTTP 404.
- **When** The authorization page handles the unavailable link.
- **Then** It shows an alert stating that the authorization link is invalid, expired, or unavailable for the workspace, links the Okou brand to `/connectors`, and offers no buttons.

## browser-authorization-page-003

Original test `An unavailable authorization link does not offer browser access (410)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-authorization/__tests__/browser-authorization-page.test.tsx#L66).

- **Given** A user opens a cloud-browser authorization link that returns HTTP 410.
- **When** The authorization page handles the unavailable link.
- **Then** It shows an alert stating that the authorization link is invalid, expired, or unavailable for the workspace, links the Okou brand to `/connectors`, and offers no buttons.

## browser-authorization-page-004

Original test `A user can enable the cloud browser for one conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-authorization/__tests__/browser-authorization-page.test.tsx#L95).

- **Given** A user has a pending cloud-browser authorization request for a conversation.
- **When** The user chooses “Enable for this thread.”
- **Then** The request is applied once, and the button changes to “Cloud browser enabled” and becomes disabled.

## browser-authorization-page-005

Original test `The standalone Browser page honors the optional callback (false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-authorization/__tests__/browser-authorization-page.test.tsx#L129).

- **Given** A user opens the standalone Browser authorization page with no callback thread or prompt parameters.
- **When** The user enables cloud browser for the thread.
- **Then** Authorization is granted once, and no follow-up chat prompt is sent.

## browser-authorization-page-006

Original test `The standalone Browser page honors the optional callback (true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-authorization/__tests__/browser-authorization-page.test.tsx#L129).

- **Given** A user opens the standalone Browser authorization page with a callback thread ID and the prompt “Continue.”
- **When** The user enables cloud browser for the thread.
- **Then** Authorization is granted once, and a follow-up chat prompt containing “Continue” is sent.
