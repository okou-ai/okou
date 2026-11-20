# Chat capability run history

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-capability-run-history.test.tsx](chat-capability-run-history.test.tsx).

## chat-capability-run-history-001

Original test `Fold each workflow run's work behind its own result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-run-history.test.tsx#L160).

- **Given** A chat shows two completed workflow runs, each with work evidence and a result, plus a third active run.
- **When** The user opens the chat.
- **Then** Both completed-run results are visible, but their work evidence is hidden behind separate collapsed controls. After the user expands the first control, only the first run’s evidence appears; the second run’s evidence remains hidden, and the active run shows “Thinking...”.

## chat-capability-run-history-002

Original test `Show the current workflow run's output as its own response`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-capability-run-history.test.tsx#L186).

- **Given** A chat shows two completed workflow runs and a third active run whose workflow input has arrived but has no output yet.
- **When** The active run publishes its result.
- **Then** The current result appears as a separate assistant response from the earlier workflow result.
