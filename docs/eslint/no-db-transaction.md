# Database Transaction Lint

The API [database policy](../api-ccstate.md#10-keep-database-handles-local-and-prefer-atomic-sql) prohibits new explicit non-billing transactions. Billing is not a directory-level exemption: the transaction must directly protect necessary financial correctness and demonstrate why a simple atomic SQL statement is insufficient.

## Enforcement

`api/no-db-transaction` is an error in the API and DB package configurations. It covers production source, scripts, tests and fixtures (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`), and standalone SQL. `api/db-transaction-exemptions` checks exemption syntax and ownership of one detected boundary on the next line. Package lint retains `--max-warnings 0`, with unused directives reported as errors.

Detection includes:

- `.transaction(...)`, `.begin(...)`, `.savepoint(...)`, optional calls, statically computed property names, nested transactions and transaction builders;
- direct `.bind`, `.call`, `.apply`, local callable aliases and callable destructuring; escaping references on recognizable DB handles;
- SQL `BEGIN`, `START TRANSACTION` and `SAVEPOINT` in strings, statically assembled strings, interpolated templates and `.sql` files.

SQL boundaries are recognized using PostgreSQL parsing and statement splitting outside comments, quoted strings/identifiers and dollar bodies. PL/pgSQL `BEGIN` blocks, quoted data, financial `transaction` fields, type references, `COMMIT`, and `ROLLBACK` are not transaction-opening violations. A valid opening statement before invalid trailing SQL remains detectable.

There is no billing-directory, test-directory or new migration exemption. The independent CI scan includes historical DB scripts that normal package lint already ignores; an existing ignored path cannot hide a new transaction.

## Deletion-only Legacy Inventory

`turbo/db-transaction-baseline.json` is a cleanup ledger of existing transaction boundaries. Each entry has a unique ID, repository-relative file and named owner. It does not pin a main revision or fingerprint the transaction's callback, arguments, receiver or SQL body. Existing business code may change while the cleanup proceeds; transaction scope and semantics still require review.

Each existing boundary has this next-line marker:

```ts
// eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0001; new non-billing transactions are prohibited.
await db.transaction(async (tx) => {
  // Existing work; transaction scope and semantics still require review.
});
```

Place the marker immediately above the reported method/property or SQL literal line, including on a multiline method chain. In standalone SQL, use `-- eslint-disable-next-line ...` immediately before the opening statement.

The `lint-eslint` CI job runs the independent collector with inline configuration disabled. It checks:

1. Every detected transaction has a valid, single-boundary legacy or billing exemption.
2. A legacy ID is used once, and its file and owner match.
3. Every retained inventory entry is still used; removing or converting a transaction requires deleting its legacy marker and inventory row.
4. The PR inventory is a subset of the inventory read from the event's **base/main commit**, with no added IDs or modified records. Total transaction counts are not an authorization check.

For initial activation only, the collector reads the supplied base/main source and verifies that registrations for each file and owner do not exceed its existing transaction boundaries. It does not trust the candidate ledger to authorize additional boundaries. Once enforcement is present on main, a missing inventory is an error; bootstrap cannot be used to restore deleted IDs. PR and merge-group checks supply their captured base SHA, and the lint checkout uses the event commit so reruns do not silently select a newer merge ref.

After activation, the inventory is deletion-only. Do not regenerate it, add or reuse IDs, or change an entry's file or owner to make a change pass. Removing a non-billing transaction or converting a necessary billing transaction requires deleting its legacy marker and ledger row. Callback edits do not require ledger updates. Legacy entries include billing and non-billing sites: registration is not a necessity review or a declaration of correctness.

## Necessary Billing Exceptions

A new necessary billing transaction uses a distinct explanation, not a legacy ID:

```ts
// eslint-disable-next-line api/no-db-transaction -- Billing atomicity: ledger debit and wallet balance update must commit together; single-statement alternative: independently validated writes cannot be safely expressed as one simple atomic statement.
await db.transaction(async (tx) => {
  // Only the financial writes covered by the invariant.
});
```

The comment must disable **only** `api/no-db-transaction`, on **the next line**, and include both the financial invariant and why a single-statement alternative is insufficient. File/block disables, `disable-line`, rule-less disables, multiple-rule exemptions, duplicate IDs, vague `billing` reasons and unused directives are rejected. These comments are the narrow exception to the repository's suppression prohibition; unrelated suppressions remain prohibited.

Lint validates the declaration, not the truth of its financial justification. Reviewers must reject unnecessary wrappers, entitlement checks presented as billing atomicity, unrelated business writes, external I/O, and copied boilerplate that does not explain the actual invariant.

## Local Verification and Limits

From `turbo/`, fetch the relevant base/main revision and run:

```sh
pnpm lint:transactions <full-base-main-sha>
```

Stage file deletions before running the Git-backed scan. This command is intentionally not a baseline-update command.

This is a static policy guard, not a runtime/data-flow proof. It rejects extra detected boundaries and unregistered, copied, moved or resurrected IDs. It intentionally allows an existing callback's business logic to change. Replacing a boundary within the same file and owner while transferring its sole ID cannot be distinguished from an edit; review must reject using that limitation to introduce a new transaction. Expanded transaction scope, external I/O, surrounding control flow, arbitrary reflection, dynamically generated property names or SQL, cross-file callable aliases, external callback bodies and new callers of old transaction-opening helpers also require review. CI workflow/rule/scanner changes themselves require review. Preserve authorization, concurrency, idempotency, cleanup and financial correctness when removing transactions.
