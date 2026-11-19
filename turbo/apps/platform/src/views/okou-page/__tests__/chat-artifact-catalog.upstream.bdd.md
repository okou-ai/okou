# Upstream chat artifact catalog changes

These scenarios track #48933 at `03698f76c291`. The three changed
executions keep their frozen IDs in the [upstream mapping](../../../../test-rebuild-upstream-03698f76.tsv).
The two independently registered additions use upstream IDs. Keep the
baseline BDD intact as the comparison snapshot.

## upstream-48933-artifact-gallery-independent-paging

[Registration](https://github.com/okou-ai/okou/blob/03698f76c291f312c82beb556ff7f6e32ef8369d/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-catalog.test.tsx#L306).

- **Given** A chat has 65 artifacts and the open resource popover shows the first page.
- **When** The user presses Show more twice to reach report 65, opens report 1, and returns to all artifacts from its preview.
- **Then** The sidebar gallery opens on its own first page and shows Artifacts 60+. Report 65 is absent from that page despite being loaded in the popover.

## upstream-48933-artifact-gallery-refresh-recovery

[Registration](https://github.com/okou-ai/okou/blob/03698f76c291f312c82beb556ff7f6e32ef8369d/turbo/apps/platform/src/views/okou-page/__tests__/chat-resources-realtime.test.tsx#L121).

- **Given** A chat's artifact gallery is open and shows report.pdf.
- **When** A catalog-change notification triggers a refresh that fails, and the user opens the resources popover after service recovers.
- **Then** The gallery first says “Couldn't load artifacts.” After the popover opens, both the resources and the already-open gallery display report.pdf.

## Changes to frozen behavior

- `chat-navigation-artifact-sidebar-015` still explains the unavailable preview. If the artifact has since been deleted, Back to all artifacts refreshes the list and displays No artifacts found. The frozen assertion that the deleted report remains listed is superseded.
- `chat-resources-catalog-001` retains browsing without source URLs or message links. Returning from a loaded preview continues to show the available cached gallery during a catalog endpoint failure. Reopening the preview displays the updated filename.
- `chat-resources-realtime-005` retains live updates in the already-open gallery. With the resources popover also open, the new video appears in both views after the same catalog-change notification.
