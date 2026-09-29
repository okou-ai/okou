# Database triggers

`api/no-database-trigger` rejects `CREATE TRIGGER`, `CREATE OR REPLACE TRIGGER`,
`CREATE CONSTRAINT TRIGGER`, and `CREATE EVENT TRIGGER`. Keep write orchestration
explicit in application transactions; use database constraints for invariants.

The rule runs on API and DB production TypeScript strings and templates, and on
DB `.sql` files through the normal ESLint command. Static string concatenations,
comments between SQL keywords, procedure bodies and literal `EXECUTE` statements
are checked. Comments, quoted identifiers, ordinary data strings, and
`DROP TRIGGER` are allowed. The rule neither executes SQL nor interprets SQL
assembled entirely at runtime.

Existing shipped migrations stay unchanged. The DB ESLint configuration lists
the eight historical migration files that created triggers explicitly; new
migrations are checked by default. These historical definitions include triggers
removed by later migrations. CI rejects any edits to these shipped SQL files,
including comment-only changes.

The nine surviving triggers are checked in `EXPECTED_PERMANENT_TRIGGERS` in
`scripts/test-migration-consistency-schema.ts`. Each current definition has one
`eslint-disable-next-line api/no-database-trigger` with the reason:
`Legacy trigger created before 2026-09-29; new database triggers are prohibited.`
Keep these exceptions local to the existing definitions; do not add new ones.
The inventory script is explicitly checked despite the general test exclusion.

Test files and existing fault-injection fixtures may create temporary triggers.
They are excluded in the owning package's ESLint configuration. Production code
must not import those test fixtures.

Run the rule through the existing package ESLint command:

```sh
cd turbo/packages/db
pnpm exec eslint . --max-warnings 0
```
