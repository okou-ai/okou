# Chat message plain text links

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-message-plain-text-links.test.tsx](chat-message-plain-text-links.test.tsx).

## chat-message-plain-text-links-001

Original test `A link a user typed is clickable in the message and in its feedback note`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-plain-text-links.test.tsx#L68).

- **Given** A user message contains a typed URL and a feedback note containing another URL; the prompt also includes literal Markdown-like bold markers.
- **When** The user views the chat message and feedback note.
- **Then** Both URLs are clickable links opening in a new tab with safe rel attributes, and the prompt text including the bold markers remains unchanged.

## chat-message-plain-text-links-002

Original test `A sentence typed onto the end of a link stays outside it`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-plain-text-links.test.tsx#L101).

- **Given** A user message contains a URL directly followed by prose, plus URLs with Chinese paths and query text.
- **When** The user views the message.
- **Then** The directly glued URL remains linked without absorbing the following prose, and the Chinese-path and Chinese-query URLs remain complete links.

## chat-message-plain-text-links-003

Original test `An ordinal written without a space still leaves a link`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-plain-text-links.test.tsx#L124).

- **Given** A user message contains an ordinal immediately followed by a URL and another ordinal spaced before a URL with a query parameter.
- **When** The user views the message.
- **Then** Both URLs are clickable links, including the URL immediately following “1.” and the queried URL following “2.”.

## chat-message-plain-text-links-004

Original test `A link glued to a word or a digit stays plain text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-plain-text-links.test.tsx#L141).

- **Given** A user message contains URLs glued directly to a preceding letter or digit.
- **When** The user views the message.
- **Then** Neither URL is made clickable; the complete message remains plain text.

## chat-message-plain-text-links-005

Original test `Text that only looks like a link stays plain text`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-message-plain-text-links.test.tsx#L156).

- **Given** A user message contains bare domains, an email address, JavaScript and data schemes, and an FTP URL.
- **When** The user views the message.
- **Then** None of these strings is made clickable; the complete message remains plain text.
