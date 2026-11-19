# Activity paged events

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [activity-paged-events.test.tsx](activity-paged-events.test.tsx).

## activity-paged-events-001

Original test `A completed activity appears only after its full event history is ready`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/activity-page/__tests__/activity-paged-events.test.tsx#L55).

- **Given** A completed activity has two event-history pages, with the second page still loading.
- **When** The user opens the activity and the second page is released.
- **Then** The Test Agent heading appears while the second page is loading, but Page one content is not shown yet. After loading completes, both Page one content and Page two content appear, along with a Steps tab.
