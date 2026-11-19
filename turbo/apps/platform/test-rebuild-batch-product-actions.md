# App test screening by product action

The draft incorporated main `fc507f128dd1` through sync commit
`28433631`. Since `3f8a1be7`, #48854 changes API artifact timing,
including an audience-limited timing flag, and #48908 retires a
completed DB backfill operator. Neither changes a Platform test or
the Workflow, Browser, VNC, handoff or realtime branches compared here.
The two previously recorded upstream additions remain separate.
The two #48898 deductions are still counted once.

The cumulative projection is **27 confirmed net deductions out of
5,111 (0.53%)**, including six in this batch. The gate of 1,534
is **1,507 away**. Sampling and rebuilding remain pending.

| Family                        | Reviewed | First review | New confirmed |
| ----------------------------- | -------: | -----------: | ------------: |
| Workflow access               |       27 |           19 |             0 |
| Browser authorization         |       22 |           18 |             1 |
| Browser renewal and reconnect |       33 |           30 |             2 |
| VNC connection feedback       |       15 |           13 |             0 |
| Marketing task recovery       |       14 |           11 |             2 |
| Chat navigation               |       22 |           22 |             0 |
| Pending follow-up             |       11 |            0 |             1 |
| Total                         |      144 |          113 |             6 |

The [review ledger](test-rebuild-product-action-review.tsv) links each
row to the frozen registration, current source and retained ID where
applicable. The [deduction ledger](test-rebuild-confirmed-deductions.tsv)
records the added consolidations. Across all ledgers, 1,169 unique
frozen IDs have a source review or behavior mapping and 3,942 have
only the initial BDD pass.

- Workflow event links keep their own inline access result, loading,
  membership verification and exact target. Ordinary details use a
  toast and route replacement into the list. Official Workflow list
  exclusion, ordinary detail routing and event read-only inspection
  cover different results. Calendar warning, list recovery entry and
  account reconnect also exercise different actions.
- Standalone Browser authorization can use one representative error.
  The transcript retains its paused task and expiry action checks.
  Browser heartbeat can keep one accepted non-200 example for confirmed
  expiry and one for a reopened active window. The live revoke,
  transient transport, late response, and independent scope branches
  stay covered separately.
- VNC diagnostics preserve differences in carrier, generation, creation
  instance and owner. Credential editing and credential selection clear
  failed guided saves through different input paths. Close this batch
  of cross-surface comparisons and revisit only with a concrete donor.
- The Marketing handoff loader yields the same null result and notice
  for the reviewed lookup failures. Keep one recovery execution per
  downstream route and keep the representative 503 rejection at
  `/prompt` alongside its 404. Attachment and authentication
  failures remain separate.
- In the previous pending batch, seven IDs reached a disposition.
  Explicit true and omitted initialization share the realtime
  payload baseline branch, so the omitted variant stays. Explicit
  opt-out and the non-payload resync stay. The legacy Discord callback
  forwards three distinct statuses downstream and stays covered.

## Unreviewed product actions

The [product action queue](test-rebuild-product-action-queue.tsv)
assigns each of the 4,055 opening unreviewed IDs exactly once using
surface and action cues. Each row records the actual first reviews,
confirmed deductions from those reviews and the exact residual IDs.
The queue is an index for inspecting frozen tests and current entry
points. Its group sizes do not estimate savings.

Among the largest defined product areas, chat navigation has 135
unreviewed after reviewing 22 sidebar and slash-panel actions with
distinct routes, filters or keyboard behavior. Connector creation and
connection has 144, Chat feedback has 144, and Chat edit and save has 135. The broader other/runtime buckets need further categorization.
Start with connector setup and account connection across composer,
connector settings and Works. Group identical operations by actor,
provider, route and visible result to find retained donors, while
keeping provider-specific OAuth and permissions boundaries. Next,
compare Chat feedback driven by one backend action across transcript,
sidebar and dialogs. Avoid rescanning the completed Workflow and VNC
families without new evidence.

The previous batch's ceiling of 69 falls to at most 62 additional
deductions after its seven completed dispositions. This ceiling assumes
every other pending row can be resolved favorably, with at least one
lightbox execution retained. Even if all 62 were confirmed, at least
1,445 further deductions would be required elsewhere. The current
evidence does not establish a path to 30%. For scale, closing the
entire 1,507 gap from the still-unreviewed population alone would require
deducting more than 38% of that population.
