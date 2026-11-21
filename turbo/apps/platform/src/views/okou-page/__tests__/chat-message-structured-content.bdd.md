# Chat message structured content

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-message-structured-content.test.tsx](chat-message-structured-content.test.tsx).

Batch 32 accepted 001, 002, 003, 004 and 008 on its original base. After upstream workspace-member chat admission in #49637, 001, 002, 004 and 008 remain accepted. For 003 the current page still links to the source run and anchors the delegated prompt, but the source agent portrait was removed. The corresponding frozen Then remains open. See the [batch 40 evidence](../../../../test-rebuild-rework-checkpoint.md#batch-40-evidence).

## chat-message-structured-content-001

Original test `Agent mentions are recognizable links in messages and feedback`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-structured-content.test.tsx#L47).

- **Given** A chat message contains an Ada agent mention in its text and feedback note.
- **When** The user opens the chat.
- **Then** Both mentions appear as links labeled to open Ada’s chat, with Ada’s avatar; the agent ID is not shown.

## chat-message-structured-content-002

Original test `MCP messages show the saved client name or generic marker with a local icon`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-structured-content.test.tsx#L92).

- **Given** Chat messages contain MCP sources with a saved name, no name, and a long saved name.
- **When** The user opens the chat.
- **Then** The named source shows “Claude Code” with a local decorative icon and no link or client ID. The unnamed source shows “MCP” with an icon. The long source’s full name remains available despite badge truncation.

## chat-message-structured-content-003

Original test `Delegated work links back to its source run`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-structured-content.test.tsx#L169).

- **Given** A delegated message records its source chat, run, agent, and title snapshot.
- **When** The user opens the delegated chat.
- **Then** A “Source thread” link points to the source chat at the source run, shows the source agent’s avatar, and the delegated prompt is anchored to that run.

## chat-message-structured-content-004

Original test `Related feedback notes are grouped with clear source links`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-structured-content.test.tsx#L211).

- **Given** A message contains two feedback notes that refer to the same source chat, between surrounding text.
- **When** The user opens the chat.
- **Then** The two quotes appear together as a group labeled as quoting two reply parts, each with a link titled “Project Alpha” to the source chat. The group remains between the surrounding text.

## chat-message-structured-content-005

Original test `Forwarded feedback names its source chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-structured-content.test.tsx#L278).

- **Given** A feedback quote is followed by a source-agent reference titled “Source thread.”
- **When** The user opens the chat.
- **Then** The feedback group identifies the source as “Source thread” and does not describe it as quoted from the user’s reply.

## chat-message-structured-content-006

Original test `Mail quote headings omit mail identifiers`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-structured-content.test.tsx#L318).

- **Given** A feedback quote comes from a sent email with draft and sent identifiers.
- **When** The user opens the chat.
- **Then** The heading says it was quoted from a sent email and shows neither mail identifier.

## chat-message-structured-content-007

Original test `Structured message context survives navigation away and back`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-structured-content.test.tsx#L410).

- **Given** A chat message contains a source-chat link and a file attachment.
- **When** The user navigates to Agents and then returns to the chat using browser history.
- **Then** The chat composer is enabled, and the source link and file remain visible.

## chat-message-structured-content-008

Original test `Structured message context stays in its pane when a companion chat opens`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-structured-content.test.tsx#L429).

- **Given** A chat pane contains a source-chat link and a file attachment, and a companion chat is available.
- **When** The user opens the companion chat in a second pane.
- **Then** Both panes have enabled composers, while the original pane retains its source link and file.

## chat-message-structured-content-009

Original test `A structured user message keeps its saved order and snapshots`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-structured-content.test.tsx#L467).

- **Given** A structured message contains text, a template snapshot, an image, a source chat, two other files, and literal markup; legacy message text conflicts with it.
- **When** The user opens the chat.
- **Then** Structured parts appear in their saved order, using the saved template and chat titles and saved filenames. The image has a preview link and filename alt text; the deleted-file entry is still shown. Markup remains literal rather than becoming an executable script, and the conflicting legacy text is absent.

## chat-message-structured-content-010

Original test `Sent template references stay inline and read-only`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-structured-content.test.tsx#L555).

- **Given** A sent message and its feedback note each reference the “Editorial Collage” template.
- **When** The user opens the chat and clicks both references.
- **Then** Both references stay inline in their respective text, show the saved title, and are not interactive controls; clicking them opens no dialog.
