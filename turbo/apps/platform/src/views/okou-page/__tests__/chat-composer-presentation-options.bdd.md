# Chat composer presentation options

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-composer-presentation-options.test.tsx](chat-composer-presentation-options.test.tsx).

## chat-composer-presentation-options-001

Original test `Create opens presentation templates and keeps the draft`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-options.test.tsx#L108).

- **Given** A user has typed “Our launch” in a new chat draft.
- **When** They choose Presentation from the Create capabilities.
- **Then** Presentation templates open, and the draft still reads “Our launch”.

## chat-composer-presentation-options-002

Original test `Presentation sends Auto as additional info without changing the message`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-options.test.tsx#L119).

- **Given** A user has typed “Our launch” and selected Auto for the presentation slide count.
- **When** They send the presentation request.
- **Then** The submitted message text remains “Our launch”; additional information includes presentation instructions and Auto, with the number of slides chosen based on the content.

## chat-composer-presentation-options-003

Original test `Presentation instructions stay out of the sent message bubble`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-options.test.tsx#L152).

- **Given** A user has typed “Our launch” and entered Presentation mode.
- **When** They send the request and view their message bubble.
- **Then** The bubble contains “Our launch” but does not contain “Slide count” or “Create a presentation.”

## chat-composer-presentation-options-004

Original test `Presentation sends the chosen slide count in additional info`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-options.test.tsx#L167).

- **Given** A user has typed “Our launch” and selected 20–24 slides for the presentation.
- **When** They send the request.
- **Then** The submitted message remains “Our launch”; additional information specifies the slide count as 20-24 and says an explicitly different count requested in the message takes precedence.

## chat-composer-presentation-options-005

Original test `Leaving presentation hides its picker and drops its settings`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-composer-presentation-options.test.tsx#L201).

- **Given** A user has typed “Our launch,” entered Presentation mode, and selected Auto for the slide count.
- **When** They remove Presentation and send the message.
- **Then** The presentation picker is hidden, no additional information is submitted, and the message remains “Our launch”.
