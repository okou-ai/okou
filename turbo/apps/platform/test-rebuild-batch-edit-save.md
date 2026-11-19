# Chat editing and save screening

The draft incorporated main `9c5688a904a2` through sync commits
`424ab6dc` and `692b732e`. The Platform test-side change from #48920
opens the applicable Create tile directly instead of selecting
Presentation and changing the task during setup. Its 15 affected
frozen IDs are recorded in the [upstream ledger](test-rebuild-upstream-b74b4554.tsv).
The explicit cross-task assertions remain covered. The changed
test implementation stays cleared on the draft. Upstream adds or
removes no Platform executions in this interval. The two earlier
upstream additions remain separate.

| Queue                         | First reviews | Rechecks | Confirmed deductions |
| ----------------------------- | ------------: | -------: | -------------------: |
| Chat edit and save            |           125 |        0 |                    2 |
| Connector and Chat pending    |             0 |       12 |                    1 |
| Other failure and retry paths |            27 |        1 |                    4 |

The [review ledger](test-rebuild-edit-save-review.tsv) records stable
IDs, frozen registration, preconditions, actions, outcomes, current
source and donors. The Chat edit/save pass has 41 shared-path
comparisons and 84 source-path mappings with provisional retention.
The last two rows of the table are direct comparisons. The
[deduction ledger](test-rebuild-confirmed-deductions.tsv) now records
**36 confirmed net deductions out of 5,111 (0.70%)**. The 1,534-row
gate is **1,498 away**. There are 1,619 unique frozen IDs with a review
or source mapping and 3,492 still at BDD-only screening. Sampling and
rebuilding stay pending.

## Decisions

- Both composer routes serialize draft content through the same
  payload builder. The agent and thread routes still use separate
  draft loading, persistence and lifetime boundaries. A blank initial
  draft, clearing previously saved content, and retaining attachments
  when text becomes blank protect distinct outcomes. A delayed server
  draft must not overwrite a newer local edit.
- Model routing preserves separate cases for absent preference,
  unsupported saved route, catalog-specific maxima, provider/account
  changes, per-model effort and an explicit thread update before
  the server confirms it. Matching labels do not establish equivalence
  of the underlying catalog rules.
- Late mail, capability and Chart responses are scoped to their
  initiating editor or revision. A matching final setting value
  after an A-to-B-to-A change does not establish an unchanged draft.
- The 10,000 code-unit paste can use the emoji case, which checks the
  same inline edit and proves UTF-16 counting. Keep the beyond-limit
  file scenarios because exact whitespace bytes and surrogate-pair
  handling are independent. Pin reorder retains the stronger
  nonempty-draft case, with the same shortcut target, focus and route.
- The 12 explicit pending IDs from the prior batch are now decided.
  One before-suffix IME variant consolidates into its same-decoration
  donor. Keep distinct provider rows and signed-resource types, the
  separate no-auth connector entries, preview hostname rewriting, and
  accepted versus rejected late Discord approval responses.
- The Slack onboarding action does not retain the popup handle. The
  blocked-tab donor preserves the retry and unearned-progress
  assertions from both extra window lifetime fixtures. Slack settings
  uses verified account state instead of callback markers. The
  forged-success donor preserves the Install affordance and absence of
  automatic launch for both extra marker variants.

## Feasibility and next batch

At the start, filling the 1,505 gap using the 3,644 BDD-only IDs
would have required a 41.3% hit rate. The new 1,498 gap is about
42.9% of the 3,492 remaining BDD-only IDs. These are required
fractions if all further deductions came from that queue. This
batch recorded seven deductions across 81 direct or shared-path
comparisons (8.6%), including four in the 27 new retry/failure rows.
The primary edit/save queue yielded two deductions across 125
reviewed or mapped rows (1.6%). These targeted rates do not estimate
the rest of the inventory, and the current evidence does not support
reaching 30%.

The [remaining queue](test-rebuild-product-action-queue.tsv) still
contains shared-entry matrices worth checking. Start with hosted-site
Share during permission refresh (four executions), annotation IME
handling across key sequences (four), and refresh after saving paid
tools preferences (three). They have identifiable shared entry code
and a common assertion within each family. Preserve surface promotion,
Safari final-key behavior and field-specific writes where the evidence
shows independent outcomes. The 11 rows are leads, with zero confirmed
savings so far. Broaden from these by actual action and response
semantics. Keep completed low-yield families closed absent new donor
evidence.
