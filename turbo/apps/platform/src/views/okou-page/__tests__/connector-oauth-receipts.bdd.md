# Connector oauth receipts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [connector-oauth-receipts.test.tsx](connector-oauth-receipts.test.tsx).

## connector-oauth-receipts-001

Original test `Preserve the pending OAuth receipt outcome when the final receipt is missing`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-oauth-receipts.test.tsx#L26).

- **Given** A Stripe OAuth attempt has started, but its completion receipt remains pending; the final receipt lookup returns 404 Not Found.
- **When** The user closes the authorization popup while the receipt is pending.
- **Then** The Connect Stripe action becomes enabled, and no “OAuth completion is unavailable” message appears.

## connector-oauth-receipts-002

Original test `Preserve the pending OAuth receipt outcome when the final receipt is forbidden`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/connector-oauth-receipts.test.tsx#L26).

- **Given** A Stripe OAuth attempt has started, but its completion receipt remains pending; the final receipt lookup returns 403 Forbidden with “OAuth completion is unavailable.”
- **When** The user closes the authorization popup while the receipt is pending.
- **Then** The Connect Stripe action becomes enabled, and one “OAuth completion is unavailable” message appears.
