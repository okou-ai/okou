# Chat model projection refresh

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-model-projection-refresh.test.tsx](chat-model-projection-refresh.test.tsx).

## chat-model-projection-refresh-001

Original test `Keep provider choices through a held and failed projection refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-model-projection-refresh.test.tsx#L159).

- **Given** A new chat has an available GPT 5.6 Sol model, and a provider choice is available in the model panel.
- **When** A run-model refresh is held and then fails with “Routing refresh unavailable.”
- **Then** The provider choice remains available both while the refresh is held and after its failure.

## chat-model-projection-refresh-002

Original test `Keep the draft through a held and failed projection refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-model-projection-refresh.test.tsx#L166).

- **Given** A new chat contains the unsent draft “Keep this unsent draft.”
- **When** A run-model refresh is held and then fails with “Routing refresh unavailable.”
- **Then** The draft remains in the composer while the refresh is held and after its failure.

## chat-model-projection-refresh-003

Original test `Keep effort through a held and failed projection refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-model-projection-refresh.test.tsx#L173).

- **Given** A new chat is using GPT 5.6 Sol with Low effort.
- **When** A run-model refresh is held and then fails with “Routing refresh unavailable.”
- **Then** The composer continues to show GPT 5.6 Sol with Low effort while the refresh is held and after its failure.

## chat-model-projection-refresh-004

Original test `Keep Fast through a failed projection refresh`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-model-projection-refresh.test.tsx#L184).

- **Given** A new chat is using GPT 5.6 Sol with Low effort and Fast mode enabled.
- **When** A run-model refresh is held and then fails with “Routing refresh unavailable.”
- **Then** The model panel still shows Fast mode enabled for GPT 5.6 Sol with Low effort.

## chat-model-projection-refresh-005

Original test `A local active-account change refreshes the member projection`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-model-projection-refresh.test.tsx#L197).

- **Given** GPT 5.6 Sol is initially available, and a second Codex account is inactive.
- **When** The user activates the second account in Models settings, closes settings, and opens the model panel again.
- **Then** GPT 5.6 Sol remains available, and its effort options reflect the active personal account: moving the effort slider to the next option from Low shows High.
