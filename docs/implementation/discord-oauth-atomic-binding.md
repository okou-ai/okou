# Discord OAuth atomic binding

PR #37968 replaces the new OAuth binding transaction with one schema-aware
Drizzle statement. This follows main's no-new-non-billing-transaction rule
introduced by #38288. It does not change the OAuth endpoints, proof protocol,
feature containment, or production activation boundary.

## Statement ownership

`commitDiscordOauthBinding$` owns the database handle and constructs these CTEs:

1. `claimed_discord_oauth` deletes and returns only the exact approved,
   unexpired attempt owned by the originating user and organization and matching
   its completion hash. Without this row, every dependent write is empty.
2. `installed_discord_guild` runs only for an install attempt. The guild-key
   upsert returns a new installation or the incumbent only when organization and
   bot match. Its no-op update preserves incumbent name, installer and timestamps.
   An occupied organization with a different guild hits the real organization
   unique key. The upsert's native row/index arbitration replaces the previous
   insert-plus-later-read; no additional coordination lock is introduced.
3. `connected_discord_guild` runs only for a connect attempt. It reads the exact
   current guild/org/bot and retains the existing parent `FOR SHARE` protection.
   It cannot create or revive an uninstalled guild.
4. `authorized_discord_guild` combines those mutually exclusive returned parent
   rows, rather than reading a sibling CTE's inserted data from a base-table
   snapshot. A rejected installation authorizes no identity or child write.
5. `claimed_discord_identity` performs the existing owner-qualified upsert over
   the global Discord-user key. It never transfers a different account's owner.
6. `committed_discord_connection` inserts the connection or returns its exact
   same-sender/same-owner incumbent. Its conflict target is the guild/sender key;
   a different sender already bound to this guild/user hits the other unique
   constraint and rolls the whole statement back.

The connection's user expression consumes the identity CTE's returned owner.
A rejected conditional upsert has no returned owner; the expression then retains
**the authenticated attempt's actual user ID**, not a fabricated owner or a
borrowed account. A new child with that rejected owner fails the existing owner
FK. This data dependency forces identity arbitration before the child even when
ownership is rejected, so failure cannot leave a new installation or identity
behind. It is fail-closed SQL input selection, not an authorization fallback.

All write sources use schema decoders and explicit aliases. Date parameters use
the owning timestamp encoders. The statement captures one application timestamp
for its expiry predicate and new rows; it adds no expiry grace or retry budget.
No raw-result generic, result assertion, new schema field, trigger, database
function, advisory lock, application mutex, or explicit transaction is added.

## Outcomes and publication

- An empty claimed result means an expired/consumed attempt and returns the
  existing invalid-attempt outcome.
- A claimed attempt without an authorized connection returns the existing
  conflict outcome. No rejected parent authorizes an identity write.
- Only `23505` for `uq_discord_org_installations_org` or
  `uq_discord_org_connections_guild_user`, and `23503` for
  `fk_discord_connection_identity_owner`, are converted into binding conflict.
  All unrelated failures propagate. After a constraint rollback, the existing
  exact owned-proof deletion preserves the non-replayable conflict outcome.
- A fresh proposed connection UUID is compared with the returned connection ID
  to identify the insert winner. Incumbent IDs and creation timestamps remain
  unchanged; no PostgreSQL system-column heuristic determines welcome delivery.
- The private command returns its settled statement outcome without discarding
  successful commit facts on a post-commit request cancellation. The entry point
  captures recipient facts from the statement, publishes the existing best-effort
  change notification, then checks cancellation. Welcome delivery remains
  independently authorized and runs only for the actual insert winner.

The new statement deliberately has one statement snapshot instead of the old
multi-statement READ COMMITTED sequence. Parent/connection upsert `RETURNING`
provides current incumbent outcomes after native unique-key arbitration; a
base-table snapshot is not used to rediscover an inserted or waited-on winner.
Admin recipients are captured in that statement's snapshot, and the private
notification still contains no binding content or credentials. Provider work
and realtime/welcome I/O remain outside the database operation.

## Public regression coverage

All scenarios use genuine start, provider callback, consent approval, completion
and status/disconnect APIs with only external Clerk/Discord dependencies mocked.
No business-row fixtures, private worker, test-only route or SQL pause point is
used.

The existing suite covers cross-org guild ownership, global identity theft,
same-owner concurrent convergence, one-use approval/completion, request
cancellation during provider verification, last-old-guild disconnect versus a
new-guild claim, uninstall revocation and independently authorized welcome.

Three additional cases protect the new constraint arbitration:

- `does not reserve a replacement Discord identity after an occupied-user binding fails`:
  another account can subsequently authorize that candidate sender in a different
  guild, while the original connection is unchanged and the failed proof is spent.
- `does not reserve the losing identity when two verified senders race for one workspace member`:
  one sender wins; another account can authorize the losing sender normally.
- `keeps one guild per workspace when two approved installations race without reserving the losing guild`:
  the organization unique key selects one guild; another organization can then
  install the losing guild normally.

This focused repair does not complete the whole PR's final review, restore
completed ZIP/download coverage, activate Discord/Gateway or establish live-guild
acceptance. Those claims remain separate.
