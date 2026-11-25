# cron-official-workflow-catalog

## cron-official-workflow-catalog-001

- Vitest: "requires authentication to publish the Official Workflow catalog"
- Mode: run
- Given: The platform cron secret is configured and the caller presents no authorization header.
- When: The caller requests `GET /api/cron/sync-official-workflow-catalog`.
- Then: The API responds with HTTP 401.

## cron-official-workflow-catalog-002

- Vitest: "publishes the suggestions catalog idempotently (upload failure: false, suggestions: true)"
- Mode: run
- Given: Scenario row "suggestions" with storage uploads succeeding and Suggestions enabled. A member of another workspace and a peer member of the owner's workspace each saved private Suggestions feedback; the owner (in the peer's workspace) has completed onboarding in Asia/Shanghai, enabled `PUT /api/preferences/proactive-suggestions`, has a recent manual chat Run, and through Run tokens saved a "less like this" preference with a reason, a preference they later undo, a selected option, and a dismissed card.
- When: The cron caller requests `GET /api/cron/sync-official-workflow-catalog` twice with the cron secret, the owner reads the installed Official workflows and the Suggestions workflow detail and schedules, and `GET /api/cron/execute-workflow-automations` dispatches the due Suggestions occurrence; later occurrences are dispatched after an undo, at +7 days, at +30 days, and after 101 completed-action receipts.
- Then: The first sync returns `accepted` with no diagnostics and the second returns exactly `unchanged` with the same release ID. Suggestions and Learning schedules are both enabled with `official.intendedEnabled: true`; the detail instruction contains "# Proactive Suggestions" and `okou chat list --help`, and the Run's mounted skill bundle has a matching `SKILL.md` and `references/suggestions.md` identical to the detail file. The Run's system prompt carries a complete Suggestions feedback context with exactly the owner's three feedback entries (no foreign, peer, or dismissed entries); after the undo it holds the two remaining entries, at +7 days only the original preference, at +30 days none, and with 101 completed actions it is marked incomplete with some but fewer than 101 `already_done` entries carrying the card rationale and completion note. Disabling Suggestions disables both proactive schedules with `intendedEnabled: false`.

## cron-official-workflow-catalog-003

- Vitest: "publishes the suggestions catalog idempotently (upload failure: true, suggestions: true)"
- Mode: run
- Given: Scenario row "suggestions" where the first storage upload of the catalog artifact fails; the cron secret is configured.
- When: The cron caller requests `GET /api/cron/sync-official-workflow-catalog` three times with the cron secret.
- Then: The first sync returns HTTP 200 with outcome `rejected`, `releaseId: null`, and an `artifact-preparation-failed` diagnostic. The second returns `accepted` with no diagnostics, and the third returns exactly `unchanged` with the second sync's release ID.

## cron-official-workflow-catalog-004

- Vitest: "publishes the learning catalog idempotently (upload failure: false, suggestions: true)"
- Mode: run
- Given: Scenario row "learning" with uploads succeeding and Suggestions enabled. Members of another workspace and of the owner's workspace saved private feedback; the owner completed onboarding in Asia/Shanghai, enabled proactive suggestions, has a recent manual chat Run, and selected the "Review" option on one Suggestion.
- When: The cron caller syncs the catalog twice via `GET /api/cron/sync-official-workflow-catalog`, the owner reads the Proactive Learning workflow detail and schedule, and `GET /api/cron/execute-workflow-automations` dispatches its due occurrence.
- Then: The syncs return `accepted` then `unchanged` with the same release ID. The detail instruction and mounted `SKILL.md` contain "# Proactive Learning" and the guidance about personal Instructions or shared Agent instructions and never overriding higher-priority write restrictions; the schedule is a cron at hour 2 in `Asia/Shanghai`. The Run's feedback context is complete and holds only the owner's selected-option entry with choice "Review". The Run's token is denied with HTTP 403 on `GET /api/feed/items/active?type=suggestion`, and disabling Suggestions disables both proactive schedules.

## cron-official-workflow-catalog-005

- Vitest: "publishes the morning-brief catalog idempotently (upload failure: false, suggestions: true)"
- Mode: run
- Given: Scenario row "morning-brief" with uploads succeeding and Suggestions enabled. The owner completed onboarding in Asia/Shanghai, enabled proactive suggestions and `PUT /api/preferences/morning-brief`, and has a recent manual chat Run.
- When: The cron caller syncs the catalog twice, the owner reads the Morning Brief workflow, and `GET /api/cron/execute-workflow-automations` dispatches its due occurrence; the next two scheduled Morning Brief Runs then fail, and the failure callback for the last one is delivered again.
- Then: The syncs return `accepted` then `unchanged`. The instruction contains "# Morning Brief", "Only maintain Suggestions when", "## Decide whether to email the briefing", and `okou chat list --help`; the mounted `SKILL.md` and `references/suggestions.md` match. The Run's feedback context is present, complete, and empty. After the third consecutive failure the automation reads `enabled: false` with `official.intendedEnabled: true` and a later `nextRunAt`, and the feed holds exactly one `automation-disabled` event with `consecutiveFailures: 3` and `recoveryScheduled: true`; the repeated failure adds no event and changes no schedule state. Disabling Suggestions disables both proactive schedules.

## cron-official-workflow-catalog-006

- Vitest: "publishes the morning-brief catalog idempotently (upload failure: false, suggestions: false)"
- Mode: run
- Given: Scenario row "morning-brief" with uploads succeeding and Suggestions not enabled. The owner completed onboarding in Asia/Shanghai, enabled only the Morning Brief preference, and has a recent manual chat Run.
- When: The cron caller syncs the catalog twice, the owner reads the Morning Brief workflow, and `GET /api/cron/execute-workflow-automations` dispatches its due occurrence; the next two scheduled Runs then fail and the last failure callback is repeated.
- Then: The syncs return `accepted` then `unchanged`. The instruction and mounted `SKILL.md` contain the Morning Brief heading and email-decision guidance. The Run's system prompt has no Suggestions feedback context and its token gets HTTP 403 on `GET /api/feed/items/active?type=suggestion`. After the third consecutive failure the automation is disabled with `intendedEnabled: true`, a later `nextRunAt`, and exactly one `automation-disabled` feed event (`consecutiveFailures: 3`, `recoveryScheduled: true`) that the repeated callback does not duplicate.

## cron-official-workflow-catalog-007

- Vitest: "serves Suggestions and Learning only within seven days of the owner's manual Run"
- Mode: run
- Given: Scenario row "Suggestions and Learning". The Official catalog is published, the owner completed onboarding in Asia/Shanghai and enabled proactive suggestions, and initially has no manual Run.
- When: `GET /api/cron/execute-workflow-automations` dispatches at the due time; the owner then chats 10 minutes before the next due time and the cron dispatches again; each launched Run requests `POST /api/webhooks/run/firewall/auth` for `OPENROUTER_API_KEY`; finally the cron dispatches 7 days and 1 minute after the manual chat and at the following due time.
- Then: Without a manual Run no Run launches, both schedules stay enabled with `intendedEnabled: true` and advance `nextRunAt`, and the preference still reads `enabled`. After the manual chat exactly one Run launches per schedule, and each resolves the key to the platform-managed proactive key with `resolvedSecrets: ["OPENROUTER_API_KEY"]`. Once the manual Run is over seven days old the next occurrence launches no new Run while schedules stay enabled.

## cron-official-workflow-catalog-008

- Vitest: "serves Morning Brief only within seven days of the owner's manual Run"
- Mode: run
- Given: Scenario row "Morning Brief". The Official catalog is published, the owner completed onboarding in Asia/Shanghai and enabled the Morning Brief preference, and initially has no manual Run.
- When: `GET /api/cron/execute-workflow-automations` dispatches at the due time; the owner then chats 10 minutes before the next due time and the cron dispatches again; the launched Run requests `POST /api/webhooks/run/firewall/auth` for `OPENROUTER_API_KEY`; finally the cron dispatches 7 days and 1 minute after the manual chat and at the following due time.
- Then: Without a manual Run no Run launches, the schedule stays enabled with `intendedEnabled: true` and an advanced `nextRunAt`, and the preference still reads `enabled`. After the manual chat exactly one Run launches and its key resolves to the platform-managed proactive key. Once the manual Run is over seven days old the next occurrence launches no new Run while the schedule stays enabled.
