# Agent chat tagline

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [agent-chat-tagline.test.tsx](agent-chat-tagline.test.tsx).

## agent-chat-tagline-001

Original test `The greeting shows its complete sentence, one box per word`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-chat-tagline.test.tsx#L57).

- **Given** A user opens the chat for the Nova agent with motion preferences set to reduce animation.
- **When** The greeting appears.
- **Then** Its full sentence is present immediately as accessible text, divided into one displayed box per word in reading order.

## agent-chat-tagline-002

Original test `The avatar leads the sentence`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/agent-chat-tagline.test.tsx#L80).

- **Given** A user opens the chat for the Nova agent with motion preferences set to reduce animation.
- **When** The greeting row appears.
- **Then** The avatar is the first element in the row and precedes the greeting sentence.
