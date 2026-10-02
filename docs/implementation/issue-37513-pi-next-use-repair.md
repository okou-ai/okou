# Pi next-use and instruction writer repair

Base: `5b7e380fbfdad5f283e1f9c7d1075b91657aa828`. No earlier worker commits are replayed.

## Source writer

- Removed `commitPreparedAgentInstructionsStorageInTransaction({ tx, ... })`.
  The instruction route has a stable prepared-publication command with only
  reservation/member/volume facts and a final signal. Its SQL transaction owns
  current Agent authority and Storage identity checks, exact-token admission,
  immutable version/HEAD/index publication, token consumption and readiness.
- Existing Agent/Storage row protection is retained inline, not added or passed
  into a helper. Permission/name/Storage/fence misses still deny before source
  publication. Archive/index preparation and uploads remain outside SQL.
- The same existing `preparedVolumePublicationSql` is executed by the bootstrap
  writer. A zero-row immutable publication rejects the version identity rather
  than silently succeeding. Preparation always requests its resource index.
- The fenced writer does not rebind missing captured inputs: reservation cleared
  them, and pending scopes cannot register new demand. Canonical next use
  recaptures the committed source. Exact-token completion stays in the same
  transaction as HEAD publication; independent keys determine readiness.
- Agent timestamp update and response projection now use UPDATE RETURNING with
  a typed scalar org-default lookup; the protected Agent is not queried twice.

Bootstrap's wider `publishBootstrap`/reservation helper graph and the preflight
canonical-Storage resolver still have existing DB/Tx signatures outside this
focused repair. This increment does not claim whole-PR terminal conformance.

## CI evidence and retained cases

Parent supplied API7 job `110693081233` from run `36960535767`; it was read without
rerunning. The 23514 comes from the test's direct expired-lease UPDATE after
invalidation cleared its input. The rollback/fence and coalescing failures
expect old eager pending demand; deletion waits for a worker despite no demand.

Four cases are adjusted, not deleted:

1. Rollback and old-token denial/new-token completion stay asserted. A subsequent
   ordinary use repairs the cold variant, and the exact new source generations
   and a valid ready artifact remain checked.
2. Concurrent first-use coalescing remains checked. After invalidation, next use
   repairs the updated prompt; zero duplicate background builds and ready reuse
   are the new, exact expectations.
3. Expired and exhausted lease outcomes are unchanged. Real next-use registration
   restores valid input before arranging the existing expired-running fixture.
4. User-deletion fencing retains its existing claimed-build barrier and no-
   artifact-after-deletion assertion. The unbuilt cache fixture is arranged from
   a real current-generation next-use input, not from NULL input.

No schema check, timeout, production hook, retry or authority/fence assertion is
weakened. These are still internal integration scenarios; they do not replace
public authority/HEAD-concurrency coverage. The existing public instruction
cases remain required. The missing `be997ad` mixed-scope public API test alone
is included, preserving peer personal overrides and organization precedence.

One earlier parent CI snapshot was inspected: API1 failed in execution/pick CTEs
with empty RETURNING clauses, outside this scope. No execution writer is edited.

## Verification boundary

Affected Prettier, ESLint, normal API-cwd Oxlint and diff checks pass. No local
Vitest/dev server, full types or whole-API type-aware check is run. One initial
commit hook automatically ran Knip and found the now-unreferenced
`commitPreparedVolumeServerSide`; that dead adapter was removed. Final local
hook type/Knip jobs are explicitly delegated to the concurrent parent, while
format/style/file-size/commitlint hooks pass. Parent owns heavy verification and
behavioral CI. This handoff does not claim the four CI failures resolved until
CI confirms the changed scenarios.
