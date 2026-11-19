# Connector setup and Chat feedback screening

The draft was checked against main `fc507f128dd1`. There was no new
upstream commit when this batch started. The two previously recorded
upstream additions remain separate from the frozen baseline.

| Queue                                     | First reviews | Confirmed deductions | Explicitly pending | BDD-only rows in queue |
| ----------------------------------------- | ------------: | -------------------: | -----------------: | ---------------------: |
| Connector creation and account connection |           144 |                    0 |                  6 |                      0 |
| Chat feedback                             |           144 |                    2 |                  6 |                      0 |
| Chat edit or save                         |            10 |                    0 |                  0 |                    125 |

The [review ledger](test-rebuild-connector-chat-review.tsv) records
frozen IDs, registration sites, conditions, actions, observable outcomes,
and current source paths. The pass spans 240 frozen registration sites
for the two primary queues. In those queues, 138 rows received a
shared-path comparison, and 150 were mapped to current source with
provisional dispositions. Mapped rows still need a direct comparison
before they can count towards a deduction. The ten supplemental
edit/save rows received shared-path comparisons.

The [updated queue](test-rebuild-product-action-queue.tsv) records
the remaining BDD-only IDs. Across accumulated ledgers, 1,467 frozen
IDs have a review or source mapping, and 3,644 remain at initial BDD
screening. The [deduction ledger](test-rebuild-confirmed-deductions.tsv)
now records **29 confirmed net deductions out of 5,111 (0.57%)**.
The 1,534-execution gate is **1,505 away**. Sampling and rebuilding
remain pending.

## Connector setup across surfaces

- Composer's initiation can request agent authorization on a legacy
  feature branch and chat account selection on the scoped branch.
  Settings creates definitions and manages account naming, defaults
  and credential methods. Works uses provider-specific installation,
  identity and status refresh. Shared connection initiation does not
  cover those entry-specific outcomes.
- Feishu and Lark retain provider routing, identity and callback
  differences. Slack install and personal connect use separate
  actions. Discord's terminal response and rejected in-flight approval
  need a defensible shared donor before reducing the race cases.
- The no-auth cases remain pending for closer comparison across the
  three relevant entry surfaces. The transcript case protects absence
  of an extra dialog, while Composer protects its account/agent
  projection and Settings protects direct account activation.

## Chat feedback along shared paths

- The existing-thread and agent composers both use the same slash
  editor. Keep one entry for the existing whitespace before the suffix
  and one for the adjacent suffix that requires inserting a space.
  Preserve both entry points, keyboard handling, focus and visible
  text. This removes two cross-product executions. IME commits remain
  pending separately.
- Transcript duration units, final-result selection, status tail and
  visible work history differ in state and ownership. Sidebar or
  header actions may use a similar error notification, but archive,
  unarchive and optimistic pin leave different routes and visible
  state. Resource resolution and clipboard delivery also have
  different failure boundaries.
- Identical upload text does not imply identical recovery. The
  multipart transport cases preserve retry count and separate
  finalization. Assistant and user BMP rendering share a viewer
  after different signed-resource lookups.

## Next batch

Start with the 125 remaining Chat edit/save IDs. Six template rows
already preserve the explicit card-modal save versus the blur-driven
detail edit, including actionable failed states. Four automation rows
separate readonly/timing flows and late save races across the same
schedule editor instance and a different paused schedule. Continue
with draft persistence across new and existing chats, model preference
updates and stale mutation ownership. Reopen the low-yield connector
and feedback comparisons when there is an exact donor or new evidence.

The two primary queues yielded two deductions across 288 mapped or
reviewed rows. Most verified overlap is shared implementation coupled
with different visible outcomes. The 12 explicit pending rows in
these queues have no credited savings. Closing the whole 1,505 gap
from BDD-only rows would require roughly 41% of those rows to be
redundant, so this batch still provides no evidence-backed path to
the 30% gate.
