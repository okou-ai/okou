# Chat resources realtime

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-resources-realtime.test.tsx](chat-resources-realtime.test.tsx).

## chat-resources-realtime-001

Original test `Show a published video in the open resource panel on notification without waiting for run completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-realtime.test.tsx#L72).

- **Given** A chat has an active run and its open resource panel initially has no artifacts. A video is then published for that chat.
- **When** A catalog-change notification arrives before the run finishes.
- **Then** The open panel shows the video and no longer shows the empty state without waiting for run completion.

## chat-resources-realtime-002

Original test `Show a published video in the open resource panel on reconnect without waiting for run completion`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-realtime.test.tsx#L72).

- **Given** A chat has an active run and its open resource panel initially has no artifacts. A video is then published for that chat, but the publication notification may have been missed.
- **When** The connection suspends and reconnects before the run finishes.
- **Then** The open panel shows the video and no longer shows the empty state without waiting for run completion.

## chat-resources-realtime-003

Original test `Show the latest published video when resources are first opened`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-realtime.test.tsx#L100).

- **Given** A video has been published for a chat before its resources are opened.
- **When** The user opens the resource panel after the catalog-change notification.
- **Then** The panel shows the latest published video.

## chat-resources-realtime-004

Original test `Refresh only the notified chat catalog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-realtime.test.tsx#L115).

- **Given** The open resource panel shows no artifacts for the current chat, and a video is published for that chat.
- **When** A catalog-change notification for a different chat arrives, followed by one for the current chat.
- **Then** The first notification leaves the empty state visible; the current chat's notification refreshes its catalog and shows the video.

## chat-resources-realtime-005

Original test `Show a newly published video in the already-open artifact gallery`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-realtime.test.tsx#L137).

- **Given** The chat's artifact gallery is open and shows a hosted site. A video is added to that chat's catalog.
- **When** A catalog-change notification for the chat arrives.
- **Then** The already-open gallery shows the newly published video alongside the hosted site.
