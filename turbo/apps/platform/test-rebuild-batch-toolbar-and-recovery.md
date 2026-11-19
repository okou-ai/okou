# Artifact toolbar and recovery screening

Main `bd16ff2d7f3c` was incorporated through sync commit `96a1b199`.
The upstream change, #48929, affects API run startup handoffs and
changes no Platform tests. The source of #48919 still expands to four
toolbar-order executions. Its [upstream BDD](src/views/okou-page/__tests__/chat-artifact-action-group.upstream.bdd.md)
matches dialog and sidebar with grouping both off and on, including
the action before the separator, fullscreen, and the surface's close
control. These four IDs remain part of the six tracked upstream
additions and outside the 5,111 frozen executions.

| Family                        | First source comparisons | Rechecks | Confirmed deductions |
| ----------------------------- | -----------------------: | -------: | -------------------: |
| Permission batch completion   |                        5 |        0 |                    0 |
| Native date and time          |                        5 |        0 |                    0 |
| Table export account recovery |                        4 |        0 |                    0 |
| Artifact toolbar              |                       11 |        4 |                    0 |
| Preview onboarding skip       |                        8 |        0 |                    2 |
| Direct hosted image download  |                        4 |        0 |                    1 |
| Hosted-site banner and copy   |                        4 |        0 |                    2 |
| Initial locale                |                        4 |        0 |                    0 |
| Instructions editor entry     |                        4 |        0 |                    0 |
| Total                         |                       49 |        4 |                    5 |

All 53 rows received direct comparisons. This pass added no mapping-only
rows. The [review ledger](test-rebuild-toolbar-and-recovery-review.tsv)
records the original registration, production branch and donor where
applicable. The [deduction ledger](test-rebuild-confirmed-deductions.tsv)
now records **51 confirmed net deductions out of 5,111 (1.00%)**.
The 1,534-row gate is **1,483 away**. The cumulative unique coverage is
1,759 reviewed or mapped frozen IDs. The other 3,352 remain in the
[BDD-only queue](test-rebuild-product-action-queue.tsv). Sampling and
rebuilding stay pending.

## Evidence

- Permission batches retain separate legacy and shared-account grant
  writes and their visible scopes. Continuation failure is a partial
  success and must leave all permissions visibly allowed. Date and time
  share input code, but the five native controls enforce distinct input
  types and canonical value shapes. Table exports choose among four
  different authorization or OAuth states before saving to the verified
  account and destination.
- The dialog and sidebar feed different metadata, ownership and sharing
  scopes to a shared action group. Pending ownership and pending share
  details independently hide the controls. Closing the dialog uses
  lightbox dismissal while closing the sidebar tears down the sidebar
  preview. Preserve reopen, metadata replacement, focus restoration,
  read-only actions and both lookup failure paths. The new upstream
  toolbar assertions cover order.
- The onboarding Skip command reads the resolved preview environment.
  Three administrator preview URL forms reach the same branch and
  the same enabled-state and composer assertions. Keep one administrator
  scenario and the non-admin case. Keep the separately recognized
  production and development predicate inputs.
- Direct hosted image download keeps a normal asset, an extensionless
  path with a trailing slash, and the escaped path. The trailing slash
  case includes the unadorned extensionless manifest lookup and the
  exact-byte single-download assertions. Hosted-site banner copy keeps
  one scenario per surface and one of each footer layout. The remaining
  toggles, server-confirmed revisions, copy callbacks and surface labels
  are exercised by those two donors.

## Remaining work

Five deductions across 53 selected direct comparisons is 9.4%.
Supplying the outstanding 1,483 exclusively from the BDD-only queue
would require 44.2% of the 3,352 rows. The current evidence does not
support that yield.

Next, compare the unreviewed optional/cleared browser values alongside
the field-action validation for empty requests, then the deferred
authorization and upload-failure branches in table export. For another
distinct surface, inspect subscription status and preference
recovery matrices for status cases that reach the same visible result.
Prioritize equivalence within a common state transition, and keep the
completed toolbar, native-type and permission batches closed unless
incoming code supplies specific new evidence.
