import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noNewAdvisoryLock } from "../rules/no-new-advisory-lock.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-new-advisory-lock", noNewAdvisoryLock, {
  valid: [
    "const key = 'pg_advisory_xact_lock';",
    "// pg_advisory_xact_lock(123) is not executable SQL",
    "const query = sql`SELECT pg_try_advisory_xact_lock_shared `;",
    "const query = sql`SELECT hashtext(${orgId})`;",
  ],
  invalid: [
    ...[
      "pg_advisory_lock",
      "pg_try_advisory_lock_shared",
      "pg_advisory_xact_lock",
      "pg_advisory_xact_lock_shared",
      "pg_try_advisory_xact_lock",
      "pg_try_advisory_xact_lock_shared",
      "pg_advisory_unlock",
      "pg_advisory_unlock_all",
    ].map((functionName) => ({
      name: `blocks ${functionName}`,
      code: `const query = sql\`SELECT ${functionName}(hashtext(\${orgId}))\`;`,
      errors: [{ messageId: "advisoryLock" as const }],
    })),
    {
      name: "blocks multiline interpolated SQL",
      code: "const query = sql`SELECT\\n  pg_advisory_xact_lock(\\n    hashtext(${orgId}))`;",
      errors: [{ messageId: "advisoryLock" }],
    },
    {
      name: "blocks case-insensitive SQL in a string literal",
      code: 'const query = "select PG_ADVISORY_LOCK(42)";',
      errors: [{ messageId: "advisoryLock" }],
    },
    {
      name: "blocks PostgreSQL advisory locks in raw template literals",
      code: "const query = `SELECT pg_advisory_xact_lock(42)`;",
      errors: [{ messageId: "advisoryLock" }],
    },
  ],
});
