# Activity log

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [activity-log.test.tsx](activity-log.test.tsx).

## activity-log-001

Original test `Failed activities accept old and new responses without displaying diagnostics: Oops, something went wrong.`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-log.test.tsx#L110).

- **Given** A failed activity uses the old response shape with a private diagnostic string and no newer failure-reason field.
- **When** The user opens the activity.
- **Then** The page displays “Oops, something went wrong.” and does not display the private diagnostic.

## activity-log-002

Original test `Failed activities accept old and new responses without displaying diagnostics: Your model provider's usage allowance h…`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-log.test.tsx#L110).

- **Given** A failed activity uses the newer “usage_limit” failure reason and has no private diagnostic string.
- **When** The user opens the activity.
- **Then** The page displays the chat-run usage-limit message and does not display a private diagnostic.

## activity-log-003

Original test `Large plans and file-change lists remain readable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-log.test.tsx#L176).

- **Given** A Codex activity contains a plan with 25 steps and a file-change list with 25 entries.
- **When** The user opens the activity log.
- **Then** Entries through Step 19 and src/file-19.ts are shown, with “5 more steps” and “5 more changes” indicators; Step 20 and src/file-20.ts are not shown.

## activity-log-004

Original test `Activity logs do not hide a failed run behind completed child work`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-log.test.tsx#L215).

- **Given** A failed Codex activity contains completed child work followed by a failed turn.
- **When** The user opens the activity log.
- **Then** The activity is shown as failed, the completed subagent is visible, and the turn is labeled “Turn failed”; the run is not labeled “Done.”

## activity-log-005

Original test `Activity logs attach results to the correct subtask`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-log.test.tsx#L253).

- **Given** Two tasks each have a Bash tool call with the same tool-use ID, each followed by its own result; another result has an unmatched parent task.
- **When** The user expands both tasks and their Bash calls, then expands the unmatched result.
- **Then** Task A shows only “result task-a,” and Task B shows only “result task-b.” The unmatched parent result is visible under Unknown.

## activity-log-006

Original test `Activity logs preserve distinct events recorded at the same position`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-log.test.tsx#L350).

- **Given** An activity contains two identical assistant events at the same sequence position and a distinct assistant event at that position.
- **When** The user opens the activity log.
- **Then** The distinct event remains visible, while the identical repeated boundary event is shown once.

## activity-log-007

Original test `Activity logs preserve the order of closely related events`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-log.test.tsx#L366).

- **Given** An activity records two tool results, two successive Todo updates, and a normal assistant event in that order.
- **When** The user opens the tool results and Todo entries.
- **Then** The rendered order is first result, second result, first Todo update, second Todo update, then the normal event. The first Todo contains only the first task; the second contains both tasks.

## activity-log-008

Original test `Activity search finds content inside nested work`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-log.test.tsx#L456).

- **Given** An activity has nested child output, a Todo task, and an error result inside nested work.
- **When** The user searches for each of those contents and then searches for “TodoWrite.”
- **Then** Each nested output, task text, and error result can be found as one of three matching steps while the parent task remains visible. Searching for the implementation tool name matches zero steps and hides the Todo entry.

## activity-log-009

Original test `Activity logs show useful reasoning without progress noise`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-log.test.tsx#L544).

- **Given** An activity has assistant reasoning and response text, plus a system event containing a thinking-token count.
- **When** The user opens the Thinking entry.
- **Then** The reasoning and response text are available, while the progress event type and numeric token count are not displayed.
