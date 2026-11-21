# Chat composer model resolution

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-model-resolution.test.tsx](chat-composer-model-resolution.test.tsx).

## chat-composer-model-resolution-001

Original test `Edit only the model for an existing thread`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L82).

- **Given** An existing thread uses Claude Opus 5, and Claude Sonnet 5 is available.
- **When** The user selects Claude Sonnet 5 in the model picker.
- **Then** The picker shows Claude Sonnet 5, and the model-for-this-chat group is not shown.

## chat-composer-model-resolution-002

Original test `Resolve the model shown for a chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L103).

- **Given** A new chat has a saved preference for Claude Opus 5.5, and that model is available.
- **When** The chat composer loads.
- **Then** The model picker shows Claude Opus 5.5.

## chat-composer-model-resolution-003

Original test `Switch only the thread to Auto when its model is no longer selectable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L117).

- **Given** An existing thread stores DeepSeek V4.1 Flash, but only GPT 6 Sol is available.
- **When** The user opens the model picker and sends a message.
- **Then** The picker shows GPT 6 Sol and does not list DeepSeek. The thread is switched to Auto, while the send request carries no explicit model.

## chat-composer-model-resolution-004

Original test `Send without repairing an Auto thread storing null`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L157).

- **Given** An existing thread stores a null model, and Auto is available.
- **When** The user sends a message while Auto is selected.
- **Then** The message appears, and sending causes no model repair.

## chat-composer-model-resolution-005

Original test `Send without repairing an Auto thread storing auto`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L157).

- **Given** An existing thread stores the model value auto, and Auto is available.
- **When** The user sends a message while Auto is selected.
- **Then** The message appears, and sending causes no model repair.

## chat-composer-model-resolution-006

Original test `Send without repairing an Auto thread storing okou-1.0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L157).

- **Given** An existing thread stores Okou 1.0, and Auto is available.
- **When** The user sends a message while Auto is selected.
- **Then** The message appears, and sending causes no model repair.

## chat-composer-model-resolution-007

Original test `Keep the stored selection when sending on an available model`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L200).

- **Given** An existing thread uses available Claude Opus 5.
- **When** The user sends a message.
- **Then** The send request omits an explicit model, leaving the stored selection in effect.

## chat-composer-model-resolution-008

Original test `Keep an existing thread's explicit model`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L225).

- **Given** An existing thread explicitly uses Claude Opus 5, while the saved preference is Claude Opus 5.5 and both models are available.
- **When** The thread loads.
- **Then** The model picker shows Claude Opus 5, not the saved preference.

## chat-composer-model-resolution-009

Original test `Start a new chat on Auto without a saved preference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L239).

- **Given** No model preference is saved, and Claude Fable 5.1 and Claude Opus 5.5 are available.
- **When** A new chat loads.
- **Then** The model picker shows Auto.

## chat-composer-model-resolution-010

Original test `Start a new chat on Auto when the saved preference has no route`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-model-resolution.test.tsx#L251).

- **Given** The saved preference is Claude Opus 5.5, which has no available route; Claude Fable 5.1 is available.
- **When** A new chat loads.
- **Then** The model picker shows Auto.
