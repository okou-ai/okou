# Chat codex execution

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-codex-execution.test.tsx](chat-codex-execution.test.tsx).

## chat-codex-execution-001

Original test `shows catalog-supported Max for a saved Ultra preference when Codex execution is false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-codex-execution.test.tsx#L38).

- **Given** A saved chat uses GPT 6.1 Sol with an Ultra reasoning preference, and Codex execution is disabled.
- **When** The user opens the model panel.
- **Then** The panel shows the catalog-supported Max effort, with the effort slider set to Max.

## chat-codex-execution-002

Original test `shows catalog-supported Ultra for a saved Ultra preference when Codex execution is true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-codex-execution.test.tsx#L38).

- **Given** A saved chat uses GPT 6.1 Sol with an Ultra reasoning preference, and Codex execution is enabled.
- **When** The user opens the model panel.
- **Then** The panel shows the catalog-supported Ultra effort, with the effort slider set to Ultra.

## chat-codex-execution-003

Original test `enabling Codex in Lab preserves a saved Ultra preference that Pi cannot use`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-codex-execution.test.tsx#L55).

- **Given** A saved chat uses GPT 6.1 Sol with an Ultra reasoning preference that Pi cannot use; Codex execution is off and Lab is on.
- **When** The user enables Codex execution in Lab and returns to the conversation.
- **Then** The model control changes from Max to Ultra, preserving the saved preference.

## chat-codex-execution-004

Original test `does not expand the catalog's efforts when Codex execution is enabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-codex-execution.test.tsx#L99).

- **Given** A saved chat uses GPT 6.1 Sol with an Ultra preference, Codex execution is enabled, and the model catalog does not list Ultra for this model.
- **When** The user opens the model panel.
- **Then** The panel uses Max and does not show Ultra as an available effort.

## chat-codex-execution-005

Original test `sends a new Codex chat with the catalog-supported Ultra effort selected in the model panel`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-codex-execution.test.tsx#L131).

- **Given** The user is composing a new chat with Codex execution enabled and GPT 6.1 Sol selected.
- **When** The user selects Ultra in the model panel, enters a message, and sends it.
- **Then** The new chat is created with GPT 6.1 Sol and the Ultra reasoning effort.
