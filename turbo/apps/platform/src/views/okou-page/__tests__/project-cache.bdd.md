# Project cache

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [project-cache.test.tsx](project-cache.test.tsx).

## project-cache-001

Original test `Projects load and catch up on a browser without Symbol.dispose`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L86).

- **Given** The browser does not provide Symbol.dispose or Symbol.asyncDispose, and the project snapshot is “Launch” at sequence 1.
- **When** The user opens the chat page and project events arrive in two pages, first renaming the project to “Launch draft” at sequence 2 and then to “Launch ready” at sequence 3.
- **Then** The sidebar displays “Launch ready” and the Message textbox is available.

## project-cache-002

Original test `An empty cached chat list discovers a newly published snapshot`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L116).

- **Given** The cached chat list is empty, the initial chat snapshot is empty, and a project named “Launch” is available.
- **When** The user opens the home page; afterward, a “Planning conversation” thread is published in a new snapshot and the thread-list-changed event occurs.
- **Then** The page initially displays “Launch” and then discovers and displays “Planning conversation”.

## project-cache-003

Original test `Projects remain available online when IndexedDB cannot open`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L155).

- **Given** The project snapshot contains “Launch”, and IndexedDB cannot be opened because browser storage is disabled.
- **When** The user opens the chat page.
- **Then** “Launch” remains available in the sidebar, and the Message textbox is available.

## project-cache-004

Original test `Projects remain available online when IndexedDB cannot read`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L155).

- **Given** The project snapshot contains “Launch”, and IndexedDB cannot be read because browser storage is unavailable.
- **When** The user opens the chat page.
- **Then** “Launch” remains available in the sidebar, and the Message textbox is available.

## project-cache-005

Original test `Projects remain available online when IndexedDB cannot write`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L155).

- **Given** The project snapshot contains “Launch”, and IndexedDB cannot be written because browser storage is unavailable.
- **When** The user opens the chat page.
- **Then** “Launch” remains available in the sidebar, and the Message textbox is available.

## project-cache-006

Original test `Projects restore persisted events before an expired cursor is rebuilt`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L192).

- **Given** A first page has persisted a project rename event at sequence 2, so “Launch ready” is displayed. On the next page, the server snapshot is “Launch restored” at sequence 5.
- **When** The next page starts restoring persisted events while the event request is paused; the server then reports the cursor at sequence 2 has expired with HTTP 410, and the next request succeeds with no events.
- **Then** Before the paused request is released, “Launch ready” is displayed from persisted events. After the expired cursor is rebuilt, “Launch restored” is displayed.

## project-cache-007

Original test `Project cache stays private when another account opens the same browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L231).

- **Given** A first account has opened the browser and cached the project “Launch”. A different account then opens the same browser while its server snapshot request is pending.
- **When** The second account's snapshot request completes with “Other owner's Project”.
- **Then** Before that response, the old account's “Launch” project is not displayed; afterward, “Other owner's Project” is displayed.

## project-cache-008

Original test `Project cache stays private when another workspace opens the same browser`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/project-cache.test.tsx#L231).

- **Given** A first workspace has opened the browser and cached the project “Launch”. A different workspace then opens the same browser while its server snapshot request is pending.
- **When** The second workspace's snapshot request completes with “Other owner's Project”.
- **Then** Before that response, the old workspace's “Launch” project is not displayed; afterward, “Other owner's Project” is displayed.
