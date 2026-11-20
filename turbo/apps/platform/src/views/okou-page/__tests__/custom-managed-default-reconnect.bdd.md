# Custom managed default reconnect

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [custom-managed-default-reconnect.test.tsx](custom-managed-default-reconnect.test.tsx).

## custom-managed-default-reconnect-001

Original test `Preserve the feishu managed default connection lifecycle`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-managed-default-reconnect.test.tsx#L22).

- **Given** A connected Feishu managed default OAuth connection is shown, while ordinary account-list requests fail with 403 and direct account lookup returns 404.
- **When** I choose Reconnect and continue through the connection dialog.
- **Then** The reconnect intent uses the existing connection ID, the authentication window closes, and Managed workspace remains connected. The ordinary-account errors are not shown.
- **Upstream change** `8343cc9e` (#49530): completing a managed reconnect now also checks that the managed connector status names the reconnected account; the lifecycle in this scenario is unchanged when it does.

## custom-managed-default-reconnect-002

Original test `Preserve the lark managed default connection lifecycle`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/custom-managed-default-reconnect.test.tsx#L22).

- **Given** A connected Lark managed default OAuth connection is shown, while ordinary account-list requests fail with 403 and direct account lookup returns 404.
- **When** I choose Reconnect and continue through the connection dialog.
- **Then** The reconnect intent uses the existing connection ID, the authentication window closes, and Managed workspace remains connected. The ordinary-account errors are not shown.
- **Upstream change** `8343cc9e` (#49530): completing a managed reconnect now also checks that the managed connector status names the reconnected account; the lifecycle in this scenario is unchanged when it does.
