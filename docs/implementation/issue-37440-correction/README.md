# Correcting the #37440 transport-only test migration

Refs #37440. The issue remains open.

Baseline: `13753817e6507ac8b71315166dac807a87711c4c` (fresh main, 2026-10-07). This corrects #37791, #37795, #37803, #37807, #37817, #37821, #37841, #37842, #37843, #37844, #37846, #37847, #37897 and #37904. The pure unused endpoint removal in #37826 is preserved.

The earlier ten endpoint-migration PRs removed 21 HTTP operations and replaced them with 21 exported internal drivers in 14 files. Those are historical transport counts, not evidence that the scenarios meet the corrected public-construction rule. The retrospective remains unchanged: [original audit](https://github.com/okou-ai/okou/issues/37440#issuecomment-6039494119).

A public final response does not make private setup, internal worker execution, fabricated historical rows, fault injection or operator-only cron a public scenario. Follow the complete construction, driver and observation chain. Preserve publicly constructible subcases, signed integration callbacks and genuine authenticated Runner protocol; ordinary provider mocks and basic isolated database/app setup remain valid.

## Declaration decisions

Decisions were recorded before deletion. Parameterized declarations count once; branch changes are separate. The current comparison against integrated main `28c0ec43505f5032b005505d92c5e7c6d74d8a03` removes **523 whole declarations**. A parameterized declaration counts once. Separately, **7 unsupported parameter branches** are removed from **5 retained declarations** (3 banking/Pi/Stripe declarations and 2 terminal-state matrices). The branch lists below are not additional whole-case deletions.

The current-main A/B/C/root whole-declaration subtotals are 202/114/192/17; two usage-record declarations appear in both A and C, so their union is 523. Source AST inventory over the 71 changed test files goes from 1,848 declarations to 1,325; renamed declarations and changed describe wrappers are retained, not new cases. No new declaration is added to compensate for deleted coverage. Do not add these corrections to the historical 1,125-case reduction credit.

- [Accounting, memory and early mixed migrations](accounting-memory.md)
- [Google, artifact, Discord, Browser and workflow integrations](integrations.md)
- [Chat, sandbox, skills, compaction and email](chat-workers.md)
- [Remaining early declarations and documentation](construction-and-documentation.md)
- [Renamed or already-retired historical declarations](historical-successors.md)

Each inventory records the exact baseline declaration, decisive dependency, keep/rewrite/delete decision, lost behavior and support cleanup. Retained names do not assert that unrelated declarations in the same suite are compliant.

## Implementation boundary

Remove unsupported scenarios and their unused drivers, private selectors, fixture actions, routes, contracts and exports. Keep production worker entry points, normal global selection, locking, batching, accounting and caller-owned cancellation. Do not create replacement test interfaces, move private scenarios to another layer, or expand production APIs to rescue them.

Public portions retained include Stripe/onboarding lifecycles, Runner memory/storage and completion, Browser attach/profile behavior, automation create/disable/re-enable, thread pin/reorder, and ordinary message steer/completion. No retry, polling, sleep or timeout workaround is introduced. No local Vitest or development server is run; runtime checks belong to PR CI.

Final orphan closure also removes the last test-only automation selector, the remaining null-only sandbox cleanup selectors, unused pricing/usage fixture exports and old fixture actions. Independent review restored public deleted-run token rejection, signed Stripe deauthorization/filter health, Notion signed receipt/account-selection, usage-report authorization, Checkout abort/reuse, Morning Brief preference and cancelled-Runner heartbeat phases before finalizing the source. These are narrowed existing declarations, not new coverage credit.

## Main integration and attribution

The original correction at `c5779e5b4bceb77dd8b23daf907fa0b2d5a2882c` removed 529 whole declarations against baseline `13753817e6507ac8b71315166dac807a87711c4c`. A normal merge of main `1a4cbda1d901006994149202b74d5135d8b74f6d` resolved actual conflicts with #37905's Pi stable-context retirement. Two of the original 529 declarations were already deleted by that main change: the cron-sync stable-context-demand transaction and captured-gzip stable-context construction. The merge additionally removed one unsupported ready-index-reuse declaration, the remaining consumer of the already-affected private Pi index fixture. That checkpoint's main-relative net deletion was 529−2+1=528, across 72 test files (1,853→1,325 declarations).

#37905 independently removed two more snapshot declarations that were not counted in the original 529; those product-retirement deletions are not attributed to this correction. The baseline-relative decisions below remain historical records. Conflict resolution keeps main's retired schema/services deleted, keeps the production publication fence/index cron, and preserves this PR's global-only worker paths. It does not restore old fixture control paths or alter database migrations.

The subsequent normal merge of main `28c0ec43505f5032b005505d92c5e7c6d74d8a03` incorporates #37896's per-case database isolation. That main PR independently deleted the five `pi-memory-maintenance.boundary.test.ts` declarations already covered by the original correction. Deduct those once: 529−2+1−5=523. Main also renamed two unsupported declarations and moved five Official email declarations into nested describe groups; those are existing cases, not additional removals. Their current names and parameter branches are recorded in [historical successors](historical-successors.md). The seven branch removals in retained declarations are unchanged. The unified test infrastructure and per-case database selection remain intact; isolation does not make private worker or fabricated-state scenarios public.
