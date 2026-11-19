# Chat engagement telemetry

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [chat-engagement-telemetry.test.tsx](chat-engagement-telemetry.test.tsx).

## chat-engagement-telemetry-001

Original test `chat engagement telemetry > reports expanding active work history without reporting collapse`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-engagement-telemetry.test.tsx#L60).

- **Given** An active chat contains several work-history entries, initially collapsed.
- **When** The user expands and then collapses the work history.
- **Then** The hidden work entry becomes visible on expansion, and one `chat_work_history_expanded` event is reported with active status. Collapsing hides the entry and does not report another event.

## chat-engagement-telemetry-002

Original test `chat engagement telemetry > reports expanding completed work history through the range control`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-engagement-telemetry.test.tsx#L137).

- **Given** A chat has completed work history with a 20-second duration, initially collapsed.
- **When** The user expands the work history.
- **Then** The work entries become visible, and one `chat_work_history_expanded` event is reported with completed status.

## chat-engagement-telemetry-003

Original test `chat engagement telemetry > reports recommendation frequency by kind in rows`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-engagement-telemetry.test.tsx#L209).

- **Given** A completed chat offers one generate recommendation for a presentation, one workflow recommendation, and one email recommendation. The recommendations appear in rows.
- **When** The user selects each recommendation, then selects the workflow recommendation again.
- **Then** One shown event reports three recommendations in rows, with one workflow and one email recommendation, kinds in generate/workflow/email order, and presentation as the generation type. Four selection events report indices 0, 1, 2, and 1 with their corresponding kinds; only the generate selection has presentation as its generation type.

## chat-engagement-telemetry-004

Original test `chat engagement telemetry > reports recommendation frequency by kind in quick-reply-rail`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/chat-engagement-telemetry.test.tsx#L209).

- **Given** A completed chat offers one generate recommendation for a presentation, one workflow recommendation, and one email recommendation. The user is on a touch device, so recommendations appear in a quick-reply rail.
- **When** The user selects each recommendation, then selects the workflow recommendation again.
- **Then** One shown event reports three recommendations in the quick-reply rail, with one workflow and one email recommendation, kinds in generate/workflow/email order, and presentation as the generation type. Four selection events report indices 0, 1, 2, and 1 with their corresponding kinds; only the generate selection has presentation as its generation type.
