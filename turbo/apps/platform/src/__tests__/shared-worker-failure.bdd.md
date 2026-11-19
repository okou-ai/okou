# Shared worker failure

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [shared-worker-failure.test.tsx](shared-worker-failure.test.tsx).

## shared-worker-failure-001

Original test `Block the page and report a worker failure during startup`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/shared-worker-failure.test.tsx#L103).

- **Given** The app's SharedWorker fails during startup.
- **When** The page starts.
- **Then** A “Connection interrupted” dialog says “The connection to this app was interrupted.” Failure telemetry is reported once and flushed once; pressing Escape does not dismiss the dialog.

## shared-worker-failure-002

Original test `Block the page after a connected worker fails and report it once`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/shared-worker-failure.test.tsx#L120).

- **Given** The page has connected to its SharedWorker and has no interruption dialog.
- **When** The worker emits two error events.
- **Then** Both events are prevented, a “Connection interrupted” dialog appears, and failure telemetry is reported once and flushed once.

## shared-worker-failure-003

Original test `Ignore worker errors after the page owner has been cancelled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/__tests__/shared-worker-failure.test.tsx#L141).

- **Given** The page owner has been cancelled by switching to another Clerk session.
- **When** The prior worker emits an error.
- **Then** The error is not prevented, no dialog appears, and no worker-failure telemetry is reported.
