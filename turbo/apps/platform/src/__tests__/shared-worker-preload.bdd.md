# Shared worker preload

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-worker-preload.test.tsx](shared-worker-preload.test.tsx).

## shared-worker-preload-001

Original test `Reuse the Worker the app shell preloaded for the signed-in identity`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/shared-worker-preload.test.tsx#L71).

- **Given** The app shell has preloaded a worker for the signed-in identity test-user-123 and organization org_default.
- **When** The page is set up.
- **Then** It reuses exactly one worker named okou_test-user-123_org_default, and the preloaded worker is no longer pending.

## shared-worker-preload-002

Original test `Report a preloaded Worker failure that happened before the app started`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/shared-worker-preload.test.tsx#L83).

- **Given** The app shell has preloaded a worker that emits an error before the app starts.
- **When** The page starts.
- **Then** The error is prevented, a “Connection interrupted” dialog appears, and the page uses the one preloaded worker.

## shared-worker-preload-003

Original test `Start the page's own Worker when the preloaded URL differs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/shared-worker-preload.test.tsx#L98).

- **Given** The app shell has preloaded a worker for test-user-123 and org_other, while the page needs org_default.
- **When** The page is set up.
- **Then** The preload is followed by a page-owned worker; their names are okou_test-user-123_org_other and okou_test-user-123_org_default, respectively. No interruption dialog appears.

## shared-worker-preload-004

Original test `Reuse the preloaded Worker when the preview URL carries its bypass`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/shared-worker-preload.test.tsx#L111).

- **Given** A preview page at pr-431-app.omby.ai has a protection-bypass query parameter, and the app shell preloads a worker with that same bypass.
- **When** The preview page is set up.
- **Then** It reuses exactly one preloaded worker whose URL retains the bypass value preview-secret, and the preload is no longer pending.
