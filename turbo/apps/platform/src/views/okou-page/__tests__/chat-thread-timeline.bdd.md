# Chat thread timeline

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-thread-timeline.test.tsx](chat-thread-timeline.test.tsx).

## chat-thread-timeline-001

Original test `Chat dates separate days once and include the year only for past years`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-timeline.test.tsx#L44).

- **Given** A conversation has messages from December 18, 2025, October 26 and 27, 2026, and October 28, 2026.
- **When** The user views the conversation on October 28, 2026.
- **Then** Date separators appear once per represented day: “Dec 18, 2025,” “Oct 26,” “Yesterday,” and “Today.” The year is shown for the past year but omitted for dates in the current year.

## chat-thread-timeline-002

Original test `A conversation containing only today's messages does not need a Today divider`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-timeline.test.tsx#L63).

- **Given** A conversation contains only a message from today.
- **When** The user views the conversation.
- **Then** The message is visible and no “Today” date separator appears.

## chat-thread-timeline-003

Original test `Older history does not enable Today without a Yesterday section`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-timeline.test.tsx#L73).

- **Given** A conversation has a message from two days ago and a message from today, with no message from yesterday.
- **When** The user views the conversation.
- **Then** The older message has an “Oct 26” separator, and no “Today” separator appears.

## chat-thread-timeline-004

Original test `Messages in the same user turn receive a date boundary at local midnight`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-timeline.test.tsx#L86).

- **Given** Two messages in the same user turn occur at 11:59 p.m. and 12:01 a.m. on consecutive local dates.
- **When** The user views the conversation.
- **Then** Both “Yesterday” and “Today” separators appear, and the “Today” separator precedes the early-morning message.

## chat-thread-timeline-005

Original test `Hidden lifecycle events from yesterday do not create a Yesterday section`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-timeline.test.tsx#L108).

- **Given** A conversation has a hidden run-completion event from yesterday and a visible message from today.
- **When** The user views the conversation.
- **Then** Neither a “Yesterday” nor a “Today” separator appears.

## chat-thread-timeline-006

Original test `An assistant reply can open a new date section`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-thread-timeline.test.tsx#L127).

- **Given** A conversation has a user message late on October 26, an assistant reply on October 27, and a user message on October 28.
- **When** The user views the conversation.
- **Then** The “Yesterday” separator precedes the assistant reply, and a “Today” separator appears for the October 28 message.
