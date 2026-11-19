# App rebuild permission and navigation batches

This round audited main `4bf10b89` before and after the test work.
There is no new upstream increment in this interval.

| File                      | Frozen executions | Registered and passed |
| ------------------------- | ----------------: | --------------------: |
| Standalone permission     |                13 |                     7 |
| Grouped permissions       |                11 |                     6 |
| Notification navigation   |                 2 |                     1 |
| Service status notice     |                 3 |                     2 |
| This round                |                29 |                    16 |
| All verified files so far |                49 |                    28 |

The runtime Vitest JSON reporter recorded all 16 passing executions.
Static collection supplies registration locations and reports parameter
templates. The [execution ledger](test-rebuild-rebuilt-executions.tsv)
records the expanded runtime names and stable IDs. Focused Oxlint
passed with warnings treated as errors. Each completed file's adjacent
temporary BDD was removed. The cumulative verified net reduction is
21 frozen executions across nine files. The final 30% gate remains
subject to the full suite's actual registered count.

## Permissions reconciliation

Main replaced the obsolete rollout success variant
`permission-batch-page-001` with the shared connector-scope success
variant `permission-batch-page-003`. The latter carries the selected
behavior with one execution. The existing `-002` continuation failure
still exists after the rollout switch removal. The My Okou success
variant `-005` remains outside this selection. All three ambiguous
current registrations and two removed variant identities now appear in
the [upstream ledger](test-rebuild-upstream-eaae30ac-scenarios.tsv).
There are 72 remaining review dispositions across other files.

The standalone entry verifies the real confirmation, persisted
grant, realtime invalidation and the distinct effects of continuation
success and failure. The grouped entry checks current connector scope,
persisted grants, continuation failure, independent next-agent
navigation and fail-closed handling of missing metadata or
acknowledgments. HTTP fixtures implement the external permission,
catalog, agent and chat APIs. Realtime and browser history events go
through the app's real listeners.

The navigation cases exercise the browser service worker message and
the status provider HTTP boundary. They observe the URL, incident
presentation and dismissal or mobile navigation. The runtime does not
contact the external status provider during tests.

## Next batch

Continue with hosted artifacts and shared-thread entries. Resolve the
affected upstream mappings before rebuilding connector account and chat
permission cards. The two Ethan review points in
[batch one](test-rebuild-batch-one.md) remain open.
