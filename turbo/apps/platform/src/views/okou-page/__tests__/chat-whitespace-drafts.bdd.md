# Chat whitespace drafts

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-whitespace-drafts.test.tsx](chat-whitespace-drafts.test.tsx).

## chat-whitespace-drafts-001

Original test `A blank agent draft stays empty after whitespace-only input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.test.tsx#L57).

- **Given** An agent composer has an empty draft.
- **When** The user enters only spaces and a tab.
- **Then** The saved agent draft remains empty, with no message content or attachments.

## chat-whitespace-drafts-002

Original test `A blank thread draft stays empty after whitespace-only input`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.test.tsx#L57).

- **Given** A chat thread composer has an empty draft.
- **When** The user enters only spaces and a tab.
- **Then** The saved thread draft remains empty, with no message content or attachments.

## chat-whitespace-drafts-003

Original test `Whitespace-only agent drafts clear saved content without trimming meaningful text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.test.tsx#L69).

- **Given** An agent composer has an empty draft.
- **When** The user enters text with leading spaces, blank lines, and indentation, then replaces it with whitespace-only input and adds line breaks.
- **Then** The meaningful text is initially saved exactly as entered, without trimming. The saved agent draft is then cleared, and the composer no longer contains that text.

## chat-whitespace-drafts-004

Original test `Whitespace-only thread drafts clear saved content without trimming meaningful text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.test.tsx#L69).

- **Given** A chat thread composer has an empty draft.
- **When** The user enters text with leading spaces, blank lines, and indentation, then replaces it with whitespace-only input and adds line breaks.
- **Then** The meaningful text is initially saved exactly as entered, without trimming. The saved thread draft is then cleared, and the composer no longer contains that text.

## chat-whitespace-drafts-005

Original test `Whitespace text preserves a draft's attachment and inline reference`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-whitespace-drafts.test.tsx#L92).

- **Given** A chat thread draft contains whitespace text, a reference to another conversation, and an attached file.
- **When** The user pastes a space into the composer.
- **Then** The saved draft retains the attachment and the inline conversation reference.
