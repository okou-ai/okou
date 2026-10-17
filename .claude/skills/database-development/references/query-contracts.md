# Drizzle query contracts

[Database development](../SKILL.md)

## Database Result Boundaries

Drizzle's `sql<T>`, `SQL<T>`, generic `.as<T>()`, `execute<Row>`, and TypeScript
assertions only change compile-time types. They do not validate or decode
PostgreSQL driver values. Never use them to declare a database result contract.

### Structured Selections

For every raw expression selected by `select`, `selectDistinct`,
`selectDistinctOn`, `returning`, or relational-query `extras`, choose the first
applicable runtime boundary:

1. Prefer a schema column or a Drizzle helper such as `count()` that already
   owns the correct decoder.
2. Use `.mapWith(column)` when the expression has exactly the same PostgreSQL
   runtime representation as that column.
3. Use `.mapWith(decoder)` for a dedicated runtime contract. Shared decoders
   live in `turbo/apps/api/src/lib/db-structured-result.ts`.
4. If the expression can return SQL `NULL`, wrap the column or decoder with
   `nullableDriverValueDecoder(...)`. Drizzle preserves `null` and applies the
   wrapped decoder only to non-null values.

```typescript
// Correct: LOWER(text) has the same driver representation as the text column.
const normalizedEmail = sql`LOWER(${users.email})`
  .mapWith(users.email)
  .as("normalized_email");

// Correct: the explicit decoder owns the runtime number contract.
const total = sql`COUNT(*)::int`.mapWith(pgIntegerDecoder).as("total");

// Correct: nullable SQL result with the column's non-null decoder.
const latestName = sql`MAX(${users.name})`
  .mapWith(nullableDriverValueDecoder(users.name))
  .as("latest_name");

// Incorrect: these only restate a TypeScript type.
const unsafeEmail = sql<string>`LOWER(${users.email})`;
const unsafeAlias = sql`LOWER(${users.email})`.as<string>("email");
```

Apply `.mapWith(...)` before `.as("alias")`; aliasing names a SQL field but does
not add or replace its decoder. A PostgreSQL cast such as `::int` changes the
server-side value representation, while `.mapWith(...)` defines the client-side
runtime decoder. A TypeScript assertion changes neither one.

Use only statically inspectable decoder provenance in `.mapWith(...)`: a real
schema column, a reviewed decoder from `db-structured-result.ts`, or a decoder
constructed through its Zod, enum, or nullable factories. Immutable local
`const` alias chains may preserve that provenance. Built-in coercers such as
`Number` and `String`, inline callbacks, assertions, mutable aliases, and opaque
values declared as `DriverValueDecoder` do not establish a reviewed runtime
contract and are rejected by lint.

The same rule applies to `db.query.<table>.findMany(...)` and
`findFirst(...)`, including callback-form `extras` and `extras` nested below
`with`. Keep relational configs inline or in inspectable local variables so
lint can follow every selected extra. Call `select`, `selectDistinct`,
`selectDistinctOn`, `returning`, `findMany`, and `findFirst` directly; do not
alias, destructure, or bind these methods, and do not spread their invocation
arguments, because those forms hide the result boundary from static
enforcement.

For set operations, every branch must expose a compatible, concretely mapped
output. Drizzle uses the leftmost branch's decoder for returned rows, so the
leftmost expression owns the runtime contract; mapping later branches does not
repair an unmapped leftmost branch.

PostgreSQL `int8` and `numeric` commonly arrive from `pg` as strings to avoid
precision loss. Use `pgInt8ToSafeIntegerDecoder` only when the value is required
to fit a JavaScript safe integer, and `pgInt8ToBigIntDecoder` when lossless
integer precision is required. Do not coerce arbitrary `numeric` values with
`Number` unless the domain contract explicitly permits the resulting precision;
use a dedicated decoder that preserves or validates the required representation.

### Builder-First SQL Construction

For each expression or statement, use the first applicable option that
preserves or strengthens its complete database contract:

1. Use a schema column directly when its decoder, nullability, alias, and
   encoder are already correct.
2. Use an exact helper exported by the installed Drizzle version.
3. Use a complete schema-aware read or write builder when it preserves the
   whole statement contract.
4. Replace independently supported leaves with typed helpers inside an
   otherwise irreducible PostgreSQL expression or statement.
5. Use parameterized `sql`, or the `SQL` type without a result generic, when no
   equal installed API exists.

`api/prefer-drizzle-apis` deliberately reports only exact replacements in
conventional, type-correct code. PostgreSQL parser acceptance proves syntax,
not semantic equivalence. A capability must resolve real Drizzle symbols,
source and column provenance, interpolation roles, installed API support, and
every conventional source variant that it claims to cover. Unsupported syntax,
indirect or ambiguous flow, types the analyzer cannot prove, and unproven
semantics remain outside that diagnostic and may retain parameterized SQL,
subject to the interpolation rules below. A clean lint run means that no
implemented capability matched; it does not prove that every retained tag is
permanently irreducible.

Compose dynamic SQL from tagged `sql` fragments so interpolated values remain
driver parameters. `sql.raw(...)` bypasses parameter binding and is prohibited
in API source except for the local development seed script. Raw SQL used only
as a predicate, join condition, ordering or grouping expression, write value,
discarded command, or `rowCount` command result does not produce a structured
field and needs no result decoder. If a write query adds `.returning({...})`,
map raw SQL in the returned fields independently of `.set({...})`. Likewise,
raw SQL passed to `insert(...).select(...)` is the write source rather than a
returned field; only a subsequent `returning(...)` introduces a result-mapping
boundary.

Use typed operators such as `eq`, `gt`, `isNull`, `isNotNull`, `not`, `exists`,
and `notExists` instead of an equivalent SQL tag. Use `like`, `notLike`,
`ilike`, and `notIlike` for dynamic pattern leaves, and `between` /
`notBetween` for exact range leaves. These helpers make the operation explicit
and, when supported, preserve the schema relationship between a column and its
bound value. Pass value arrays directly to `inArray(column, values)` or
`notInArray(column, values)`; do not rebuild parameter lists with
`sql.join(...)`. Use `asc(...)` and `desc(...)` for ordering leaves. Use
`arrayContains(...)`, `arrayContained(...)`, or `arrayOverlaps(...)` only when
the left operand is statically array-valued and the right operand preserves the
intended array encoding or is an explicit SQL wrapper.

Likewise, use `count()`, `count(...)`, `countDistinct(...)`, `avg(...)`,
`avgDistinct(...)`, `sum(...)`, `sumDistinct(...)`, `max(...)`, or `min(...)`
for an exact aggregate leaf. Use the helper directly at a structured selection
boundary when its decoder owns an equal-or-stronger result contract. When the
leaf remains inside otherwise irreducible SQL, interpolate the helper while
keeping an existing outer SQL cast, `FILTER`, `COALESCE`, alias, row schema, and
`.mapWith(...)` that owns the selected result. Do not replace a whole aggregate
when the helper's decoder would weaken a non-column result. Keep literal
predicates as literals when changing them into helper arguments would introduce
a parameter and alter planner-visible query shape; a `LIKE ... ESCAPE` suffix
also remains outside the pattern-helper leaf.

This preference also applies to a replaceable leaf inside otherwise irreducible
SQL. Interpolate the typed operator in place of that leaf while retaining the
outer tag for surrounding CTE, CASE, join, filter, cast, grouping, or statement
syntax. Use `and(...)` and `or(...)` for a fixed boolean tree only when its
direct consumer accepts their `SQL | undefined` result; do not use them when
that result would weaken a required concrete `SQL` contract.
Keep SQL syntax that belongs to an operand inside that operand. For example,
write ``gte(events.createdAt, sql`${timestamp}::timestamp`)`` rather than
placing the cast after the interpolated `gte(...)` fragment.

### SQL Conversion Equivalence

Before replacing an SQL tag, verify the complete database contract, including:

- statement and round-trip count;
- generated SQL shape, parameter order and typing, driver bindings, and column
  encoders;
- runtime decoders, nullability, precision, aliases, cardinality, and error
  behavior;
- transaction, snapshot, and statement-clock boundaries;
- locks, atomicity, concurrency behavior, and races;
- planner-visible literals, index selection, normalized plans, buffers, and
  memory; and
- material query-construction, planning, and execution cost.

Require exact generated SQL and ordered parameter representations when
identical serialization is the intended contract. For a deliberate
equivalent-syntax rewrite, compare the generated SQL and parameters, verify
integration and database behavior, and inspect plans and resource use when they
can materially change. Equal returned rows alone do not establish equivalence.

Installed-version gaps such as database clocks, `COALESCE`, scalar `GREATEST`,
JSONB operations, `EXCLUDED`, `DELETE ... USING`, no-`FROM` commands, and
materialized or data-modifying CTEs are review examples, not permanent
exemptions. Reevaluate them after Drizzle upgrades. Moving raw SQL into a
project helper is not a builder conversion unless the helper adds a stronger
static or runtime contract.

Every remaining SQL-tag interpolation must have one unambiguous static role.
Do not interpolate `any`, `unknown`, a value that can be `undefined`, an array or
tuple directly, or a union that mixes an ordinary bound value with an SQL
wrapper. Narrow optional values before constructing SQL. Use `sql.empty()` for
an intentionally empty fragment, `sql.param(...)` when an array or other value
must be one driver parameter, and `sql.join(...)` when composing SQL fragments.
Keep bound values and SQL wrappers as distinct types across helper boundaries.

### Raw Execute Rows

Prefer structured Drizzle selections whenever they can express the query.
Direct `db.execute(...)` is allowed when rows are discarded or only `rowCount`
is consumed. When an irreducible raw query returns rows, execute it in its
owning unit and use the data-only `parseRawRows` decoder from
`turbo/apps/api/src/lib/db-raw-rows.ts`:

```typescript
const query = sql`SELECT id, size_bytes FROM artifacts`;
const rowSchema = z.object({
  id: z.string().uuid(),
  size_bytes: pgInt8ToSafeIntegerSchema,
});
const rows = parseRawRows(rowSchema, await db.execute(query));
```

`parseRawRows` parses every returned driver row with the supplied schema; its
TypeScript output is inferred from that schema. Keep the database or transaction
handle in its owning unit rather than passing it to an executor helper. Use
schema transforms such as `pgInt8ToSafeIntegerSchema`, `pgInt8ToBigIntSchema`,
and `pgTimestampWithoutTimezoneToDateSchema` when the driver representation
differs from the application value. Never replace this boundary with
`execute<Row>`, a typed wrapper around `db.execute`, or a downstream assertion.

Preserve the caller's construction and Promise error boundaries when replacing
an async executor helper. Capture the original receiver, query and schema in
that order at the original lexical position, before invoking an immediate
zero-argument async expression. Keep execution and full parsing inside that
expression, and feed its Promise to the original await, settle or redaction
consumer:

```typescript
const query = buildQuery(input);
const rowSchema = resultRowSchema;
const result = await settle(
  (async () => {
    return parseRawRows(rowSchema, await db.execute(query));
  })(),
);
```

Query/schema construction errors belong to the caller; synchronous execute
method access/call and decoding errors reject the inner Promise. Moving
construction inside that expression expands the consumer's error mapping;
executing or parsing before the consumer bypasses it. Preserve the inner await
layer and surrounding timing, cancellation and result handling. Immediately
invoke the expression without handle arguments; never store, pass, return,
register or detach it.
