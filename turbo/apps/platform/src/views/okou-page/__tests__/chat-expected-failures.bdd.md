# Chat expected failures

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-expected-failures.test.tsx](chat-expected-failures.test.tsx).

## chat-expected-failures-001

Original test `show the upgrade dialog for headerless event-row 426 using direct transport`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-expected-failures.test.tsx#L17).

- **Given** A chat run page receives an HTTP 426 response with a client-upgrade-required error and no response headers.
- **When** The page loads using direct transport.
- **Then** Page setup rejects with status 426, and an “Update required” dialog is visible.

## chat-expected-failures-002

Original test `show the upgrade dialog for headerless event-row 426 using message-port transport`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-expected-failures.test.tsx#L17).

- **Given** A chat run page receives an HTTP 426 response with a client-upgrade-required error and no response headers.
- **When** The page loads using message-port transport.
- **Then** Page setup rejects with status 426, and an “Update required” dialog is visible.

## chat-expected-failures-003

Original test `keep microphone guidance and retry after permission denial`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-expected-failures.test.tsx#L45).

- **Given** The user has entered “Keep these notes.” in the chat composer, and voice input is available. The browser denies microphone access.
- **When** The user starts voice input, then retries after the denial guidance appears.
- **Then** The denial guidance says microphone access was denied and instructs the user to allow access and try again. The draft remains in the composer, the denial is reported to Sentry and logged to the console, and the retry starts recording.
