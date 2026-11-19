# Activity inspect page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [activity-inspect-page.test.tsx](activity-inspect-page.test.tsx).

## activity-inspect-page-001

Original test `A user can inspect steps, context, and network details from an exported log`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-inspect-page.test.tsx#L444).

- **Given** The activity inspector has no log loaded, and debug access is enabled.
- **When** The user uploads an exported log containing two assistant steps, context, and two network requests, then searches for “OAuth” and visits Context and Network.
- **Then** The inspector shows the activity status, duration, timestamps, and both steps; the search matches only the OAuth step. Context values and both storage mounts are visible. Network details include request method, status, latency, and firewall; request details can be expanded and collapsed with pointer and keyboard, headers are shown with truncation indicators, and opening the second request shows its own connector details.

## activity-inspect-page-002

Original test `Selecting and copying a network URL preserves its request details`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-inspect-page.test.tsx#L604).

- **Given** An imported log has a network request URL, and the Network tab is open.
- **When** The user selects and copies the URL, then activates the request disclosure and selects the URL again.
- **Then** The copied text is exactly the URL, selection does not toggle the disclosure, and explicit activation still opens the request details. Activating the request’s GET value collapses the details.

## activity-inspect-page-003

Original test `An imported log does not expose debug diagnostics when debug access is disabled`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-inspect-page.test.tsx#L650).

- **Given** The inspector has no log loaded and debug access is disabled.
- **When** The user uploads an exported log containing context diagnostics.
- **Then** The activity and its assistant step appear, but the Context tab and secret name are not exposed.

## activity-inspect-page-004

Original test `Imported activities preserve their trigger source`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-inspect-page.test.tsx#L679).

- **Given** An imported activity has trigger source “test.”
- **When** The user uploads it to the inspector.
- **Then** The activity displays its source as “Test.”

## activity-inspect-page-005

Original test `The inspector presents exported Codex events as readable activity steps`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-inspect-page.test.tsx#L688).

- **Given** The inspector has no log loaded and debug access is enabled.
- **When** The user uploads a failed Codex log containing assistant output, a warning, a plan update, an error, and a failed turn.
- **Then** The inspector displays the failed status and readable text for each event, including the error details, without rendering an object as “[object Object]”. Searching for the warning matches one of four steps and hides the plan update.

## activity-inspect-page-006

Original test `The activity inspector explains Codex collaboration events`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-inspect-page.test.tsx#L751).

- **Given** The inspector has no log loaded and debug access is enabled.
- **When** The user uploads a Codex log containing collaboration calls, subagent activity, context compaction, and a future event type.
- **Then** Collaboration calls are summarized as SpawnAgent, all four subagent activity kinds and their path are explained, and context compaction is labeled. The future event remains labeled as a Codex future operation; these events are not shown as Unknown or as raw Codex collaboration, subagent, or compaction types.

## activity-inspect-page-007

Original test `The inspector rejects activity logs larger than 25 MB`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-inspect-page.test.tsx#L791).

- **Given** The inspector has no log loaded and the user selects a 26 MB JSON file.
- **When** They upload the file.
- **Then** The inspector reports that the JSON is too large and must be under 25 MB; no imported-log heading appears.
