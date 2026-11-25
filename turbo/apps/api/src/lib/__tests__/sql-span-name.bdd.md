# sql-span-name

## sql-span-name-001

- Vitest: "deriveSqlSpanName > supported DML keywords with a quoted target table > select … from \"table\""
- Mode: run
- Intent: review
- Given: Database telemetry has a parameterized SELECT from quoted table `cli_tokens`.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `SELECT cli_tokens`.

## sql-span-name-002

- Vitest: "deriveSqlSpanName > supported DML keywords with a quoted target table > insert into \"table\" … returning"
- Mode: run
- Intent: review
- Given: Database telemetry has a parameterized INSERT with RETURNING against quoted table `usage_events`.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `INSERT usage_events`.

## sql-span-name-003

- Vitest: "deriveSqlSpanName > supported DML keywords with a quoted target table > update \"table\" set …"
- Mode: run
- Intent: review
- Given: Database telemetry has a parameterized UPDATE against quoted table `cli_tokens`.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `UPDATE cli_tokens`.

## sql-span-name-004

- Vitest: "deriveSqlSpanName > supported DML keywords with a quoted target table > delete from \"table\""
- Mode: run
- Intent: review
- Given: Database telemetry has a parameterized DELETE from quoted table `device_codes`.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `DELETE device_codes`.

## sql-span-name-005

- Vitest: "deriveSqlSpanName > supported DML keywords with a quoted target table > merge into \"table\" (postgres 15+)"
- Mode: run
- Intent: review
- Given: Database telemetry has a PostgreSQL MERGE into `usage_events` using `staging`.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `MERGE usage_events`.

## sql-span-name-006

- Vitest: "deriveSqlSpanName > multi-table or sub-select queries pick the first from/into/update/join target > select joining two tables uses the from table"
- Mode: run
- Intent: review
- Given: Database telemetry has a SELECT from `users` joined to `org_members`.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `SELECT users`.

## sql-span-name-007

- Vitest: "deriveSqlSpanName > multi-table or sub-select queries pick the first from/into/update/join target > insert into … select from other_table uses the into table"
- Mode: run
- Intent: review
- Given: Database telemetry has an INSERT into `usage_events_daily` with a SELECT from `usage_events`.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `INSERT usage_events_daily`.

## sql-span-name-008

- Vitest: "deriveSqlSpanName > multi-table or sub-select queries pick the first from/into/update/join target > with cte as (…) … takes the first from inside the cte"
- Mode: run
- Intent: review
- Given: Database telemetry has a WITH statement whose CTE selects from `cli_tokens` before a DELETE.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `WITH cli_tokens`.

## sql-span-name-009

- Vitest: "deriveSqlSpanName > postgres-specific syntax > delete from only \"table\" (table inheritance) strips only"
- Mode: run
- Intent: review
- Given: Database telemetry has a parameterized `DELETE FROM ONLY` with quoted target `audit_log`.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `DELETE audit_log`.

## sql-span-name-010

- Vitest: "deriveSqlSpanName > postgres-specific syntax > unquoted system catalog name (drizzle.execute raw sql)"
- Mode: run
- Intent: review
- Given: Database telemetry has a raw SELECT from unquoted `pg_database`.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `SELECT pg_database`.

## sql-span-name-011

- Vitest: "deriveSqlSpanName > operation without a target table > select 1 has no from, return the operation alone"
- Mode: run
- Intent: review
- Given: Database telemetry has `select 1` with no table.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `SELECT`.

## sql-span-name-012

- Vitest: "deriveSqlSpanName > input variations > is case-insensitive on the leading keyword"
- Mode: run
- Intent: review
- Given: Database telemetry has uppercase and title-case SELECT statements against `users`.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `SELECT users` for both statements.

## sql-span-name-013

- Vitest: "deriveSqlSpanName > input variations > tolerates leading/trailing whitespace"
- Mode: run
- Intent: review
- Given: Database telemetry has a SELECT from `users` surrounded by whitespace.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `SELECT users`.

## sql-span-name-014

- Vitest: "deriveSqlSpanName > returns null when there is no recognised dml keyword > empty string"
- Mode: run
- Intent: review
- Given: Database telemetry has an empty SQL string.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `null`.

## sql-span-name-015

- Vitest: "deriveSqlSpanName > returns null when there is no recognised dml keyword > explain analyze select … (does not start with a dml verb)"
- Mode: run
- Intent: review
- Given: Database telemetry has an `EXPLAIN ANALYZE SELECT` statement from `users`.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `null`.

## sql-span-name-016

- Vitest: "deriveSqlSpanName > returns null when there is no recognised dml keyword > commit control statement"
- Mode: run
- Intent: review
- Given: Database telemetry has a COMMIT transaction control statement.
- When: The SQL telemetry adapter derives a span name.
- Then: The adapter returns `null`.
