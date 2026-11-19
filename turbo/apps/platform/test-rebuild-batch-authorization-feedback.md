# Authorization, subscription and recovery screening

The Draft started at `ade351370eb5` with main `39d40e3eaa0f`.
Main advanced to `d972a616` through #48934 (ESLint rule sharing),
#48945 (runner receipt comparison) and #48937 (Teams API launch delivery).
The Platform tree is unchanged. The six previously inventoried upstream additions remain separate,
and the Workflow attribution is unchanged.

| Family                               | First source reviews | Rechecks | Confirmed deductions |
| ------------------------------------ | -------------------: | -------: | -------------------: |
| Desktop authorization and refresh    |                   26 |        2 |                    2 |
| Browser saved-password help          |                    4 |        0 |                    0 |
| Model subscription linking           |                   13 |        0 |                    1 |
| Email subscription preferences       |                    3 |        0 |                    0 |
| In-chat connector permissions        |                    6 |        0 |                    0 |
| Standalone grouped permissions       |                    6 |        0 |                    0 |
| Sidebar gesture completion           |                    5 |        0 |                    0 |
| Project cache recovery and ownership |                    8 |        0 |                    0 |
| SSH host identity recovery           |                    4 |        0 |                    0 |
| Total                                |                   75 |        2 |                    3 |

The [review ledger](test-rebuild-authorization-feedback-review.tsv) links all
77 conclusions to their original registration and current source. There
are 74 retained rows and three consolidations, with zero mapping-only
rows. The [deduction ledger](test-rebuild-confirmed-deductions.tsv) contains
57 verified deductions, and the [initial screening](test-rebuild-screening.tsv)
records seven verified harness removals. Together they total
**64 confirmed frozen deductions out of 5,111 (1.25%)**. The hard
gate remains 1,534. The remaining gap is **1,470 executions**. Across all
ledgers, 2,083 frozen IDs have review or mapping evidence, and 3,028
remain in the [BDD-only queue](test-rebuild-product-action-queue.tsv).

## Coverage and retained scenarios

- Desktop Shell authorization subscribes to both topics with one shared
  invalidation callback. Keep `desktop-shell-authorization-012` for a
  pending card after a Shell event and `-015` for an approved card after a
  host event. Between them both subscriptions still deliver an event, both
  pending refresh states retain their reason, device and active action, and
  the final Denied and Revoked views remain verified. The four distinct
  approval blockers, error recovery, deadlines, and optional callbacks
  remain covered.
- The linked-subscription check uses a nonempty account list. Both Codex
  fixtures supply the same usage window and neither supplies credits.
  `subscription-linking-007` retains the exact menu and ChatGPT usage
  assertions with reconnect needed. Healthy linking remains covered by
  `-002` and `-003`. Usage credit visibility for a reconnect-needed
  provider is a separate branch. Email opt-in, delivery availability and
  morning brief generation are separate, with a retained failed-save retry.
- Username and password help preserves each control's entered value.
  One-time-code and ordinary text inputs independently verify the absence
  of a credential guide. Connector permissions retain load and mutation
  failures, metadata errors, expired-to-active grants, saved-grant callback
  failure, and successful per-card continuation. Grouped permissions retain
  the checks for policy-only completion, grant acknowledgement, and
  isolation between agents.
- Sidebar drag completion registers separate pointerup, pointercancel, and
  lostpointercapture handlers. Pointerup can commit the final coordinate.
  Sidebar closure and an unrelated second finger exercise separate paths.
  Project cache open, read, and write failures occur at independent
  boundaries. Cursor refresh and account/workspace isolation also remain
  covered. SSH host reset shares its mutation, while Direct, configured
  Cloudflare Access, bound Tailscale and a Tailscale host requiring rebind
  enter through different host-card conditions.

## Next review

Three confirmed deductions across 77 comparisons yielded 3.9%.
Reaching the gate from the remaining BDD-only queue would require 48.5%
of its rows. This pass found no source evidence for that yield.

Start with the 47 remaining browser response-deadline rows and 45
browser discovery/startup rows. Compare their shared readiness and
timeout transitions across the browser controller, response waiters and
visible retry paths. Check whether multiple tests prove the same
transition before reducing any cases. Preserve different recovery
actions and distinct expired or foreign-target effects. These counts
describe unreviewed executions, with no credited reduction. Sample and
rebuild work remains paused at the deletion gate.
