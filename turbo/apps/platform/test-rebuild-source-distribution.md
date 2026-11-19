# App test source distribution and module review

The [file distribution](test-rebuild-file-distribution.tsv) ranks all 485
frozen files by registered execution rows. The
[source candidate index](test-rebuild-source-candidate-index.tsv) links
each flagged declaration to its source line and frozen IDs. The grouping
key is the file and registration line recorded by Vitest, so expanded
rows with one test body remain visible.

Across 5,111 executions there are 3,914 registration sites. Of those,
698 sites expand into 1,895 rows. The 1,197 rows above one per matrix
describe the size of the parameter space. Even collapsing every matrix
to one row would fall short of the 1,534-row target by itself, and much
of that parameter space protects distinct behavior.

The source signals overlap. They flag 137 execution rows with potential
internal assertions or static checks, 1,534 with a mock operation used
by multiple declarations in the same file, 1,018 that reference a
contract with a matching API test filename, and 107 whose names mention
retirement or compatibility. These are search leads. Inspect the
actual operation, public outcome and current route before treating a
match as redundancy. Two executions belong to declarations that were
too long for the source signal scanner. The distribution separates
98 rows with a recorded direct disposition, 585 with source-assisted
notes or behavior mapping, and 4,428 awaiting that level of review.

## Browser interaction and remote setup

[Module review](test-rebuild-browser-remote-review.tsv) covers all 306
executions across both files, including 12 recorded decisions from the
previous batch. The new source-assisted review covers 294 executions
from 206 declarations. Its provisional dispositions are 265 retain
and 29 requiring a deeper comparison. No new rows are confirmed for
deduction in these modules.

Selected direct checks illustrate the safeguards:

- Clean and abnormal socket closure share recovery setup, while the
  externally recorded close code and clean flag differ. Preserve both
  until the telemetry scope is decided.
- The background lookup case passes unavailableTargets through the viewer
  fixture and asserts that the selected tab remains usable while the
  unavailable target is excluded. Its behavior depends on shared setup.
- The guided editor really switches from a typed SSH username to the VNC
  login method. The VNC heading and absence of the old field protect the
  user-facing protocol switch.
- VNC conflict and server failures have different user-facing messages;
  the network-sharing conflict, permission loss and uncertain save also
  have distinct outcomes. Common test bodies do not make these equivalent.

## Accounting and next batch

Confirmed frozen net reduction stays at 12 of 5,111. The
[main reconciliation](test-rebuild-upstream-d36b9aec.md) records one
changed Platform suite and eight fewer executions upstream. Those eight
have not been credited to the frozen count. The two prior upstream
additions remain separate.

Verify possible donors in the workflow pruning change, starting with
the merged Official Workflow and Gmail summary cases. Then inspect
the largest untouched browser recovery matrix and the repeated
chat model failure routes. Use the declaration index to skip prior
decisions and compare the route, actor, event ordering and expected
visible state for each proposed merge.
