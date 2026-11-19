# Chat thread link

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-thread-link.test.ts](chat-thread-link.test.ts).

## chat-thread-link-001

Original test `A link to a chat in this App or the production App names its thread`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/chat-thread-link.test.ts#L8).

- **Given** A link points to the specified chat thread on app.okou.ai, the current staging app origin, the current localhost origin, or a relative chat path; host casing, the default HTTPS port, and a trailing slash may vary.
- **When** The chat link is parsed.
- **Then** It identifies the specified thread.

## chat-thread-link-002

Original test `A chat link keeps its query and hash`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/chat-thread-link.test.ts#L28).

- **Given** A chat link to the specified thread includes a query parameter and a hash, or a relative chat link includes a hash.
- **When** The chat link is parsed.
- **Then** It identifies the thread and preserves the query parameter and hash; the relative link retains its hash as well.

## chat-thread-link-003

Original test `Any other link stays external`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/lib/__tests__/chat-thread-link.test.ts#L41). · **intent review**

- **Given** A link targets another host or scheme, includes user information, is protocol-relative or improperly relative, uses an invalid thread ID, or points to a different chat path.
- **When** The chat link is parsed.
- **Then** It is not recognized as an internal chat-thread link.
