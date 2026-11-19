# Chat batch permissions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-batch-permissions.test.tsx](chat-batch-permissions.test.tsx).

## chat-batch-permissions-001

Original test `Review full scopes grouped by connector and apply the selected duration together`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-batch-permissions.test.tsx#L176).

- **Given** A chat permission batch contains three known scopes across Calendar Service and Reports Service plus one unknown Reports Service scope, and metadata and grants are available.
- **When** The user reviews the batch, selects 24 hours, and allows all four permissions.
- **Then** The review groups scopes by connector and shows descriptions plus the unknown scope's other-endpoints information. All four are applied together for 24 hours, grouped by connector, and the batch reports permissions allowed.

## chat-batch-permissions-002

Original test `Review every scope in a large batch as metadata and grants arrive separately`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-batch-permissions.test.tsx#L277).

- **Given** A batch contains 20 scopes split evenly between Calendar Service and Reports Service; permission metadata and current grants are initially delayed separately.
- **When** The user opens review, waits for metadata and then grants, selects Always, and allows all 20 permissions.
- **Then** The review initially shows loading and keeps the allow action disabled; after metadata arrives all 20 scopes and descriptions appear but approval remains disabled until grants arrive. Approval then succeeds with ten permanent grants per connector and the review explains that they remain allowed until changed or revoked.

## chat-batch-permissions-003

Original test `Approve only missing scopes without reapplying or extending active grants`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-batch-permissions.test.tsx#L402).

- **Given** A three-scope batch has two scopes already actively allowed.
- **When** The user allows the batch.
- **Then** Only the missing Reports Service scope is applied for one hour; active grants are neither reapplied nor extended, and the batch reports permissions allowed.

## chat-batch-permissions-004

Original test `Keep the whole batch unavailable when one connector's delayed authoritative metadata fails`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-batch-permissions.test.tsx#L443).

- **Given** A three-scope batch spans Calendar Service and Reports Service, and authoritative permission metadata requests are delayed.
- **When** Reports Service metadata fails with a forbidden response while Calendar Service metadata succeeds.
- **Then** The review shows an alert and a permission-details link, keeps approval disabled for the whole batch, and applies no permissions.

## chat-batch-permissions-005

Original test `Reject the entire batch with an invalid original row`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-batch-permissions.test.tsx#L499).

- **Given** A batch action URL contains one valid permission row and one row whose permission value is a number.
- **When** The chat loads the action.
- **Then** The batch is unavailable, no batch permission card appears, and no grants are applied.

## chat-batch-permissions-006

Original test `A batch save does not empty sibling permission cards during a grants reload`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-batch-permissions.test.tsx#L523).

- **Given** A chat contains a permission batch and a sibling single-permission action, both initially awaiting confirmation.
- **When** The user approves the batch while the grants reload is delayed, closes the batch review, then allows the reload to finish.
- **Then** The sibling permission card remains available and confirmable during the reload, still identifies its permission for allowing, and then reports that it is already allowed.
