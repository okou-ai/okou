# Shared source matrix screening

Main advanced from `9c5688a9` to `8a2029a4` through draft sync commits
`a33b92d5` and `6c397e84`. #48927 changes the guest storage Rust
batch and its tests. #48919 changes Platform toolbar order and adds
four executions for dialog/sidebar and grouped/ungrouped actions.
The [upstream BDD](src/views/okou-page/__tests__/chat-artifact-action-group.upstream.bdd.md)
records each addition. The existing 15 frozen cases still use grouping
by default. The product changes are in the draft and the incoming
test implementation remains cleared. There are now six recorded
upstream additions, separate from the frozen denominator.

| Family                     | First source comparison | Rechecks | Confirmed deductions |
| -------------------------- | ----------------------: | -------: | -------------------: |
| Website permission refresh |                       4 |        0 |                    0 |
| Annotation IME             |                       4 |        0 |                    2 |
| Paid tools refresh         |                       3 |        0 |                    0 |
| Onboarding output format   |                      32 |        0 |                    2 |
| Browser entrypoint         |                      20 |        1 |                    4 |
| Voice segment boundaries   |                      10 |        1 |                    1 |
| HTML table dimensions      |                      10 |        0 |                    1 |
| Artifact download          |                       8 |        0 |                    0 |
| Total                      |                      91 |        2 |                   10 |

All 93 in this batch received direct comparisons between frozen bodies
and current product code. Zero rows received mapping alone. The
[case ledger](test-rebuild-source-matrix-review.tsv) records the
selected branch and the concrete donor for each consolidation.
The [deduction ledger](test-rebuild-confirmed-deductions.tsv) now
contains decisions supporting **46 confirmed net deductions out
of 5,111 (0.90%)**. This leaves **1,488** to the 1,534 gate.
The accumulated unique coverage is 1,710 reviewed or mapped frozen
IDs. The other 3,401 are in the [BDD-only queue](test-rebuild-product-action-queue.tsv).
Sampling and rebuilding stay pending.

## Eleven previously identified scenarios

The website sharing dialog and sidebar pass separate readiness inputs
and hold separate sessions despite using one action group. Each surface
preserves the share menu and committed public URL through both
successful iframe replacement and inline preview failure. The fullscreen
reorder affects toolbar placement and does not cover the refresh outcome.

The annotation editor returns before inspecting Backspace or Delete
for either active composition or Safari key code 229. Keep active
composition with Backspace and Safari's final key with Delete. Both
ordinary keys still remove the mark through the same branch.

The paid tools save path shares a row component. Image generation
has an additional image-model invalidation branch, Web search owns
a built-in toggle, and advanced research comes from the Router catalog.
Each retained test protects its own pending control, UI availability
and final confirmed state.

## Largest shared declaration families

- The onboarding format matrix was compared against the current
  classifier and the same draft hydration/clear path. The classifier
  was also exercised in isolation on all 32 frozen prompts. Keep
  command overrides, negated and qualified clauses, localized
  vocabulary and independent deliverable requests. The unclassified
  Document and Research fallback examples each have a donor that
  exercises the same branch with an incidental source mention.
- At supported browser thresholds, Edge, Opera and Android WebView
  return before brand-specific upgrade handling. Mobile Firefox
  returns from the same Firefox branch as desktop. Keep
  the lower-bound guidance per actual engine, platform and brand rule.
- A stopped positive voice checkpoint with no new samples returns
  before window and overlap calculation. A later equal checkpoint
  is represented by the retained earlier one. Window edge, recovery
  and stopped-tail cases still have separate outcomes.
- Mixed-case row/rowgroup headers exercise the same column-scope
  predicate and footer as the lowercase row-only example. Keep
  the mixed-case example, spanning rows, footer and distinct
  header formats. Download cases keep separate resource lookup,
  type classification and filename/telemetry checks.

## Remaining evidence

Ten confirmed deductions across 93 source comparisons is a 10.8%
targeted hit rate. It reflects selected matrices. Supplying the
remaining gap from BDD-only cases alone would require 43.8% of them.
There is no evidence-backed path to the gate at the observed yield.

Start the next batch with permission batch completion (five rows),
native date/time inputs (five), and cloud table export account recovery
(four). They share a registration or command and have inspectable
parameter or status boundaries. Then compare artifact toolbar
readiness, clear and reopen behavior across dialog and sidebar where
a common owner or donor can be established. These are review leads.
The counts describe available evidence to inspect and carry no
projected savings.
