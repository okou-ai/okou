# test-database-url

## test-database-url-001

- Vitest: "keeps the configured connection and unrelated parameters"
- Mode: run
- Intent: review
- Given: A PostgreSQL fixture URL specifies percent-encoded credentials, `db.example.test:5544/fixtures`, `sslmode=verify-full`, `application_name=seed-client`, `connect_timeout=5` and a statement timeout of 3000. Inherited options specify a lock timeout of 1000.
- When: The API test infrastructure prepares its database URL.
- Then: The connection and unrelated parameters remain unchanged. Startup options use the URL's statement timeout and append `-c timezone=UTC`.

## test-database-url-002

- Vitest: "adds UTC when no startup options are co…"
- Mode: run
- Intent: review
- Given: The fixture database URL has no `options` parameter and `PGOPTIONS` is unset.
- When: The test database URL is prepared.
- Then: The resulting URL contains exactly one `options` parameter with value `-c timezone=UTC`.

## test-database-url-003

- Vitest: "preserves inherited PGOPTIONS when URL …"
- Mode: run
- Intent: review
- Given: The fixture database URL has no `options` parameter. `PGOPTIONS` specifies a lock timeout of 1000 and timezone Asia/Shanghai.
- When: The test database URL is prepared.
- Then: The resulting URL contains exactly one `options` parameter with value `-c lock_timeout=1000 -c timezone=Asia/Shanghai -c timezone=UTC`.

## test-database-url-004

- Vitest: "uses URL options instead of inherited P…"
- Mode: run
- Intent: review
- Given: The URL specifies a statement timeout of 3000 and timezone Asia/Shanghai. `PGOPTIONS` specifies a lock timeout of 1000.
- When: The test database URL is prepared.
- Then: The resulting URL contains exactly one `options` parameter with value `-c statement_timeout=3000 -c timezone=Asia/Shanghai -c timezone=UTC`.

## test-database-url-005

- Vitest: "falls back to PGOPTIONS when URL option…"
- Mode: run
- Intent: review
- Given: The URL's `options` value is empty and `PGOPTIONS` specifies a lock timeout of 1000.
- When: The test database URL is prepared.
- Then: The resulting URL contains exactly one `options` parameter with value `-c lock_timeout=1000 -c timezone=UTC`.

## test-database-url-006

- Vitest: "preserves the last duplicate URL option…"
- Mode: run
- Intent: review
- Given: The URL has two `options` entries with statement timeouts of 1000 and 3000 respectively. `PGOPTIONS` specifies a lock timeout of 1000.
- When: The test database URL is prepared.
- Then: The resulting URL contains exactly one `options` parameter with value `-c statement_timeout=3000 -c timezone=UTC`.

## test-database-url-007

- Vitest: "falls back when the last duplicate URL …"
- Mode: run
- Intent: review
- Given: The URL first specifies a statement timeout of 1000 and then an empty `options` value. `PGOPTIONS` specifies a lock timeout of 1000.
- When: The test database URL is prepared.
- Then: The resulting URL contains exactly one `options` parameter with value `-c lock_timeout=1000 -c timezone=UTC`.

## test-database-url-008

- Vitest: "retains the existing local test endpoint when no URL is provided"
- Mode: run
- Intent: review
- Given: No fixture database URL or inherited startup options are configured.
- When: The API test infrastructure prepares its database URL.
- Then: The endpoint is `localhost:5432/vm0_test` and the startup option is `-c timezone=UTC`.
