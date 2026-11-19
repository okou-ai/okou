# Main test inventory through 4bf10b89

Compared main `03698f76` and `4bf10b89`. The earlier `eaae30ac` queue
covers 45 files. For you artwork adds two modified files to that range.
The [scenario ledger](test-rebuild-upstream-eaae30ac-scenarios.tsv) covers
47 files, with 580 prior and 529 current statically expanded registrations.
It records 324 unchanged registrations, 179 modified, 26 new, and 77 no
longer registered in this comparison. Compare these numbers with Vitest
during rebuild. The counts measure this upstream range and do not affect
the frozen denominator.

The [BDD supplement](test-rebuild-upstream-eaae30ac.bdd.md) captures
modified and newly declared cases. It links directly to the authoritative
upstream test registration. Higher-level descriptions for mechanically
summarized rows may need refinement when that file is rebuilt.
Of 26 new executions, 17 were selected by the rounded-half-per-file
policy and nine were left unselected. The existing eight upstream
additions remain in their earlier supplements.

The connector rollout removes the old per-agent access configuration
entry, replaces the directed authorization page with the current
directed connect flow and removes rollout-only permutations. Preserve
saved-account identity, current reconnect feedback and callback order
through the live entry. For grouped permissions, retain the actual
saved-grant/continuation failure path even though its old switch fixture
disappeared. Standalone and chat forms still have distinct user entry
points.

Exact original IDs are retained when the declaration and fixture
expansion map reliably. Rows marked for review correspond to a changed
parameter registration or a removed selected entry with no direct
mapping. Resolve those cases against the current source before that
file is rebuilt. Registration-unchanged rows can still depend on
changed test fixtures; check their owning test setup during rebuild.

The sync preserves upstream product code. Test implementations are
available in the recorded source revision. Files in the rebuild
scope stay clear of legacy implementations until recreated.
