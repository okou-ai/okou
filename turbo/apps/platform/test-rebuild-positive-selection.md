# App test rebuild positive selection

The frozen baseline is `b0a10287edf42`. All 485 original files and all
5,111 executable IDs are accounted for, including every parameter example.

| Measure                            | Executions |
| ---------------------------------- | ---------: |
| Frozen baseline                    |      5,111 |
| Sum of each file's rounded-up half |      2,683 |
| Selected for rebuild               |      2,681 |
| Frozen executions left unselected  |      2,430 |
| Required projected net reduction   |      1,534 |
| Margin above the gate              |        896 |

The frozen selection projects a **47.54%** net reduction. The count gives
each selected stable ID one planned execution. Update that projection if
coverage review or actual implementation requires a different number of
executions. The 30% gate is satisfied by the frozen selection. Verify
executable totals again after implementation.

- [File selections](test-rebuild-positive-file-selection.tsv) record the
  original count, target, retained IDs in priority order, and exceptions.
- [Stable-ID dispositions](test-rebuild-positive-scenario-selection.tsv)
  cover the complete frozen baseline. Each execution is retained or
  unselected. Unselected rows need no equivalent donor under this policy.
- [Prior source evidence](test-rebuild-confirmed-deductions.tsv) remains
  available. The prior 64 verified deductions are already included among
  the unselected executions, with no additional credit.

## How the selection was made

Each frozen Given, When and Then was read by a batch ranking pass. The pass
prioritized product actions with visible results, then favored distinct
actions and important boundaries within each file. It down-ranked
implementation-only results, retired paths, negative-only assertions and
similar parameter examples. Earlier confirmed exclusions were kept out of
the candidate pool. The ranking is a BDD-based assessment, supplemented
by focused inspection of core or ambiguous cases. It is not a source
audit or execution of every retained scenario.

Targeted review preserved core sign-in, onboarding, automation, sharing
and email opt-out flows, and checked independent boundaries for consent,
owner changes, secret handling, browser recovery and uncertain writes.
For browser deadlines and discovery, selections prioritize ready input,
visible recovery, confirmed empty windows, foreign-window exclusion and
no replay of uncertain writes. Ordering permutations remain lower
priority unless they establish an independently valuable outcome.

Four files exceed their rounded-half target by one execution each.
The recorded reasons cover the preview API/WWW credential boundary, an
unsubscribe request without a token, malformed grouped-permission review,
and failure to continue after a grant was saved. Source checks include
the preview destination allowlist, the unsubscribe route's early token
validation and the permission flow's grant-before-callback contract.
Two files fall below target because of prior test-harness exclusions.
The MSW harness file has no eligible rows, and the API bootstrap file
retains its public response behavior.

## Upstream and next work

Eight previously inventoried upstream additions stay outside the frozen
selection. The Draft includes main through `03698f76`. Main advanced to
`eaae30ac`. Its [test-file queue](test-rebuild-upstream-eaae30ac-paths.tsv)
lists 39 modified, four deleted and two added Platform test files, with
frozen and selected counts where those files intersect this baseline.
A dry merge found 39 modify/delete conflicts. New and changed execution
totals for this range remain pending source reconciliation. This snapshot
does not add them to the frozen tally or alter the existing Draft test
implementations.

Reconcile the upstream queue against the selected stable IDs, starting
with the connector account rollout and permission changes. Capture new
behavior and retired or moved entry points before resolving conflicts.
Then use the selected scenarios and repository Testing guidance for the
representative sample. Keep the Draft open at this stage.
