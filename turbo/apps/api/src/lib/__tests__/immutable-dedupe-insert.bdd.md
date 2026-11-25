# immutable-dedupe-insert

## immutable-dedupe-insert-001

- Vitest: "resolveImmutableDedupeInsert > returns the row created by a successful insert"
- Mode: run
- Intent: review
- Given: The database reports a successful insert with one returned row.
- When: The insert outcome is resolved.
- Then: The resolver returns that exact row.

## immutable-dedupe-insert-002

- Vitest: "resolveImmutableDedupeInsert > maps an exact PostgreSQL 23505 to the duplicate result"
- Mode: run
- Intent: review
- Given: The insert fails with PostgreSQL SQLSTATE `23505`.
- When: The insert outcome is resolved.
- Then: The resolver returns `null` as the duplicate outcome.

## immutable-dedupe-insert-003

- Vitest: "resolveImmutableDedupeInsert > rethrows a foreign-key violation unchanged"
- Mode: run
- Intent: review
- Given: The insert fails with PostgreSQL SQLSTATE `23503`.
- When: The insert outcome is resolved.
- Then: The resolver throws the original error unchanged.

## immutable-dedupe-insert-004

- Vitest: "resolveImmutableDedupeInsert > rethrows a connection failure unchanged"
- Mode: run
- Intent: review
- Given: The insert fails with connection error `ECONNRESET`.
- When: The insert outcome is resolved.
- Then: The resolver throws the original error unchanged.

## immutable-dedupe-insert-005

- Vitest: "resolveImmutableDedupeInsert > rethrows a abort unchanged"
- Mode: run
- Intent: review
- Given: The insert fails with an `AbortError`.
- When: The insert outcome is resolved.
- Then: The resolver throws the original error unchanged.

## immutable-dedupe-insert-006

- Vitest: "resolveImmutableDedupeInsert > rethrows a arbitrary error unchanged"
- Mode: run
- Intent: review
- Given: The insert fails with a generic error.
- When: The insert outcome is resolved.
- Then: The resolver throws the original error unchanged.
