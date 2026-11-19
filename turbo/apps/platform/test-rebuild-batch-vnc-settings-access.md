# VNC settings, access, and connection lifecycle

| File                    | Frozen rows | Selected and passing rows |
| ----------------------- | ----------: | ------------------------: |
| vnc-settings            |          64 |                        32 |
| vnc-lifecycle           |           3 |                         2 |
| vnc-authorization       |           8 |                         4 |
| vnc-access              |           1 |                         1 |
| vnc-delete-conflicts    |           3 |                         2 |
| remote-connection-order |           4 |                         2 |
| Total                   |          83 |                        43 |

The tests enter through the production Router and use local API, browser, and
realtime fixtures. They cover connection and credential forms, route and
identity preservation, cancellation and stale inputs, access prerequisites,
deletion conflicts, and ordering after connection edits. They do not contact a
real host or authorization provider.

The selected registration bodies retain the frozen actions and assertions.
The GWT checklist points to each accepted registration. The execution ledger
maps the actual Vitest expansion to the selected IDs in both directions.
Targeted Vitest, test TypeScript, ESLint, and Oxlint passed before removal of
the corresponding BDD files.
