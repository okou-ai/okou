# Home task recommendations

Personalized task cards on the agent home page. The member sees up to three
tasks derived from their own recent assistant activity and the connectors they
have connected; clicking one starts a new chat thread whose first message is
that task.

Gated by `FeatureSwitchKey.HomeTaskRecommendations`, off by default.

## Pipeline

One generation is two provider calls with different jobs.

1. **Rank.** `HOME_TASK_RANKING_MODEL` receives the collected evidence as one
   JSON document and returns ranked intents, each with an `actionability` score
   from 0 to 100 describing how ready the task is to start without a
   clarifying question first.
2. **Write.** `FAST_PATH_MODEL` receives only the intents that cleared
   `HOME_TASK_RECOMMENDATION_MIN_ACTIONABILITY`, and turns each into one card —
   title, click prompt, and rationale — in the member's own language.

The split is the point. Ranking decides whether a task is worth interrupting
the member with, which is a judgement about their evidence; writing only
renders a decision that already exists. The writer never sets its own card's
score or connector list: both stay owned by the ranking stage, so a card cannot
promote itself or claim a connector the member has not connected.

If nothing clears the threshold, the writer is never called and the member
sees no cards. That is a correct outcome, not a failure.

## Evidence

Collected in `home-task-recommendation-evidence.service.ts`, from first-party
data only:

- The member's most recent chat threads, with their titles and a bounded
  excerpt of the member's own prompts. Assistant output does not travel: it
  mostly restates the request at far greater length, and feeding generated text
  back into a generation input adds no evidence.
- The connector inventory for this member in this workspace — slug, and whether
  the connection is currently usable.

The inventory is capability, never content. A card may say the assistant can
reach Gmail; it must not claim to know what is in the mailbox. Reading actual
provider content would need the same per-source authorization a Morning Brief
occurrence carries (see [Morning Brief composition](./morning-brief-composition.md)),
which this feature does not have and must not fabricate.

Everything collected travels inside one JSON field the instructions name as
untrusted. A recent chat message is data; it can never become an instruction,
request a tool, or add a source.

## Refresh

`home_task_recommendations` holds one row per (user, org). `next_refresh_at` is
the only refresh authority and `HOME_TASK_RECOMMENDATION_REFRESH_MS` is the
window both sides read — the client polls on it and the server refuses to
regenerate inside it.

- A request inside the window serves the cached cards and pays nothing.
- A request outside it competes for the row's claim. The winner generates; the
  loser serves the cached cards rather than waiting, so a refresh never makes
  the home page slow or blank.
- A generation whose evidence digest matches the stored one keeps the cached
  cards and moves the window forward without calling a provider.
- A failed attempt releases the claim onto a cooldown and the previous cards
  stay. The API never reports the failure to the member: a home page with the
  previous suggestions, or with none, is always a correct answer.

## Files

| File                                                                         | Role                                            |
| ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `packages/api-contracts/src/contracts/home-task-recommendations.ts`          | Response contract, limit, threshold, cadence    |
| `apps/api/src/signals/services/home-task-recommendation-evidence.service.ts` | First-party evidence collection and its digest  |
| `apps/api/src/signals/services/home-task-recommendation-shape.service.ts`    | Untrusted model output to contract values       |
| `apps/api/src/signals/services/home-task-recommendations.service.ts`         | Claim, cache, and the two-stage generation      |
| `apps/api/src/signals/routes/home-task-recommendations.ts`                   | `GET /api/home-task-recommendations`            |
| `apps/platform/src/signals/okou-page/home-task-recommendations.ts`           | Poll, feature gate, and the click-to-thread act |
| `apps/platform/src/views/okou-page/home-task-recommendations.tsx`            | The card row on the agent home page             |
