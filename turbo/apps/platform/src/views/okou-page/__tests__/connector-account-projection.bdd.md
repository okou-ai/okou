# Connector account projection

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connector-account-projection.test.tsx](connector-account-projection.test.tsx).

## connector-account-projection-001

Original test `Check the current Job default after a local account set-default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-account-projection.test.tsx#L18).

- **Given** Acme Search has a configured Work account that is the default and an Expired account that requires reconnection because its credential expired. Research Agent has no usable default account access.
- **When** I make Expired the default account in the account manager, then open Research Agent and try to grant Acme Search access.
- **Then** Expired is shown as the default. The grant remains off, a message says the default account must be fully configured, and no dialog remains open.

## connector-account-projection-002

Original test `Check the current Job default after a local account delete-default`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-account-projection.test.tsx#L18).

- **Given** Acme Search has a configured Work account that is the default and an Expired account that requires reconnection because its credential expired. Research Agent has no usable default account access.
- **When** I disconnect Work, then open Research Agent and try to grant Acme Search access.
- **Then** Expired is promoted and shown as the default. The grant remains off, a message says the default account must be fully configured, and no dialog remains open.
