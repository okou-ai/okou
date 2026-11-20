# Chat run history preview

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-run-history-preview.test.tsx](chat-run-history-preview.test.tsx).

## chat-run-history-preview-001

Original test `Show no history toggle when the only output is the main result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history-preview.test.tsx#L50).

- **Given** A run has exactly one assistant output, which is its main result.
- **When** The user views the result.
- **Then** The result has a Copy message control and no work-history expansion control.

## chat-run-history-preview-002

Original test `Hide all collapsed history and expand every message with 6 outputs`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history-preview.test.tsx#L61).

- **Given** A run has six assistant outputs, with the sixth as the main result and work history initially collapsed.
- **When** The user expands work history and then collapses it again.
- **Then** Initially, only Step 6 is shown. Expanded history shows Steps 1 through 5, the main result, and the thinking indicator; collapsing hides Steps 1 through 5 while leaving Step 6, its Copy message control, and the thinking indicator visible.

## chat-run-history-preview-003

Original test `Render Markdown and media history like the main body after a run completes`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-history-preview.test.tsx#L117).

- **Given** A completed run has historical outputs containing a Markdown heading with formatted text, an inline chart, a linked PDF, and a final result.
- **When** The user expands work history.
- **Then** The historical heading and formatted text, inline chart, and PDF preview link become visible, while the final result remains visible.
