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

## Frozen Legacy Inventory

The initial inventory is frozen at main `b73d44a9a9e52185c50f968ced4f5cfb12584093`, on 2026-10-09. `turbo/db-transaction-baseline.json` registers each detected site with a unique ID, repository-relative file, named owner and SHA-256 AST fingerprint.

Each existing boundary has this next-line marker:

```ts
// eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0001; new non-billing transactions are prohibited.
await db.transaction(async (tx) => {
  // Existing work, not authorization for expanded transactional behavior.
});
```

Place the marker immediately above the reported method/property or SQL literal line, including on a multiline method chain. In standalone SQL, use `-- eslint-disable-next-line ...` immediately before the opening statement.

The fingerprint includes the invocation's arguments and inline callback body. It excludes source locations, comments, and literal quoting. Formatting and inserted lines do not invalidate a TypeScript site. Changing the callback AST, receiver, arguments, owner or file does. SQL fingerprints use the parsed file AST without statement/source offsets; formatting and SQL comments do not change the fingerprint. Fingerprints identify static syntax, not semantic equivalence.

The `lint-eslint` CI job runs the independent collector with inline configuration disabled. It checks:

1. Every detected transaction has a valid, single-boundary legacy or billing exemption.
2. A legacy ID is used once, and its file, owner and fingerprint match.
3. Every retained inventory entry is still used; removing or converting a transaction requires deleting its legacy marker and inventory row.
4. The PR inventory is a subset of the inventory read from the event's **base/main commit**, with no added IDs or modified records. Total transaction counts are not an authorization check.

The enabling PR reconstructs its allowed inventory from the pinned main source revision above, not from its own source or JSON. Once enforcement is present on main, a missing inventory is an error; bootstrap cannot be used to restore deleted IDs. PR and merge-group checks supply their captured base SHA and fetch the required commits, rather than trusting the candidate manifest alone.

The inventory is deletion-only. Do not regenerate it, change IDs, move entries, or update fingerprints to make a change pass. Remove the non-billing transaction using a correct transaction-free design, or replace the legacy waiver with a genuinely necessary billing exception. Inline-body edits that change its AST intentionally require this policy decision rather than automatic grandfathering. Legacy entries include billing and non-billing sites: registration is not a necessity review or a declaration of correctness.

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

For the enabling PR, also fetch the pinned bootstrap revision. Stage file deletions before running the Git-backed scan. This command is intentionally not a baseline-update command.

This is a static policy guard, not a runtime/data-flow proof. Arbitrary reflection, dynamically generated property names or SQL, cross-file callable aliases, external callback bodies, and new callers of old transaction-opening helpers still require review. Do not evade the policy through those paths. Recreating identical syntax in the same owner or changing surrounding control flow can preserve a fingerprint and also requires review. CI workflow/rule/scanner changes themselves require review; the inventory check is not an immutable security boundary against rewriting its enforcement code. Preserve authorization, concurrency, idempotency, cleanup and financial correctness when removing transactions.
