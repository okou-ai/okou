# connector-catalog-immutable

## connector-catalog-immutable-001

- Vitest: "immutable connector catalog publication > serves a complete catalog after concurrent publication requests"
- Mode: run
- Given: A valid immutable publication contains exactly public-mcp, manual-mcp and openai, and its storage pointer and catalog are available.
- When: Two authenticated operators' GET requests to /api/cron/sync-connector-catalog overlap for the same publication. An authenticated workspace member then reads GET /api/connector-catalog.
- Then: Both syncs return HTTP 200 with accepted or unchanged, at least one accepted and both failure codes null. The catalog HTTP 200 lists exactly all three published connector slugs.

## connector-catalog-immutable-002

- Vitest: "current-publication account readers > connector account lifecycle routes > reviews requested scopes for one exact account across default changes"
- Mode: run
- Given: An authenticated owner has two GitHub OAuth accounts with distinct provider identities. The current catalog requests repo, project and workflow. The provider exchange response grants repo, and the newer account has been made the default.
- When: The owner reads GET /api/connector-accounts/connections with and without scope mismatch enrichment and a search for the older account. They read GET /api/connector-accounts/:connectionId/scope-diff for both IDs, change the default and repeat the newer account's read. They also try a mismatching connector slug, a different user and readback after deleting that account.
- Then: Plain HTTP 200 lists omit scopeMismatch and return the current default. Enriched results report false for both IDs and retain the current default even when search returns only the older account. Each exact scope diff returns HTTP 200 with repo, project and workflow as both current and stored scopes and no additions or removals. The newer account's diff survives a default change. The wrong slug, different caller and deleted account each return HTTP 404.
