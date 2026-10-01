# Usage maintenance preparation and compaction Cron pause (PR1)

PR1 of [#37480](https://github.com/okou-ai/okou/issues/37480), tracked by [#37503](https://github.com/okou-ai/okou/issues/37503). **Preparation only: no native activation or global-key retirement.** PR2 [#37484](https://github.com/okou-ai/okou/issues/37484) must wait for this PR's verified production release, not merely its merge.

## Preserved behavior

The existing `usage_event_compaction` transaction advisory key, shared/exclusive modes and order are unchanged. Ordinary/managed settlement and Social still enter before credit; Social still locks its job before credit. Agent/threadless deletion enters before Run/FK locks. User/org cleanup, authenticated compaction and explicit backfill retain exclusive legacy admission. Complete-grain raw/hourly mutation, quantities, charged credits, allowance windows, FEFO, time anchors, final receipts and bigint overflow rollback are unchanged.

The existing entrances are consolidated into `acquire_usage_event_legacy(lock_key, shared_mode)`, not another advisory domain or runtime acquisition. API callers preserve their test-isolated key namespace. The operator and installed `purge_quiescent_provisional_billing_attribution` retain the same key and exact quiescent-owner contract. The historical migration is immutable; a forward migration replaces the installed body.

Only `/api/cron/compact-usage-events` is removed from `vercel.json`. All other schedules, including usage settlement, and the authenticated compaction route remain. A configuration diff is not a live pause, an in-flight drain or authorization for manual production compaction.

## Why native acquisition is staged, not active in PR1

The isolated native-row study omitted the whole debit wrapper. Real concurrent settlement exposed a **40P01 deadlock**: one transaction owned `credit_<org>` and attempted the metadata existence check's `FOR UPDATE`; another owned the proposed early `KEY SHARE` and waited for that credit key. The original SQL-only assertions were not full API proof.

PR1 fixes that prerequisite: `writeOrgMetadataWithDefaultPlanEntitlement` uses **NO KEY UPDATE** for its existence check. This still excludes deletion, key changes and competing writers, preserves INSERT-only entitlement behavior and allows later KEY SHARE coordination. The same real API rollback/concurrent-retry test is retained, not weakened.

Old pre-preparation APIs still use FOR UPDATE, so eagerly adding KEY SHARE during their mixed rollout would remain unsafe even after fixing new code. Instead every prepared caller acquires legacy admission **first**, then separately calls `acquire_usage_event_maintenance(org, exclusive_mode)`. Its PR1 body validates scope but deliberately acquires no native lock. No rollout flag, fabricated metadata/grant or extra lock table is introduced. Preparation adds a staged-entry round trip; it is not a measured optimization.

## PR2 activation contract

1. Verify PR1's installed functions, prepared API/operator/callable-function serving floor and compatible rollback floor. Drain all pre-preparation requests/scripts; stopping Cron alone is insufficient.
2. PR2's activation migration first invokes the **existing** `acquire_usage_event_legacy('usage_event_compaction', false)` and holds that transaction-scoped exclusive barrier. It drains in-flight prepared transactions that already passed the inactive entry and prevents another from passing it.
3. While holding that barrier, replace the staged maintenance body with the fully reviewed native organization protocol. Commit before promoting native-only API code. Prepared API/operator callers queued at legacy admission invoke the native function in a **separate subsequent statement**, so they resolve its active body after the barrier; do not combine admission and native-body lookup or reverse their order.
4. Retain the legacy SQL boundary while prepared writers/rollback targets still need it. Its later retirement requires those callers to drain. Never roll back below the preparation floor after activation.
5. Native owner/rare relation scope, metadata key-changing/nonparticipant writers, absent-owner escalation, Social/Run/reader ordering and matched costs still require PR2 validation. The entrypoint alone does not prove that replacement or permit activation.

## Release and recovery gates

Production migration must complete before the prepared API or `--migrate` operator tool uses these functions. Old API after the additive migration remains legal and enters the same legacy key. Do not silently fall back on an absent preparation function or claim a failed release satisfies this gate.

Before any authorized PR1 pause release, PR2 must be sufficiently ready to bound backlog and define recovery. Verify the actual paused deployment and all in-flight compaction calls; record explicit backlog/read-cost thresholds and an owner-approved rollback/recovery action, rather than assuming a safe pause duration. This PR does not determine or authorize that live window.

PR2 merges only after PR1's production receipt and request drain. PR3 restores Cron only after PR2's verified release and financial/concurrency gates. [#36957](https://github.com/okou-ai/okou/issues/36957) finite physical work, [#36956](https://github.com/okou-ai/okou/issues/36956) settlement compatibility and [#36958](https://github.com/okou-ai/okou/issues/36958) activation remain separate gates. No production SQL/EXPLAIN/BUFFERS, backfill, merge or deployment is authorized by preparing this PR.
