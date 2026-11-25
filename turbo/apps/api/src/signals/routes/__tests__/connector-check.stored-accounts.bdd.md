# connector-check.stored-accounts

## connector-check.stored-accounts-001

- Vitest: "stored Connector diagnostic account selection > keeps missing builtin groups unresolved despite a connected custom account"
- Mode: run
- Given: An authenticated organization admin has no Reap account and has a manually connected custom HTTP account whose configured host corresponds to the URL being diagnosed.
- When: The admin submits GET URL diagnostics to POST /api/connectors/diagnostics/check, first explicitly selecting built-in Reap, then explicitly selecting the custom definition, and then diagnosing a static GitHub endpoint with no selected connector.
- Then: All requests return HTTP 200. Reap reports unresolved-dynamic-base for the built-in target. The custom diagnostic reports no-match at catalog scope. The static GitHub URL resolves to the built-in GitHub target with run status not-scoped.

## connector-check.stored-accounts-002

- Vitest: "stored Connector diagnostic account selection > uses only the selected default account and follows public account changes"
- Mode: run
- Given: An authenticated organization admin has two saved Reap accounts with distinct base URLs.
- When: The admin makes each account the default in turn and uses POST /api/connectors/diagnostics/check to diagnose a GET /users request for both base URLs after each change.
- Then: All responses are HTTP 200. Only the current default's base resolves, with its exact base, relative path /users, built-in Reap target and run status not-scoped. The other base reports no-match at catalog scope. Neither result exposes the chosen connection ID.
