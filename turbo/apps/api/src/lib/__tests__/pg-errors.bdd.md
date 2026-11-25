# pg-errors

## pg-errors-001

- Vitest: "SQLSTATE classification > matches 55P03 only for its own predicate"
- Mode: run
- Intent: review
- Given: The database failure carries wrapped PostgreSQL SQLSTATE `55P03`.
- When: The API classifies it against lock unavailability, foreign-key violation, and uniqueness violation.
- Then: Only the lock unavailability classifier matches.

## pg-errors-002

- Vitest: "SQLSTATE classification > matches 23503 only for its own predicate"
- Mode: run
- Intent: review
- Given: The database failure carries wrapped PostgreSQL SQLSTATE `23503`.
- When: The API classifies it against lock unavailability, foreign-key violation, and uniqueness violation.
- Then: Only the foreign-key violation classifier matches.

## pg-errors-003

- Vitest: "SQLSTATE classification > matches 23001 only for its own predicate"
- Mode: run
- Intent: review
- Given: The database failure carries wrapped PostgreSQL SQLSTATE `23001`.
- When: The API classifies it against lock unavailability, foreign-key violation, and uniqueness violation.
- Then: Only the foreign-key violation classifier matches.

## pg-errors-004

- Vitest: "SQLSTATE classification > matches 23505 only for its own predicate"
- Mode: run
- Intent: review
- Given: The database failure carries wrapped PostgreSQL SQLSTATE `23505`.
- When: The API classifies it against lock unavailability, foreign-key violation, and uniqueness violation.
- Then: Only the uniqueness violation classifier matches.

## pg-errors-005

- Vitest: "Named dependency constraints > matches the exact dependency constraint for 23503"
- Mode: run
- Intent: review
- Given: The wrapped driver failure carries SQLSTATE `23503` and constraint `fk_custom_connector_cloudflare_config`.
- When: The API checks the foreign-key failure against the reported dependency constraint and a different constraint.
- Then: The check matches the reported constraint and rejects the different constraint.

## pg-errors-006

- Vitest: "Named dependency constraints > matches the exact dependency constraint for 23001"
- Mode: run
- Intent: review
- Given: The wrapped driver failure carries SQLSTATE `23001` and constraint `fk_custom_connector_cloudflare_config`.
- When: The API checks the foreign-key failure against the reported dependency constraint and a different constraint.
- Then: The check matches the reported constraint and rejects the different constraint.

## pg-errors-007

- Vitest: "safeSqlStateCode > publishes a valid class code"
- Mode: run
- Intent: review
- Given: The wrapped driver error carries code `57014`.
- When: The API extracts a publishable SQLSTATE.
- Then: It returns `57014`.

## pg-errors-008

- Vitest: "safeSqlStateCode > publishes the class code alone, never the driver message"
- Mode: run
- Intent: review
- Given: The wrapped driver error carries code `23503` and a message containing SQL text.
- When: The API extracts a publishable SQLSTATE.
- Then: It returns only `23503`.

## pg-errors-009

- Vitest: "safeSqlStateCode > drops no cause"
- Mode: run
- Intent: review
- Given: The error has no cause.
- When: The API extracts a publishable SQLSTATE.
- Then: It returns no code.

## pg-errors-010

- Vitest: "safeSqlStateCode > drops a non-object cause"
- Mode: run
- Intent: review
- Given: The error cause is the string `23503`.
- When: The API extracts a publishable SQLSTATE.
- Then: It returns no code.

## pg-errors-011

- Vitest: "safeSqlStateCode > drops a numeric code"
- Mode: run
- Intent: review
- Given: The wrapped driver code is the number 23503.
- When: The API extracts a publishable SQLSTATE.
- Then: It returns no code.

## pg-errors-012

- Vitest: "safeSqlStateCode > drops an absent code"
- Mode: run
- Intent: review
- Given: The wrapped error cause has no code.
- When: The API extracts a publishable SQLSTATE.
- Then: It returns no code.

## pg-errors-013

- Vitest: "safeSqlStateCode > drops a transport code"
- Mode: run
- Intent: review
- Given: The wrapped driver reports `ECONNRESET`.
- When: The API extracts a publishable SQLSTATE.
- Then: It returns no code.

## pg-errors-014

- Vitest: "safeSqlStateCode > drops a lowercase code"
- Mode: run
- Intent: review
- Given: The wrapped driver code is `55p03`.
- When: The API extracts a publishable SQLSTATE.
- Then: It returns no code.

## pg-errors-015

- Vitest: "safeSqlStateCode > drops an over-long code"
- Mode: run
- Intent: review
- Given: The wrapped driver code is `55P030`.
- When: The API extracts a publishable SQLSTATE.
- Then: It returns no code.

## pg-errors-016

- Vitest: "isStatementTimeout > recognizes the server deadline in the Drizzle cause"
- Mode: run
- Intent: review
- Given: The wrapped driver error has code `57014` and message `canceling statement due to statement timeout`.
- When: The API classifies the error for statement-timeout handling.
- Then: It recognizes a server statement deadline.

## pg-errors-017

- Vitest: "isStatementTimeout > does not retry 57014 / canceling statement due to user request"
- Mode: run
- Intent: review
- Given: The wrapped driver error has code `57014` and message `canceling statement due to user request`.
- When: The API classifies the error for statement-timeout handling.
- Then: The classifier does not identify a statement timeout.

## pg-errors-018

- Vitest: "isStatementTimeout > does not retry 57014 / unknown cancellation"
- Mode: run
- Intent: review
- Given: The wrapped driver error has code `57014` and message `unknown cancellation`.
- When: The API classifies the error for statement-timeout handling.
- Then: The classifier does not identify a statement timeout.

## pg-errors-019

- Vitest: "isStatementTimeout > does not retry 55P03 / canceling statement due to statement timeout"
- Mode: run
- Intent: review
- Given: The wrapped driver error has code `55P03` and message `canceling statement due to statement timeout`.
- When: The API classifies the error for statement-timeout handling.
- Then: The classifier does not identify a statement timeout.

## pg-errors-020

- Vitest: "isStatementTimeout > does not retry 57014 / undefined"
- Mode: run
- Intent: review
- Given: The wrapped driver error has code `57014` and no message.
- When: The API classifies the error for statement-timeout handling.
- Then: The classifier does not identify a statement timeout.

## pg-errors-021

- Vitest: "isStatementTimeout > preserves caller cancellation and unwrapped errors"
- Mode: run
- Intent: review
- Given: One error is an `AbortError` from the caller. Another is an unwrapped object with code `57014` and the exact statement-timeout message.
- When: The API classifies both errors for statement-timeout handling.
- Then: Neither error is classified as a statement timeout.
