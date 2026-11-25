# proactive-preferences

## proactive-preferences-001

- Vitest: "Proactive CLI preferences > publishes the Official catalog and lets the primary Run control preferences and delivery"
- Mode: run
- Given: An onboarded workspace member in UTC has a primary chat Run with an execution token. The operator has published the Official Workflow catalog.
- When: The Run reads and toggles Morning Brief and Suggestions on, off and on. It then pauses Suggestions and toggles What’s New, Offers and System Updates individually while a web session reads back the settings.
- Then: Initially both are disabled. Every update returns HTTP 200 with matching enabled state, enabled or paused status and no unavailable reason. Session readbacks match the returned values. The Suggestions feed flag tracks the toggle and the other flags remain enabled until individually changed. Those independent updates affect only the selected flag and read back unchanged.

## proactive-preferences-002

- Vitest: "Proactive CLI preferences > rejects preference access from a finished personal Run"
- Mode: run
- Given: An onboarded user has a personal Run token whose Run has finished with failure.
- When: The caller uses that token to read and update Morning Brief and Suggestions, then reads and updates feed source settings.
- Then: All requests return HTTP 403. Preference reads identify the error as `FORBIDDEN`.
