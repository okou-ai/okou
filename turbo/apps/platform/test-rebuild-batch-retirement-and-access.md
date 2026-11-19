# App test screening for retirement and access outcomes

The frozen baseline is 5,111 executions in 485 BDD inventories at
`b0a10287edf42`. The draft branch incorporated main `3f8a1be7f346`
through sync commits `59d594dc` and `2942b828`. The upstream changes
since `d36b9aec` touch runner dispatch, CI, Desktop diagnostics,
queued-model routing and My Okou activation for selected workspace cohorts.
There are no Platform test changes in this interval. The two previously
recorded upstream additions remain separate, and the two verified
upstream Workflow consolidations from #48898 remain counted once.

## Current tally

Six additional frozen executions can consolidate into retained stable IDs.
The [deduction ledger](test-rebuild-confirmed-deductions.tsv) records those
decisions. The cumulative confirmed reduction is **21 of 5,111 (0.41%)**.
The 1,534-execution gate is **1,513 away**. This is a count of approved
screening decisions on frozen executions. Sampling and rebuilding stay
pending at this gate.

| Evidence pass                   | Frozen executions | Retain | Merge | Deeper review |
| ------------------------------- | ----------------: | -----: | ----: | ------------: |
| Retirement and internal checks  |               198 |    131 |     0 |            67 |
| App access and failure outcomes |                28 |     19 |     6 |             3 |

The 226 rows are unique across the two passes. Of these, 210 are new to
the accumulated source and behavior ledgers. Across the prior ledgers
and this batch, 1,056 unique frozen IDs have a recorded source-assisted
review, direct comparison or behavior mapping. The other 4,055 have
the initial BDD screening. Recorded source-assisted review can still
require a direct decision.

## Retirement and implementation details

The [review ledger](test-rebuild-retired-internal-review.tsv) starts
from 107 retirement or compatibility flags and 137 internal or static
check flags. Four executions have both flags. Of the 240 unique
executions, 42 already had decisions or behavior mappings in prior
ledgers. The remaining 198 span 130 registration sites. Direct product
source or manual frozen-source checks cover 54 executions in this pass,
and source-assisted notes cover 144. Retain dispositions from assisted
review are provisional.

- Platform route registrations in `signals/bootstrap.ts` still serve
  legacy Telegram links, `/works`, Settings redirects and shared
  artifact links. The onboarding Team redirect still accepts old entry
  links. A retired destination can leave behind a supported redirect.
- `core/src/feature-switch.ts` keeps `SingleAgent` configurable.
  Platform still reads it in bootstrap and Settings and renders the
  legacy branch when disabled.
- `prompt-page-setup.ts` converts an unavailable template into an
  editable brief. The model catalog still interprets old stored IDs.
  Those fixtures protect existing links or saved data.
- Labels such as “retired” also occur in live tab and session teardown
  tests. Internal state assertions sometimes accompany visible guarantees
  such as cancellation keeping an outdated page from rendering.

This pass found no additional proven deletion in the flagged cohort.
Of its 67 pending rows, 24 carry the retirement flag and 44 carry the
internal flag. One carries both. Treat these as a ceiling of 67
additional rows, subject to checking current callers and proving the
remaining coverage.

## App and API failure outcomes

The [outcome ledger](test-rebuild-cross-layer-outcomes.tsv) records
the App entry, source branch, API evidence and actual retained ID
where applicable. Searching for status variants within a registered
test body found additional candidates after tracing route entries and
shared response branches. Each consolidation preserves the App outcome
and leaves the API checks for ownership, membership and conflict in
place.

- Shared artifact, shared conversation and Workflow automation entries
  use a single App outcome for the reviewed 403 and 404 variants.
  Their retained rows each preserve the page's unavailable state and
  its applicable affordances.
- A denied publication listing keeps the public page downloadable as
  one HTML file. The retained case asserts the same bytes and filename.
- Handled 403, 404 and 409 responses to message sharing all roll back
  optimistic copy and leave Share and the composer usable. An unaccepted
  503 follows the rejected-promise path and remains covered separately.
- Connector permission and approval cases still cover App responsibilities
  such as scope selection, resuming chat, timing around the callback,
  error feedback and fail-closed rendering. API response assertions
  cover different guarantees.
- The restricted artifact lightbox matrix mixes three status responses
  with three media types. Keep the three pending until the attachment
  preselection and access-card rendering paths are compared.

The two pending cohorts have no shared IDs. The 67 flagged rows and
three lightbox rows provide a ceiling of **69 more deductions** in this
batch because at least one lightbox row is needed. Even that ceiling
would leave 1,444 more deductions needed. The 1,018 broad API filename
matches are an inventory signal. Of those, 829 lack a recorded source
or behavior pass so far. They cannot establish a credible additional
deduction count without matching operations and outcomes.

## Next batch

Start with real product actions that share entry-to-outcome code across
surfaces. For Workflow, compare resource-scoped denial and unavailable
states across event links, list and detail. Keep route registration
and recovery affordances distinct. For browser and VNC, trace the same
connect, reconnect, or unavailable action across the session page,
sidebar and remote-access UI. Compare clipboard, retry and permission
state only where the actor, precondition and product branch coincide.
Within artifacts, trace resolver, lightbox and download access behavior
alongside the restricted-media variants. Prioritize families with
actual donor IDs before expanding retired-name or API-filename searches.
