# Connectors category virtualization

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connectors-category-virtualization.test.tsx](connectors-category-virtualization.test.tsx).

## connectors-category-virtualization-001

Original test `Mount a screen of a category instead of all of it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connectors-category-virtualization.test.tsx#L47).

- **Given** The communication-collaboration category contains 300 connectors.
- **When** The user opens that category in the connectors page.
- **Then** The grid shows some connector labels, but fewer than 300. It also reserves rows for connectors whose cards are not mounted.
