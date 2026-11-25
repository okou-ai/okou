# axiom-datasets

## axiom-datasets-001

- Vitest: "getAxiomTokenEnvNameForApl > uses the sessions token for agent run events"
- Mode: run
- Intent: review
- Given: The APL query targets `vm0-agent-run-events-dev` and filters by run ID.
- When: The API selects the query credential for that APL input.
- Then: The selection is `AXIOM_TOKEN_SESSIONS`.

## axiom-datasets-002

- Vitest: "getAxiomTokenEnvNameForApl > uses the telemetry token for telemetry datasets"
- Mode: run
- Intent: review
- Given: The APL query targets `vm0-sandbox-telemetry-network-dev`.
- When: The API selects the query credential for that APL input.
- Then: The selection is `AXIOM_TOKEN_TELEMETRY`.

## axiom-datasets-003

- Vitest: "getAxiomTokenEnvNameForApl > defaults unknown APL to the telemetry token"
- Mode: run
- Intent: review
- Given: The APL input is `limit 1` with no recognized dataset.
- When: The API selects the query credential for that APL input.
- Then: The selection defaults to `AXIOM_TOKEN_TELEMETRY`.
