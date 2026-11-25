# connector-catalog-status-generation

## connector-catalog-status-generation-001

- Vitest: "single-connector current catalog status > projects missing required configuration consistently and reconnects the exact default"
- Mode: run
- Given: An authenticated account owner has a default OpenAI manual connection with an API key under the published catalog. Storage then serves a new valid catalog generation that adds required Region configuration to that grant.
- When: The operator authenticates to GET /api/cron/sync-connector-catalog. The owner reads GET /api/connector-accounts/:connectionId, reconnects that exact ID with both inputs through POST /api/connectors/openai/manual-grant and reads the account again.
- Then: The sync returns HTTP 200 with accepted and a null failure code. The first read returns HTTP 200 and reports the same default account and update timestamp, reconnect-required with configuration_incomplete, configured apiKey and missing region. Reconnect returns HTTP 200 with the same ID. The final HTTP 200 reports connected with a null reason, both configured fields and no missing fields.
