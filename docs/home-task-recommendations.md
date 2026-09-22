# Home task recommendations

Personalized task cards on one Agent's home page. The member sees up to three
important next actions derived only from Gmail content that Agent may read and
visible threads owned by that Agent. Each card states whether it starts a new
chat or continues an existing thread.

Clicking a card navigates to the corresponding composer and prefills the draft.
It never sends the message.

Gated by `FeatureSwitchKey.HomeTaskRecommendations`, off by default.

## Pipeline

One refresh has three deliberately separate decisions.

1. **Extract.** `FAST_PATH_MODEL` proposes evidence-linked candidate tasks. It
   must cite exact opaque source refs and may propose an existing thread only by
   its opaque ref. The model never receives a real thread ID.
2. **Decide.** The fixed OpenRouter model `typesafe/jev-1.13` evaluates every
   candidate with structured `Score` and `Noul` questions: actionability,
   grounding, and whether the proposed new/existing-thread destination is
   correct. Code derives confidence from the probability mass on accepted
   actionability levels plus the two `Noul` probabilities. Candidates must pass
   both `HOME_TASK_RECOMMENDATION_MIN_ACTIONABILITY` and the Jev confidence
   gate.
3. **Write.** `FAST_PATH_MODEL` receives only accepted intents and writes the
   localized title, composer draft, and rationale.

The split is the boundary. The extraction model cannot approve its own task;
Jev cannot generate free text; the writer cannot change score, connector list,
or destination. Existing thread refs are resolved to IDs locally before Jev and
never authored by a provider.

If nothing clears the gates, the writer is not called and the member sees no
cards. That is a correct outcome, not a failure.

## Evidence and authorization

The source allowlist is intentionally narrow:

- Up to 40 recent threads for the requested Agent, restricted to the current
  user and organization. Only recent visible `input.prompt` and
  `output.message` excerpts are collected; hidden, revoked, thinking, control,
  and other event types do not travel.
- A bounded recent Gmail inbox window, including sender, subject, snippet,
  timestamp, and unread/important labels.

Gmail is read only when all of these are true for the exact user, organization,
and Agent:

1. Gmail is enabled in that Agent's `user_connectors` scope.
2. The selected default Gmail account belongs to the user and is usable.
3. The accepted connector catalog and the Agent's live permission grants return
   an unambiguous `allow` for the exact Gmail list/detail URLs.
4. The Agent scope and selected account are unchanged when collected content is
   released.

Only after the first URL authorization succeeds may the credential be loaded
or refreshed. `deny`, `ask`, no route, ambiguous route, expired permission,
reconnect state, provider failure, or source timeout all fail closed. Gmail is
optional evidence: its failure removes Gmail from that refresh while the
Agent's thread evidence can still be used.

Every provider input marks source material as untrusted data. A chat message or
email snippet cannot become an instruction, request a tool, or add a source.

## Refresh and isolation

`home_task_recommendations` holds one row per `(user, org, agent)`. Switching
Agents therefore changes evidence, cache identity, and cards. Generation never
runs in a browser request and there is no browser timer or polling loop.

- `GET /api/home-task-recommendations` records `last_requested_at` and returns
  the current cache only. This bounded demand lease prevents one historical
  visit from creating permanent background work.
- The authenticated Vercel cron runs every minute and claims at most eight due
  scopes that were requested within the previous hour. Each scope remains
  limited by `HOME_TASK_RECOMMENDATION_REFRESH_MS` (15 minutes).
- Concurrent cron invocations compete for the row's expiring claim. Only the
  winner collects evidence or contacts providers.
- An unchanged evidence digest advances `next_refresh_at` without another model
  call. A failed attempt enters a cooldown while previous cards remain cached.
- After each successful due refresh, including an unchanged digest, the API
  publishes `homeTaskRecommendationsChanged` on that member's user-org Ably
  channel. An open page passively re-reads the cache and renews its demand
  lease; a closed page has no subscriber and ages out. The browser never polls.
- Gmail account, URL-permission, and Agent connector-scope mutations also emit
  existing or dedicated Ably invalidations, so revocation does not wait for the
  next cron tick.
- Every cache read revalidates Gmail-derived cards against the current Agent
  scope, live list/detail URL permissions, default account, and connection
  state. Cards citing Gmail are omitted whenever that authority is absent.

## Files

| File                                                                         | Role                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/api-contracts/src/contracts/home-task-recommendations.ts`          | Agent query, card target, limit, threshold, cadence |
| `apps/api/src/signals/services/home-task-recommendation-evidence.service.ts` | Agent-thread evidence and digest                    |
| `apps/api/src/signals/services/home-task-recommendation-gmail.service.ts`    | Authorized bounded Gmail collection                 |
| `apps/api/src/signals/services/connector-url-permission.service.ts`          | Shared live Agent URL policy decision               |
| `apps/api/src/signals/services/home-task-recommendation-shape.service.ts`    | Evidence-ref and provider-output validation         |
| `apps/api/src/signals/services/home-task-recommendations.service.ts`         | Agent cache, Jev gates, and three-stage generation  |
| `apps/api/src/signals/routes/home-task-recommendations.ts`                   | Cache read and bounded refresh-demand registration  |
| `apps/api/src/signals/routes/cron-refresh-home-task-recommendations.ts`      | Authenticated cron refresh boundary                 |
| `apps/platform/src/signals/okou-page/home-task-recommendations.ts`           | Ably invalidation and composer handoff              |
| `apps/platform/src/views/okou-page/home-task-recommendations.tsx`            | Cards with new/continue labels                      |
