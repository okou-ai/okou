# Input takeover and hosted-site recovery screening

Main moved from `bd16ff2d` to `39d40e3eaa0f`. The Platform changes in this
interval are its version and changelog. The API and iOS changes
include skills catalog preparation, widget update ownership and
retiring reward orchestration, and updating chat read cursors. No Platform tests were added, removed
or changed. The six recorded upstream additions remain outside the
5,111 frozen executions.

| Family                         | First source comparisons | Rechecks | Confirmed deductions |
| ------------------------------ | -----------------------: | -------: | -------------------: |
| Hosted-site recovery           |                        5 |        0 |                    0 |
| Chat transcript takeover       |                        6 |        1 |                    0 |
| Browser pointer receipts       |                        8 |        0 |                    0 |
| Other shared declaration sites |                       42 |        0 |                    4 |
| Total                          |                       61 |        1 |                    4 |

All 62 are direct comparisons with a recorded disposition in the
[review ledger](test-rebuild-input-and-site-recovery-review.tsv).
This pass added zero mapping-only rows. The
[deduction ledger](test-rebuild-confirmed-deductions.tsv) reaches
**61 confirmed net deductions out of 5,111 (1.19%)**.
The 1,534-execution gate is **1,473 away**. Across all ledgers,
2,008 frozen IDs have a review or source mapping and 3,103 remain
in the [BDD-only queue](test-rebuild-product-action-queue.tsv).
Sampling and rebuilding stay pending.

## Evidence

- The five hosted-site return inputs protect distinct rejection
  boundaries. The hosted domain and regular site label must match,
  the normalized return stays within the site, reserved preview
  labels are rejected, and internal callback paths cannot become
  destinations. The similar expired-access screen is retained for
  each relevant input.
- Transcript reveal restoration cancels through separate wheel,
  touch and pointer listeners, plus a guarded scroll-key path.
  The real scrollbar thumb has distinct DOM capture and drag
  behavior. Reader scroll position, explicit jump-to-latest, and
  cancellation on reopen keep separate tests.
- Mouse press, release, drag and modified hover carry distinct held
  state when retiring the original browser input session. Neutral
  hover on a detached or destroyed session is a separate recovery
  condition. Keep the cases that preserve a prior native/key
  failure and the same-target fence while another tab can recover.
- The Feishu and Lark credential wizard uses one form submit callback.
  Keep Feishu Enter and Lark Next to preserve both provider contracts,
  pending validation and returning to the original draft. The icon
  is one native anchor with one accepted click handler, whether
  activated by Enter or primary click. Keep Feishu Enter and Lark
  click with each platform's file name, bytes and wizard location.
  The four removed cross-product executions have actual retained
  stable IDs.
- Additional checked matrices retain distinct Slack return routes
  and auth states, MCP provider feedback and reporting, artifact
  type/surface attribution, and pointer/keyboard/touch/composition
  takeover. Remote-access saves preserve protocol-specific behavior,
  and onboarding keeps separate redemption and handoff inputs.

## Remaining review

Four deductions across 62 targeted comparisons yielded 6.5%.
Closing the remaining 1,473 exclusively through the BDD-only queue
would require over 47% of that queue. There is no verified path to
that yield from the current evidence.

Next, review the largest remaining standalone Desktop authorization
matrices for initial unavailability reasons and refresh while pending.
Then compare the saved-password-help field kinds and the grouped
subscription/permission feedback still awaiting review. Preserve
independent user-facing controls and retry or permission outcomes.
These are source leads with no credited savings.
