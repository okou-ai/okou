# Browser authorization card

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-authorization-card.test.tsx](browser-authorization-card.test.tsx).

## browser-authorization-card-001

Original test `A user allows a browser request and continues from https://app.okou.ai/browser/authorize/vm0_browser_authorization_request_test?callbackPrompt=The%20cloud%20browser%20is%20enabled.%20Please%20continue%20the%20previous%20task.&threadId=b0000000-0000-4000-a000-000000000902`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/browser-authorization-card.test.tsx#L88).

- **Given** A chat contains a browser-authorization link with an absolute app URL and a callback prompt to continue the previous task; the request is valid and pending.
- **When** The user selects “Allow.”
- **Then** The request becomes allowed and disabled, and the app sends and displays the callback prompt only after authorization succeeds. The original chat message remains visible.

## browser-authorization-card-002

Original test `A user allows a browser request and continues from /browser/authorize/vm0_browser_authorization_request_test?callbackPrompt=The%20cloud%20browser%20is%20enabled.%20Please%20continue%20the%20previous%20task.&threadId=b0000000-0000-4000-a000-000000000902`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/browser-authorization-card.test.tsx#L88).

- **Given** A chat contains a browser-authorization link with a relative URL and a callback prompt to continue the previous task; the request is valid and pending.
- **When** The user selects “Allow.”
- **Then** The request becomes allowed and disabled, and the app sends and displays the callback prompt only after authorization succeeds. The original chat message remains visible.

## browser-authorization-card-003

Original test `A user allows a browser request and continues from [Enable browser](https://app.okou.ai/browser/authorize/vm0_browser_authorization_request_test?callbackPrompt=The%20cloud%20browser%20is%20enabled.%20Please%20continue%20the%20previous%20task.&threadId=b0000000-0000-4000-a000-000000000902)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/browser-authorization-card.test.tsx#L88).

- **Given** A chat contains a Markdown browser-authorization link with an absolute app URL and a callback prompt to continue the previous task; the request is valid and pending.
- **When** The user selects “Allow.”
- **Then** The request becomes allowed and disabled, and the app sends and displays the callback prompt only after authorization succeeds. The original chat message remains visible.

## browser-authorization-card-004

Original test `Failed authorization leaves the task paused`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/browser-authorization-card.test.tsx#L123).

- **Given** A chat contains a valid, pending browser-authorization request, but applying authorization fails with a forbidden response.
- **When** The user selects “Allow.”
- **Then** The card says “Couldn't continue.” The callback prompt is not sent, and “Allow” remains enabled.

## browser-authorization-card-005

Original test `A request from another chat cannot enable a browser or continue this task`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/browser-authorization-card.test.tsx#L149).

- **Given** A chat contains a browser-authorization link whose request belongs to a different chat.
- **When** The user views the authorization card.
- **Then** The card says the link is invalid, expired, or unavailable for this workspace, and no “Allow” action is available.

## browser-authorization-card-006

Original test `Completed requests stay allowed when the chat is reopened`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/browser-authorization-card.test.tsx#L163).

- **Given** A chat is reopened with a browser-authorization request that has already been completed.
- **When** The user views the authorization card.
- **Then** The card shows a disabled “Allowed” action, and no callback prompt is sent.

## browser-authorization-card-007

Original test `Expired requests are unavailable in the transcript`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/browser-authorization-card.test.tsx#L176).

- **Given** A chat contains a browser-authorization link whose request has expired.
- **When** The user views the authorization card in the transcript.
- **Then** The card says the link is invalid, expired, or unavailable for this workspace, and no “Allow” action is available.

## browser-authorization-card-008

Original test `A plain Browser authorization grants access without resuming the chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/browser-authorization-card.test.tsx#L194).

- **Given** A chat contains a plain browser-authorization link without a callback prompt, and the request is valid and pending.
- **When** The user selects “Allow.”
- **Then** The request becomes allowed and disabled, and no message is sent to resume the chat.
