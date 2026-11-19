# Chat json preview

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-json-preview.test.tsx](chat-json-preview.test.tsx).

## chat-json-preview-001

Original test `A private chat JSON attachment uses the tree with sidebar=true`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-json-preview.test.tsx#L77).

- **Given** An authenticated user opens a private JSON chat attachment with sidebar preview enabled; the JSON contains a large integer and an empty object.
- **When** The user expands the items array and its first entry, then switches to Source.
- **Then** The JSON tree displays the exact integer 9223372036854775807 and the empty object. Source displays the original JSON text.

## chat-json-preview-002

Original test `A private chat JSON attachment uses the tree with sidebar=false`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-json-preview.test.tsx#L77).

- **Given** An authenticated user opens a private JSON chat attachment with sidebar preview disabled; the JSON contains a large integer and an empty object.
- **When** The user expands the items array and its first entry, then switches to Source.
- **Then** The JSON tree displays the exact integer 9223372036854775807 and the empty object. Source displays the original JSON text.

## chat-json-preview-003

Original test `A ranged attachment cannot present a complete-looking JSON prefix as a full tree`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-json-preview.test.tsx#L92).

- **Given** An authenticated user opens a private JSON chat attachment whose response contains HTTP 206 and a byte range covering only a prefix, even though that prefix looks like complete JSON.
- **When** The user views the attachment preview.
- **Then** Tree mode is disabled, a status says “Only part of this file is loaded,” and the source view shows the received prefix.
