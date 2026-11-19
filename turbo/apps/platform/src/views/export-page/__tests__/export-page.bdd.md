# Export page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [export-page.test.tsx](export-page.test.tsx).

## export-page-001

Original test `A completed export shows its contents, expiry, and cooldown`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/export-page/__tests__/export-page.test.tsx#L91).

- **Given** A completed export is available, and the download expires in 1 day and 12 hours. The user is still within the 24-hour export cooldown.
- **When** The user opens the export page and selects “Export again.”
- **Then** The page lists chat threads, chat messages, accessible agent and workflow instructions, and current memory files, and states that artifact, attachment, and workflow supporting files are excluded. It shows the download link with the provided URL and says it expires in 1 day and 12 hours; attempting to export again displays that exports are available once every 24 hours.

## export-page-002

Original test `Starting an export keeps its progress visible during refresh and offers the completed download`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/export-page/__tests__/export-page.test.tsx#L137).

- **Given** No export is available, and the user can start one.
- **When** The user starts an export while its status refreshes from running to completed.
- **Then** The page shows “Preparing your export” during the refresh and does not show “Checking export status.” After completion, it offers the download link to the completed export.
