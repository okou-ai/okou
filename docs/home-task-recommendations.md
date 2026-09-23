# Home task recommendations

Personalized task cards on one Agent's home page. The member sees up to three
important next actions derived only from Gmail content that Agent may read and
visible threads owned by that Agent. Each card states whether it starts a new
chat or continues an existing thread. Repeated completed tasks may instead
produce a suggestion to ask the Agent about a reusable Workflow.

Clicking an ordinary task card opens the target composer and prepends its text
before the user's existing draft, including a remotely saved draft. The click
does not send it. Clicking a Workflow suggestion starts a new chat and sends the
suggested task to the Agent, which judges whether a Workflow fits, checks
existing Workflows, and asks for missing constraints before creating one. The
home page does not create or enable a Workflow itself.

Gated by `FeatureSwitchKey.HomeTaskRecommendations`, off by default.

## Pipeline

One refresh has three deliberately separate stages.

1. **Form candidates.** Code deterministically makes bounded task intents from
   recent visible Agent threads and authorized Gmail messages. It also groups
   similar user requests attached to at least three completed runs as possible
   Workflow assessment tasks. A thread candidate carries its own opaque source
   ref and an existing-thread destination; Gmail and Workflow candidates start
   fresh. Providers never receive real thread IDs.
2. **Decide.** The fixed OpenRouter model `typesafe/jev-1.13` evaluates every
   candidate with structured `Score` and `Noul` questions: actionability,
   grounding, and whether the proposed new/existing-thread destination is
   correct. Code derives confidence from the probability mass on accepted
   actionability levels plus the two `Noul` probabilities. Candidates must pass
   both `HOME_TASK_RECOMMENDATION_MIN_ACTIONABILITY` and the Jev confidence
   gate.
3. **Write.** `FAST_PATH_MODEL` receives only accepted intents and writes the
   localized title, prompt, and rationale. For a Workflow task, the server
   appends bounded completed-request examples to the prompt before storing it.

The split is the boundary. No prose model selects candidates or scores them;
Jev cannot generate free text; the writer cannot change score, connector list,
purpose, or destination. Existing thread refs are resolved to IDs locally and
never authored by a provider.

If nothing clears the gates, the writer is not called and the member sees no
cards. That is a correct outcome, not a failure.

## Evidence and authorization

The source allowlist is intentionally narrow. Before a cron scope may read it,
the current Clerk organization membership, feature switch, and Agent visibility
must all resolve; the same immutable membership is checked again after source
I/O and before generated cards are committed.

- Up to 40 recent threads for the requested Agent, restricted to the current
  user and organization. Threads with queued, pending, or running Agent runs or
  queued messages are excluded. Only recent visible `input.prompt` and
  `output.message` excerpts are collected; hidden, revoked, thinking, control,
  and other event types do not travel. At most 160 messages are read overall,
  with at most six retained per thread.
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

Every provider stage marks source material and derived candidate text as
untrusted quoted data. A chat message, email snippet, candidate intent, or reason
cannot become an instruction, request a tool, or add a source.

## Refresh and isolation

`home_task_recommendations` holds one row per `(user, org, agent)`. Switching
Agents therefore changes evidence, cache identity, and cards. Generation never
runs in a browser request. The browser does not poll for card changes. A small
route-owned lease renewal only keeps an open home visit eligible for cron.

- `GET /api/home-task-recommendations` records `last_requested_at` and returns
  the current cache only. The page reads once on entry or browser refresh and
  again only when the member clicks Reload. The bounded demand lease prevents
  one historical visit from creating permanent background work.
- `POST /api/home-task-recommendations/touch` renews that lease during a long
  home visit without reading the cache or changing the visible cards.
- The authenticated Vercel cron runs every minute and claims at most eight due
  scopes that were requested within the previous hour. Each scope remains
  limited by `HOME_TASK_RECOMMENDATION_REFRESH_MS` (15 minutes).
- Concurrent cron invocations compete for the row's expiring claim. Only the
  winner collects evidence or contacts providers.
- An unchanged evidence digest advances `next_refresh_at` without another model
  call. A failed attempt enters a cooldown while previous cards remain cached.
- When the cached set changes, the API publishes
  `homeTaskRecommendationsChanged` on that member's user-org Ably channel. An
  open page records that new cards are available, but keeps its current cards
  until the member leaves and returns or clicks Reload. A closed page has no
  subscriber and ages out.
- Gmail account, URL-permission, and Agent connector-scope mutations also emit
  existing or dedicated Ably notices. Because a notice may mean revocation,
  the open page immediately hides Gmail-derived cards and offers Reload without
  automatically replacing the rest of the row.
- Every cache read revalidates Gmail-derived cards against the current Agent
  scope, live list/detail URL permissions, default account, and connection
  state. Cards citing Gmail are omitted whenever that authority is absent.

## Files

| File                                                                         | Role                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/api-contracts/src/contracts/home-task-recommendations.ts`          | Agent query, card target, limit, threshold, cadence   |
| `apps/api/src/signals/services/home-task-recommendation-evidence.service.ts` | Agent-thread evidence and digest                      |
| `apps/api/src/signals/services/home-task-recommendation-gmail.service.ts`    | Authorized bounded Gmail collection                   |
| `apps/api/src/signals/services/connector-url-permission.service.ts`          | Shared live Agent URL policy decision                 |
| `apps/api/src/signals/services/home-task-recommendation-shape.service.ts`    | Deterministic candidates and writer-output validation |
| `apps/api/src/signals/services/home-task-recommendations.service.ts`         | Agent cache, Jev gates, and card writing              |
| `apps/api/src/signals/routes/home-task-recommendations.ts`                   | Cache read and refresh-demand renewal                 |
| `apps/api/src/signals/routes/cron-refresh-home-task-recommendations.ts`      | Authenticated cron refresh boundary                   |
| `apps/platform/src/signals/okou-page/home-task-recommendations.ts`           | Ably notice, authority masking, and composer handoff  |
| `apps/platform/src/views/okou-page/home-task-recommendations.tsx`            | Cards, targets, Reload, and loading skeletons         |
