import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { noTestDatabaseBinding } from "../rules/no-test-database-binding.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester();
const suite = "src/signals/routes/__tests__/model-providers.test.ts";

tester.run("no-test-database-binding", noTestDatabaseBinding, {
  valid: [
    {
      filename: "/api/src/test-fixtures/pglite-database.ts",
      code: 'import { PGlite } from "@electric-sql/pglite"; new PGlite();',
    },
    {
      filename:
        "/api/src/signals/routes/__tests__/connector-catalog-immutable.test.ts",
      code: 'import { drizzle } from "drizzle-orm/pglite";',
    },
    {
      code: 'import { withPgliteDatabase } from "../test-fixtures/pglite-database";',
    },
    {
      code: `const isolated = ["${suite}"]; defineConfig({test: {include: isolated}});`,
    },
    {
      code: 'defineConfig({test: {include: ["native-locks.test.ts"], fileParallelism: false}});',
    },
  ],
  invalid: [
    {
      code: 'import { PGlite } from "@electric-sql/pglite";',
      errors: [{ messageId: "harnessOnly" }],
    },
    {
      code: 'import { drizzle } from "drizzle-orm/pglite";',
      errors: [{ messageId: "harnessOnly" }],
    },
    {
      code: 'await import("@electric-sql/pglite");',
      errors: [{ messageId: "harnessOnly" }],
    },
    {
      code: 'await import("@electric-sql/pglite/contrib/pgcrypto");',
      errors: [{ messageId: "harnessOnly" }],
    },
    { code: "new PGlite();", errors: [{ messageId: "harnessOnly" }] },
    {
      code: `const catalog = ["${suite}"]; defineConfig({test: {include: catalog, fileParallelism: false}});`,
      errors: [{ messageId: "serialization" }],
    },
    {
      code: `defineConfig({test: {include: ["${suite}"], sequence: {concurrent: false}}});`,
      errors: [{ messageId: "serialization" }],
    },
    {
      code: `const owned = ["${suite}"]; const combined = [...owned]; defineConfig({test: {include: combined, fileParallelism: false}});`,
      errors: [{ messageId: "serialization" }],
    },
  ],
});
