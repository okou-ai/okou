# Chat run status tail

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-run-status-tail.test.tsx](chat-run-status-tail.test.tsx).

## chat-run-status-tail-001

Original test `Show a scheduled workflow run.failed in a status card with its assistant avatar when no output was produced`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-status-tail.test.tsx#L93).

- **Given** A scheduled workflow event says “This workflow started on schedule,” and its run fails without producing output; the failure is reported as “run.failed.”
- **When** The user opens the chat.
- **Then** The generic failure appears once in a visible status card with “This run couldn't finish” and the assistant profile avatar. It is outside the message body and has no event actions; the workflow message remains visible.

## chat-run-status-tail-002

Original test `Keep a generic failure out of the message body while retaining previous output and actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-status-tail.test.tsx#L138).

- **Given** A run has produced a result and a related artifact, then failed with a generic error.
- **When** The user opens the chat.
- **Then** The failure appears once in the status tail, outside the retained result body. The result and its artifact and Copy message action remain available.

## chat-run-status-tail-003

Original test `Retire the previous error as soon as a new message is sent, before acknowledgement or output`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-status-tail.test.tsx#L180).

- **Given** The chat shows a previous generic failure and its retained result.
- **When** The user sends “Continue checking,” before the new request is acknowledged or produces output.
- **Then** The previous error disappears as thinking begins, while the previous result and its artifact and Copy message action remain.

## chat-run-status-tail-004

Original test `A subsequent failed response replaces the previous error while retaining its result`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-status-tail.test.tsx#L185).

- **Given** The chat shows a previous generic failure and its retained result, and the user has sent “Continue checking.”
- **When** The new run is acknowledged and fails with an execution timeout.
- **Then** The new failure is shown as “Time limit reached” in the status tail, replacing the previous generic error. Thinking disappears, one event-actions group is shown, and the previous result and its artifact and Copy message action remain.

## chat-run-status-tail-005

Original test `Derive the latest response from recorded input in the same run when opening a chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-status-tail.test.tsx#L199).

- **Given** A run has produced a result and failed, followed in the recorded history by another prompt in that same run; the run is active.
- **When** The user opens the chat.
- **Then** The recorded prompt “Continue from the recorded input” appears, the previous generic failure is absent, and the result and its artifact and Copy message action remain.

## chat-run-status-tail-006

Original test `Show only the latest failure when neither response produced output`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-status-tail.test.tsx#L219).

- **Given** Two runs have each failed without producing output: the first with a generic error and the second with an execution timeout.
- **When** The user opens the chat.
- **Then** Only the latest failure, “Time limit reached,” appears in the status tail; the generic failure and event-actions group are absent.

## chat-run-status-tail-007

Original test `Keep completion status visible while followups are unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-status-tail.test.tsx#L248).

- **Given** A run has completed with a result and related artifact, but no followups are initially available.
- **When** The user opens the chat, then followups become available later.
- **Then** The completion status remains visible without a “Keep going” group until followups arrive. Once available, “Summarize the check” appears in the followup group, and the result, artifact, and Copy message action remain visible throughout.

## chat-run-status-tail-008

Original test `Retire completion and followups while retaining the result actions`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-run-status-tail.test.tsx#L285).

- **Given** A completed run has a result, related artifact, and the followup “Summarize the check.”
- **When** The user sends “Start another check” while the new request is still awaiting acknowledgement.
- **Then** Thinking appears and the followup group disappears, while the previous result, artifact, and Copy message action remain.
