# Debug connector catalog

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [debug-connector-catalog.test.tsx](debug-connector-catalog.test.tsx).

## debug-connector-catalog-001

Original test `shows the accepted catalog identity with version 3.21.0 in Debug settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-connector-catalog.test.tsx#L12).

- **Given** Debug settings are enabled, and the connector catalog release reports schema version 4, digest sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb, and catalog version 3.21.0.
- **When** I open Debug settings.
- **Then** The Connector catalog region shows the digest, version 3.21.0, and schema version 4.

## debug-connector-catalog-002

Original test `shows the accepted catalog identity with version null in Debug settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/debug-connector-catalog.test.tsx#L12).

- **Given** Debug settings are enabled, and the connector catalog release reports schema version 4, the same catalog digest, and no catalog version.
- **When** I open Debug settings.
- **Then** The Connector catalog region shows the digest, schema version 4, and Unavailable for the catalog version.
