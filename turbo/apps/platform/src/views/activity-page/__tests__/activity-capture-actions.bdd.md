# Activity capture actions

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [activity-capture-actions.test.tsx](activity-capture-actions.test.tsx).

## activity-capture-actions-001

Original test `Copy each capture section without opening its disclosure`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-capture-actions.test.tsx#L64).

- **Given** A user has uploaded a captured request with request and response headers and bodies, and each capture section is collapsed.
- **When** They use Copy to clipboard in each section without opening its disclosure.
- **Then** The clipboard receives the request header, response header, request body, and response body text respectively, while each section's content remains hidden.
