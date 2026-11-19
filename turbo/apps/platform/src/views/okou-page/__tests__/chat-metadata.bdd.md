# Chat metadata

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-metadata.test.tsx](chat-metadata.test.tsx).

## chat-metadata-001

Original test `Late thread details do not replace the conversation the user chose`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-metadata.test.tsx#L193).

- **Given** The user opens a chat whose metadata request is pending, while another conversation becomes available in the thread list.
- **When** The user selects the available conversation and the old metadata request then completes.
- **Then** The selected conversation remains open with its chosen title and enabled composer; the stale route title does not replace it.

## chat-metadata-002

Original test `A newly available thread appears after a thread-list event`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-metadata.test.tsx#L254).

- **Given** A chat is open and a newly created conversation is initially absent from the thread list.
- **When** A thread-list change announces the new conversation.
- **Then** The recovered conversation appears as a link; selecting it opens the chat with its synchronized title and updates the page title, while the original chat remains unchanged.

## chat-metadata-003

Original test `Returning to an interrupted chat does not reuse abandoned details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-metadata.test.tsx#L304).

- **Given** The user enters a chat while its metadata request is pending, leaves for Agents, and the abandoned request then completes.
- **When** The user returns to the chat, whose new metadata lookup reports not found.
- **Then** The abandoned title is never shown; Agents remains correctly titled after leaving, and on returning no chat region or abandoned title appears.

## chat-metadata-004

Original test `Hidden conversations open from canonical snapshot without appearing in chat history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-metadata.test.tsx#L390).

- **Given** A hidden conversation is present in the canonical snapshot, alongside a visible conversation; its metadata is pending.
- **When** The user opens the hidden conversation by URL and synchronization completes.
- **Then** The hidden conversation opens with an enabled composer, while the visible conversation remains linked in the sidebar and the hidden one does not appear in chat history.

## chat-metadata-005

Original test `Hidden conversations open from canonical events without appearing in chat history`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-metadata.test.tsx#L390).

- **Given** A hidden conversation is introduced by a canonical thread event after the snapshot, alongside a visible conversation; its metadata is pending.
- **When** The user opens the hidden conversation by URL and synchronization completes.
- **Then** The hidden conversation opens with an enabled composer, while the visible conversation remains linked in the sidebar and the hidden one does not appear in chat history.

## chat-metadata-006

Original test `Metadata opens a hidden conversation while canonical synchronization continues`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-metadata.test.tsx#L469).

- **Given** The user opens a hidden conversation while its canonical snapshot is still pending; metadata returns the title “Quick conversation.”
- **When** Metadata resolves before canonical synchronization, then the canonical snapshot supplies “Canonical conversation.”
- **Then** The chat first opens using the metadata title, then adopts the canonical title and page title. The snapshot request remains active, and the hidden conversation does not appear as a history link.

## chat-metadata-007

Original test `Canonical synchronization wins and cancels the losing metadata request`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-metadata.test.tsx#L520).

- **Given** A metadata request and canonical snapshot are pending for the same conversation.
- **When** The canonical snapshot resolves with the conversation before metadata does.
- **Then** The chat uses the canonical title, the losing metadata request is cancelled, and its later response does not change the page title or appear in the chat.

## chat-metadata-008

Original test `Unavailable metadata still waits for the canonical conversation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-metadata.test.tsx#L561).

- **Given** The primary chat’s metadata request fails with a service-unavailable error while a sidebar conversation loads successfully; canonical synchronization is pending.
- **When** The user opens the route containing both conversations, then canonical synchronization completes.
- **Then** The sidebar conversation is usable while the primary lookup waits, with only one chat region at that point. The recovered primary conversation then opens successfully.

## chat-metadata-009

Original test `Cold left and right conversations resolve independently`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-metadata.test.tsx#L609).

- **Given** The user opens left and right conversations while their metadata requests and the canonical snapshot are pending.
- **When** The left metadata resolves first, followed by the right metadata.
- **Then** Each conversation becomes usable independently; resolving the left does not cancel the right request. Both chats open, and the page title remains the left conversation’s title.
