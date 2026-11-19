# Chat message followups

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-message-followups.test.tsx](chat-message-followups.test.tsx).

## chat-message-followups-001

Original test `A late recommendation appears in the current chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-followups.test.tsx#L188).

- **Given** A completed chat response has no follow-up recommendation initially.
- **When** A follow-up recommendation arrives later in the current chat.
- **Then** The recommendation appears in the “Keep going” group, and no thinking indicator is shown.

## chat-message-followups-002

Original test `A late recommendation appears after navigating to another chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-followups.test.tsx#L208).

- **Given** The current chat has a follow-up recommendation, and another chat is available.
- **When** The user navigates to the other chat, where its recommendation arrives late.
- **Then** The other chat shows the recommendation in its “Keep going” group, and no thinking indicator is shown.

## chat-message-followups-003

Original test `A newer assistant reply retires older follow-ups`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-followups.test.tsx#L252).

- **Given** An earlier assistant reply has a follow-up recommendation, followed by a newer completed assistant reply.
- **When** The chat history is displayed.
- **Then** Both replies are visible, but the older recommendation and “Keep going” group are absent.

## chat-message-followups-004

Original test `A recommended follow-up edits the draft without sending it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-followups.test.tsx#L293).

- **Given** A completed assistant reply has five follow-up recommendations covering presentation, image, website, other generation, and discussion, and the user has typed “Keep the current launch context” in the composer.
- **When** The user selects the presentation recommendation, then selects it again.
- **Then** The draft becomes “Keep the current launch context” followed by the presentation prompt on a new line; the composer retains focus and the recommendation remains visible. Selecting it again selects the prompt text without changing the draft. Neither selection sends a message.

## chat-message-followups-005

Original test `A touch device renders the recommended follow-ups as a quick reply rail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-followups.test.tsx#L338).

- **Given** A completed assistant reply has five follow-up recommendations, and the device uses a coarse pointer.
- **When** The chat is displayed.
- **Then** The five recommendations appear in a quick-reply rail.

## chat-message-followups-006

Original test `Workflow and email recommendations keep their icons and edit the draft (touch: false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-followups.test.tsx#L357).

- **Given** A completed assistant reply has a workflow recommendation and an email recommendation, and the device does not use a coarse pointer.
- **When** The user selects the workflow recommendation and then the email recommendation.
- **Then** The workflow and email recommendations retain their respective workflow-route and mail icons. The composer draft contains both prompts on separate lines and retains focus; neither selection sends a message.

## chat-message-followups-007

Original test `Workflow and email recommendations keep their icons and edit the draft (touch: true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-followups.test.tsx#L357).

- **Given** A completed assistant reply has a workflow recommendation and an email recommendation, and the device uses a coarse pointer.
- **When** The user selects the workflow recommendation and then the email recommendation.
- **Then** The workflow and email recommendations retain their respective workflow-route and mail icons. The composer draft contains both prompts on separate lines and retains focus; neither selection sends a message.

## chat-message-followups-008

Original test `A fine-pointer device keeps the recommended follow-up rows at any width`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-followups.test.tsx#L407).

- **Given** A completed assistant reply has five follow-up recommendations, and the device uses a fine pointer; the viewport width is not constrained.
- **When** The chat is displayed.
- **Then** The recommendations appear as rows, regardless of viewport width.
