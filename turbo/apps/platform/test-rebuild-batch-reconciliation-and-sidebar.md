# Browser reconciliation and sidebar screening

Main remained at `bd16ff2d7f3c` when the draft was checked. There was
no new Platform delta. The six previously recorded upstream additions
remain separate from the 5,111 frozen executions.

| Family                                                     | First source comparisons | Rechecks | Confirmed deductions |
| ---------------------------------------------------------- | -----------------------: | -------: | -------------------: |
| Browser action reconciliation                              |                       18 |        0 |                    2 |
| Sidebar virtualization                                     |                       26 |        5 |                    0 |
| Project transitions                                        |                        8 |        0 |                    0 |
| Wallet cards                                               |                        9 |        1 |                    0 |
| Remaining large auth, VNC, palette and diagnostic matrices |                       36 |        0 |                    0 |
| Total                                                      |                       97 |        6 |                    2 |

The [review ledger](test-rebuild-reconciliation-and-sidebar-review.tsv)
records each frozen ID and its comparison against current product code.
All 103 rows have decisions from source and assertion comparison.
This pass added no mapping-only rows. The
[deduction ledger](test-rebuild-confirmed-deductions.tsv) now records
**57 confirmed net deductions out of 5,111 (1.12%)**. The gate of
1,534 is **1,477 away**. There are 1,947 unique frozen IDs with a
review or mapping and 3,164 in the
[BDD-only queue](test-rebuild-product-action-queue.tsv). Sampling and
rebuilding stay pending.

## Evidence

- Lost Apply and Cancel responses both reread the matching action
  on a thread event. They retain different terminal outcomes,
  callback text and event IDs. A request initially in Applying can
  settle on the baseline reread or after a later thread notification.
  Keep those triggers. A matching terminal GET feeds the same
  read and render branches regardless of the previous result.
  The two retained Applying-to-terminal tests cover the same
  Cancelled and Uncertain heading and absence-of-form assertions
  as the first-GET variants, with added transition coverage.
- Wheel, touchmove and dragstart register separate viewport listeners.
  A real scroll update also changes scroll position. Keep those
  paths along with pointer reversal before the animation frame,
  reversal from the displayed height, mobile unmount, reduced motion,
  bounds, anchor preservation and per-layout footer behavior.
- Joining, moving and leaving a Project use the same mutation but
  different prior/target state and focus. Mobile uses its own
  membership entry and route. A subsequent event, prior renamed
  request, delete or folded-sidebar reveal exercises a distinct state
  reconciliation.
- Wallet gating independently requires connection, a payment-methods
  grant and no revocation pending. A missing authorization and late
  authorized refresh after disconnect exercise different inputs.
  Retain list filtering, order, fallback card labels, image errors,
  local read failures and management-link availability.
- The additional matrices cover separate trusted auth-step inputs,
  VNC transport/authentication pairs, CSS preset blocks and
  diagnostic callback allowlist entries. Matching output shape
  alone would leave important separate conditions unverified.

## Remaining review

Two deductions across 103 targeted comparisons yielded 1.9%.
Closing the 1,477 gap exclusively from the remaining BDD-only queue
would require 46.7% of those rows. The available evidence still does
not establish that yield.

The largest remaining shared declaration covers five hosted-site
access recovery inputs. Compare the trusted-return resolver outcomes
before proposing a donor. Then compare the four-row chat transcript
input-takeover matrix and browser pointer recovery matrix. The first
must preserve event registration and viewport ownership. The second
must preserve independently acknowledged input and its recovery
barriers. These are candidate families with no credited savings.
