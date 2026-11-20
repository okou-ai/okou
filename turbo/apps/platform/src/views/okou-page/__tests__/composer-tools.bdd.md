# Composer tools

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [composer-tools.test.tsx](composer-tools.test.tsx).

## composer-tools-001

Original test `Composer tools and Settings share saved search preferences`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.test.tsx#L70).

- **Given** The user opens the composer’s Tools panel with Web search and Financial data enabled.
- **When** They disable both tools, open Settings, enable Web search there, close Settings, and reopen composer Tools.
- **Then** Settings reflects the disabled preferences, and reopened Tools shows Web search enabled and Financial data disabled.

## composer-tools-002

Original test `Closing and reopening Tools retains a pending save and its retryable failure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.test.tsx#L117).

- **Given** The user disables Web search, and the save is still pending when they close and reopen Tools. The save then fails.
- **When** They reopen Tools before the failure and retry by disabling Web search again.
- **Then** Web search remains unavailable while the save is pending; Financial data stays enabled. After the failure, an alert appears, Web search is enabled again, and the user can disable it.

## composer-tools-003

Original test `Reopening Tools recovers a failed preference initial read`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.test.tsx#L159).

- **Given** The initial read of saved tool preferences fails while Tools is open.
- **When** The user closes Tools, the preference service recovers, and they reopen Tools and disable Web search.
- **Then** Web search is initially enabled after reopening and can be disabled.

## composer-tools-004

Original test `Reopening Tools recovers a failed preference confirmation read`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.test.tsx#L159).

- **Given** Reading saved tool preferences for confirmation fails after the user disables Web search.
- **When** The user closes Tools, the preference service recovers, and they reopen Tools and enable Web search.
- **Then** Web search is initially disabled after reopening and can be enabled.

## composer-tools-005

Original test `A failed tool catalog leaves Web search usable and retries on reopening`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/composer-tools.test.tsx#L205).

- **Given** The tool catalog request fails while the user opens Tools.
- **When** They disable Web search, close Tools, and reopen it after the catalog recovers.
- **Then** An alert appears for the failed catalog, but Web search remains usable and disabled. On reopening, New research is available and enabled, while Web search remains disabled.
