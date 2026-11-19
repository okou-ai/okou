# Upstream chat artifact catalog changes

This supplement tracks remaining changes from #48933 at `03698f76c291`. See the [upstream mapping](../../../../test-rebuild-upstream-03698f76.tsv) for completed scenarios.

## Changes to frozen behavior

- `chat-navigation-artifact-sidebar-015` still explains the unavailable preview. If the artifact has since been deleted, Back to all artifacts refreshes the list and displays No artifacts found. The frozen assertion that the deleted report remains listed is superseded.
