# Fetch

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [fetch.test.ts](fetch.test.ts).

## fetch-001

Original test `Service requests carry stable client context and a unique trace`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/fetch.test.ts#L48).

- **Given** A user is using the app at a configured app version, and the service accepts connector requests.
- **When** The user makes two service requests, supplying conflicting client-context headers on the first request and none on the second.
- **Then** Both requests carry the app’s client type and configured version. They share a UUID session ID, each has a distinct UUID request ID, and caller-supplied values do not override the app context.

## fetch-002

Original test `An empty service error still gives the user a useful status`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/fetch.test.ts#L98).

- **Given** The connector service responds with HTTP 403 and an empty error message.
- **When** The user requests connector data.
- **Then** The request rejects with an error containing “HTTP 403”, and the page displays “HTTP 403” as a useful status.

## fetch-003

Original test `The update dialog appears only when an update is required`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/signals/__tests__/fetch.test.ts#L116).

- **Given** The app is open and the update-required service response has not yet been received.
- **When** The user first views the page, then requests connector data and the service responds with the force-upgrade status.
- **Then** No dialog is shown before the request. After the response, an “Update required” dialog appears with the refresh message.
