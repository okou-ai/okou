# Workspace and sidebar rebuild

The batch uses the production Router with local Clerk, HTTP, realtime and
browser fixtures. The execution and GWT ledgers record the accepted expansion
of each selected scenario.

## Deferred files

The first local diagnostic run passed 39 of the 52 selected rows in
`org-members-tab`, `sidebar-chat-history`, `project-chat-list` and
`sidebar-virtualization`. Those passes were excluded from acceptance. The
four files were accepted later from their current `main` bodies. The
[projects and home batch](test-rebuild-batch-projects-and-home.md) records
the cause and resolution of each failure.

## Accepted files

The workspace entry and sidebar controls batch accepted 36 of 68 frozen rows
across ten files. The navigation and shortcuts batch accepted 37 of 69 frozen
rows across ten files. Both batches passed targeted Vitest, Platform test
TypeScript, ESLint and both Oxlint configurations before BDD removal.

`project-order-003` mentions ArrowUp in When and ArrowDown in Then for the open
menu. The retained row checks both keys with the menu open and asserts the
Project order after each key.
