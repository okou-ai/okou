# Ideas page

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [ideas-page.test.tsx](ideas-page.test.tsx).

## ideas-page-001

Original test `Category filters expose one persistent selection and preserve search`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L107).

- **Given** The ideas catalog includes connector-dependent and connector-free use cases, and All is initially selected.
- **When** The user selects Engineering, selects it again, searches for “Browser screenshots,” then selects All.
- **Then** Only one category remains selected and selecting Engineering again does not deselect it. The search is preserved while filtered results update, and selecting All restores “Browser screenshots” without clearing the search.

## ideas-page-002

Original test `The ideas catalog still offers connector-free use cases`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L160).

- **Given** The connector catalog is empty.
- **When** The user views the ideas catalog and searches for “Daily standup.”
- **Then** The connector-free “Browser screenshots” use case remains available, while “Daily standup report” is absent and the search reports no matches.

## ideas-page-003

Original test `The breadcrumb links back to the Agent chat`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L176).

- **Given** The user is viewing an agent's ideas page.
- **When** They follow the Chat breadcrumb.
- **Then** They return to that agent's chat.
- **Upstream change** `4e5707de` (#49556) retires per-agent chat pages, so the Chat breadcrumb on an agent's ideas page now lands on the My Okou chat at `/`; the upstream test is now `The breadcrumb links back to My Okou` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L176)). Rebuild this scenario expecting the composer at `/` after following the Chat breadcrumb, not the agent's chat route.

## ideas-page-004

Original test `Keep default Okou instruction self-management unavailable on /ideas`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L213).

- **Given** The user views /ideas with the default Okou agent.
- **When** They view the ideas catalog.
- **Then** “Self-update instructions” is not available.

## ideas-page-005

Original test `Keep default Okou instruction self-management unavailable on /agents/c0000000-0000-4000-a000-000000000031/ideas`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L213).

- **Given** The user views the default Okou agent's ideas page at /agents/c0000000-0000-4000-a000-000000000031/ideas.
- **When** They view the ideas catalog.
- **Then** “Self-update instructions” is not available.

## ideas-page-006

Original test `A custom Agent can start the instruction self-management example`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L228).

- **Given** The user views a custom agent's ideas catalog.
- **When** They select “Self-update instructions.”
- **Then** The custom agent's chat opens with “Update yourself: add the following instructions — ...” in the composer.
- **Upstream change** `4e5707de` (#49556) retires per-agent chat pages (`/agents/<id>/chat` now redirects to `/` and keeps the prompt), so the custom agent's self-update idea opens the My Okou chat; the upstream test is now `A custom Agent can start the instruction self-management example` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L228)). Rebuild this scenario expecting the prompt in the composer at `/` rather than in the custom agent's chat.

## ideas-page-007

Original test `Connector-dependent ideas fail closed when availability cannot be verified`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L253).

- **Given** Connector availability for the ideas catalog cannot be verified because the catalog request fails with a 503 response.
- **When** The catalog finishes loading after the failed request.
- **Then** Connector-dependent “Daily standup report” is hidden while connector-free “Browser screenshots” remains visible.

## ideas-page-008

Original test `A use case is hidden when any required connector is unavailable`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L280).

- **Given** A use case requires GitHub, Sentry, Axiom, Plausible, and Slack, but only GitHub and Slack are available.
- **When** The user views the ideas catalog.
- **Then** “Daily standup report” is hidden because at least one required connector is unavailable.

## ideas-page-009

Original test `A card on /ideas exposes its prompt link and opens by keyboard`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L297).

- **Given** The user views /ideas with a default agent and searches for “Daily standup report.”
- **When** They keyboard-activate the matching use-case link.
- **Then** The default chat opens with the full daily standup prompt in the composer.
- **Upstream change** `4e5707de` (#49556) makes My Okou permanent, so Home no longer redirects to the default agent's `/agents/<id>/chat`; the upstream row is `A card on /ideas exposes its prompt link and opens by keyboard` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L296)). Rebuild this scenario expecting the card link `/?prompt=…` and the composer with the prompt to stay at `/`.

## ideas-page-010

Original test `A card on /agents/c0000000-0000-4000-a000-0000000… exposes its prompt link and opens by keyboard`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L297).

- **Given** The user views a custom agent's ideas page and searches for “Daily standup report.”
- **When** They keyboard-activate the matching use-case link.
- **Then** That custom agent's chat opens with the full daily standup prompt in the composer.
- **Upstream change** `4e5707de` (#49556) retires per-agent chat pages, so the card link still targets `/agents/<custom agent id>/chat?prompt=…` but that route now redirects to the My Okou chat at `/`; the upstream test is now the custom-agent row of `A card on $path exposes its prompt link and opens by keyboard` ([Registration](https://github.com/okou-ai/okou/blob/4e5707de3e/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L296)). Rebuild this scenario expecting the daily standup prompt in the composer at `/` rather than in the custom agent's chat.

## ideas-page-011

Original test `Search for a use case and start it with the agent`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L349).

- **Given** The user's agent can access RevenueCat, Google Sheets, Slack, and the other required connectors.
- **When** They search for RevenueCat and select “RevenueCat subscription digest.”
- **Then** The composer contains the prompt to track new subscriptions, renewals, and cancellations in Google Sheets and alert on Slack for churn spikes; “Daily standup report” is not shown in the search results.

## ideas-page-012

Original test `Start the Zapier migration idea from the available connector catalog`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/okou-page/__tests__/ideas-page.test.tsx#L375).

- **Given** Zapier, Slack, and Notion are available in the connector catalog.
- **When** The user searches for Zapier and selects “Zapier → Okou migration.”
- **Then** The composer contains the migration prompt listing new Slack message → Notion, Gmail → Google Sheets, and GitHub PR → Slack workflows.
