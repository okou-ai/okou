# Atomic Discord OAuth binding and revocation

PR #37968 follows the API rule introduced by #38288: the new Discord operations execute one SQL statement inside their owning ccstate command, with no explicit non-billing transaction. OAuth endpoints, opener/consent-browser proofs, current membership checks, one guild per organization, user-isolated sessions and default-off activation remain unchanged.

## Business authorization records, not coordination state

Personal authorization and a shared bot installation have different owners and lifetimes. The authenticated start creates the real personal OAuth attempt; an install start also creates organization-owned installation consent with that same originating attempt ID. It contains the requesting organization, initiator, actual requested guild, expiry and later independently verified guild/bot evidence. It contains no personal Discord sender, capability hash, provider code or provider OAuth token.

The callback writes verified personal and installation evidence in one statement. It still creates no installation or connection. Consent-browser approval remains independent of the opener. The original opener's final completion freshly revalidates membership and provider evidence.

A completed personal consent retains its actual approved evidence, but its completion hash is set to NULL. Equality against a supplied hash cannot match it; callback and approval phase guards also reject reuse. Its original TTL is not extended. Expired-attempt cleanup selects only unconsumed capabilities; it never expires an active personal authorization or an approved shared installation consent. These authorization records are also exported as owner-scoped `personal-consents` and `installation-consents`, without capabilities.

These are persistent authorization/provenance records, not generic lock rows, epochs, sentinels, retry counters or artificial coordination fields. The new nullable lineage columns name actual authorizations; existing verified records are not assigned fabricated OAuth evidence.

## Atomic binding

`commitDiscordOauthBinding$` owns one schema-aware Drizzle statement:

1. `claimed_discord_oauth` burns exactly the approved, unexpired originating user's completion hash. An empty claim permits no dependent binding write.
2. Installation consent must match the originating ID, organization, initiator and freshly verified guild/bot. Install upserts accept an incumbent only for the same organization/bot. Connect reads the exact existing parent under the previously established parent-share protection; it cannot recreate an uninstalled guild.
3. Only a returned new installation activates its organization consent. Its original `created_at` and the consent's actual approval timestamp use the same captured application time. A repeated installation preserves its original grant, installer, name and timestamps. Immediate PostgreSQL RI checks run at statement end and observe the dependent consent update; the permanent schema validator executes this exact child-before-final-approval pattern on PostgreSQL.
4. `committed_discord_connection` references the exact personal consent's ID, user, independently verified Discord sender and guild. An idempotent same-owner upsert preserves connection ID/creation time while recording the newly completed genuine consent.
5. Native uniqueness arbitrates guild/org and guild/user conflicts. The global ownership exclusion constraint below arbitrates sender ownership, including concurrent writes not visible to an ordinary SELECT's statement snapshot.

Only exact `23505` failures for the two expected business keys and `23P01` for `ex_discord_connections_global_sender_owner` become binding conflicts. Unrelated failures propagate. Constraint rejection rolls back every CTE write; exact owned-proof deletion then preserves the existing non-replayable conflict outcome. Empty authorization still grants no access.

The proposed fresh connection UUID versus returned connection ID identifies the actual insert winner. No system-column heuristic is used. Returned successful facts publish before post-commit cancellation is observed; only the actual insert winner attempts an independently authorized, best-effort welcome.

## Global ownership and release

The canonical PostgreSQL contract is:

```sql
EXCLUDE USING gist (discord_user_id WITH =, user_id WITH <>)
```

`btree_gist` enforces that an active Discord sender can have many guild connections for the same Okou user, but cannot belong to different Okou users. Existing guild/sender and guild/user unique constraints still apply. This is native business-key arbitration, not an application lock or retry protocol.

There is no separately committed identity reservation to squat on a sender. Deleting the last actual connection releases the exclusion-index entry in that same write. A same-owner connection in another guild retains its own entry and is not deleted by an identity-parent cascade. Failed or losing bindings reserve neither an identity nor a guild. The previous standalone identity table and its antijoin/parent-lock cleanup are replaced by this equivalent active-ownership invariant, not by omitting release.

## Six atomic revocations

| Operation             | One-statement work                                                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binding disconnect    | Cancel still-unconsumed attempts for the captured user/org; delete only the exact connection/sender/user/guild. Consumed audit records are not pending attempts and cannot cause another replacement sender to be deleted. |
| Workspace uninstall   | Revoke personal authorizations, revoke organization installation consent, and delete genuinely historical parents lacking OAuth lineage.                                                                                   |
| Gateway guild removal | Claim the exact replay receipt and perform the same guild-scoped revocation. Every revocation is gated by the new receipt; a duplicate does no deletion. A failure cannot commit a receipt without its cleanup.            |
| Member removal        | Revoke that user's personal authorizations in that organization; remove only historical unlineaged personal connections. Shared installation consent survives.                                                             |
| Organization erasure  | Revoke personal authorizations and organization-owned installation consent in that organization, plus historical parents.                                                                                                  |
| Account erasure       | Revoke all personal authorizations, anonymize the user's installation-consent initiator, remove historical personal connections and clear historical installer metadata. Shared installations and peers survive.           |

The personal-grant FK cascades only its exact owner/sender/guild connection. The organization-grant FK cascades only its installed guild. Updating an erased initiator to NULL cascades to the installation's installer field, not to the guild's existence. PostgreSQL RI actions handle children committed while a matching authorization-row deletion/update waited; ordinary sibling-CTE antijoins are not used as a substitute for fresh-after-lock visibility. Dependent CTE cardinality expressions preserve the established personal-authorization → shared-authorization ordering without new locks.

Direct deletes/updates cover only historical NULL-lineage rows, which are disjoint from the new authorization cascades. Every new production binding supplies genuine lineage. Existing verified rows remain usable under the same native global-ownership constraint; no historical grant is invented. This supported historical state is not an expiring rollout bridge.

Removal acknowledgments and scoped recipients come from real returned authorization/parent facts. Recipient branches use `UNION ALL`, not a grants × members × administrators Cartesian product. Raw projected booleans have an explicit PostgreSQL boolean cast and runtime decoder; user IDs have a nullable text decoder. The pure recipient helper executes no query. Publication remains post-commit and best-effort, not durable delivery.

## Migration and verification boundaries

Drizzle generated migration 1358 and its snapshot/journal. Shipped main history and PR migration 1357 remain unchanged. Its fail-closed historical ownership backfill still rejects ambiguous existing senders; the new exclusion constraint independently validates active ownership. The generated SQL required demonstrated dependency-order corrections: remove the old FK before dropping its table, and install the personal-grant unique key before referencing it. New existing-table FKs use separate NOT VALID/VALIDATE statements. The exclusion contract is checked in independently because Drizzle does not model it, and is applied to the freshly generated schema as well as historical replay. Application-defined trigger/function inventories remain empty.

PGlite loads its actual supported `btree_gist` extension rather than ignoring the new invariant. User regressions remain genuine public OAuth/start/callback/approval/completion/status/disconnect flows with external Clerk/Discord mocks only. The existing four-iteration same-owner new-guild/last-old-guild disconnect case remains intact. A new public case proves that reaping expired opener capabilities does not revoke a completed binding, and that last disconnect releases its sender for another legitimate member even while a historical consent receipt remains.

The permanent PostgreSQL validator is physical schema verification, not public-user lifecycle evidence. It checks provenance rejection, dependent statement-end RI, exact installer anonymization, peer preservation and scoped cascades against both replayed and freshly generated schemas.

The export regression independently observes owner-only attempts and consumed personal-consent documents at the external S3 boundary. It does not complete the ZIP/download lifecycle. No operator cron, private worker driver, private binding constructor or enlarged work budget closes that remaining archive-coverage gap. Review, CI, protected merge, deployment and live Discord acceptance remain separate receipts; this implementation activates none of them.
