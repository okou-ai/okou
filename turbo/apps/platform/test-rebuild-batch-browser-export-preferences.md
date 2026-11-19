# Browser values, export and preference recovery

The draft was checked against main `bd16ff2d7f3c`. No new upstream
commit or Platform execution change was present. The six previously
recorded additions remain separate from the 5,111 frozen executions.

| Family                             | First source comparisons | Rechecks | Confirmed deductions |
| ---------------------------------- | -----------------------: | -------: | -------------------: |
| Browser input                      |                       15 |        0 |                    0 |
| Table export                       |                        9 |        4 |                    0 |
| Subscription state and reset       |                       39 |        2 |                    0 |
| Preference recovery                |                       20 |        0 |                    2 |
| Project inbox and workflow recency |                        8 |        0 |                    2 |
| Total                              |                       91 |        6 |                    4 |

The [review ledger](test-rebuild-browser-export-preference-review.tsv)
records 97 completed decisions, including the source branch and retained ID
for each merge. All 97 used direct code and frozen assertion comparison,
with zero mapping-only rows. The [deduction ledger](test-rebuild-confirmed-deductions.tsv)
now records **55 confirmed net deductions out of 5,111 (1.08%)**.
The 1,534-execution gate is **1,479 away**. There are 1,850 unique
frozen IDs with a review or mapping, and 3,261 remain in the
[BDD-only queue](test-rebuild-product-action-queue.tsv). Sampling and
rebuilding remain pending.

## Evidence and disposition

- Browser scalar, checkbox, radio and select helpers use separate
  presence and value checks. Untouched optional fields are omitted.
  An explicitly cleared date or number sends an empty value.
  A multiselect clear sends empty indices and a single select uses
  an observed option index. Keep those cases and the required-field
  observed-state and disabled-choice boundaries.
- Table export account recovery retains verified connection and
  export mode. New connections and reconnects require a fresh
  explicit gesture after upload and metadata work, with distinct
  account intent. A storage failure occurs before Drive submission,
  while a provider failure occurs afterward. Keep both errors,
  replay, busy-button isolation, unconfirmed conversion, and the
  missing-URL versus revised-URL success cases.
- Subscription states differ by provider/window, unavailable versus
  exact credits, eligible versus disabled action, cooldown and
  reconnect text, and workspace/entry ownership. Sidebar Settings
  and reset confirmation dismissals keep their keyboard and explicit
  control paths, including focus restoration after a pending reset.
- Router pagination uses the same Settings action signal on every
  page. Two donors preserve both exit actions, both request stages
  and the fresh catalog after reopening. The second cancelled page
  still protects partial catalog isolation. Other preference cases
  keep workspace changes during a read or write, pending read-back
  per resource, and product-specific saved-versus-unsaved model
  outcomes.
- The archive call to action is only rendered for an empty inbox.
  A populated Project makes the inbox nonempty in both mobile and
  desktop. Within each layout, keep the donor with a real outside
  archived chat. It covers the same Project membership and no-CTA
  assertions and proves exclusion of that archived data. Recent
  workflow ordering preserves the independent new-thread navigation,
  existing-thread update, insertion and promotion-without-duplication
  paths.

## Remaining review

This batch confirmed four deductions across 97 direct comparisons
(4.1%). If every additional deduction came from the BDD-only queue,
45.4% of those 3,261 rows would have to be removed. The observed
evidence still does not establish a path to the gate.

Next, compare browser action reconciliation after a missed response or
while the action is applying, including route teardown and realtime
delivery. In another module, inspect sidebar virtualization wheel
takeover and Project transition matrices, and the still-unreviewed
Settings wallet card states. Prioritize a shared production callback
with identical persisted state and user result. Retain differences
in cancellation, identity or UI, and revisit the completed groups
only with new evidence about a concrete donor.
