import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { expect, test } from "vitest";

const dbRoot = fileURLToPath(new URL("../../../../db/", import.meta.url));
const apiRoot = fileURLToPath(
  new URL("../../../../../apps/api/", import.meta.url),
);
const trigger =
  "CREATE TRIGGER example BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION capture_item();";
const ruleId = "api/no-database-trigger";

test("the real DB config rejects new SQL migrations at the SQL source line", async () => {
  const eslint = new ESLint({ cwd: dbRoot });
  const [result] = await eslint.lintText(`-- new migration\n${trigger}`, {
    filePath: "src/migrations/9999_new_trigger.sql",
  });
  expect(result.messages).toEqual([
    expect.objectContaining({ ruleId, severity: 2, line: 2, column: 1 }),
  ]);
});

test("only named shipped migrations are exempt", async () => {
  const eslint = new ESLint({ cwd: dbRoot });
  const [historical] = await eslint.lintText(trigger, {
    filePath: "src/migrations/1119_billing_attribution_capture.sql",
  });
  expect(historical.messages).toEqual([]);
  const [renamed] = await eslint.lintText(trigger, {
    filePath: "src/migrations/1119_another_trigger.sql",
  });
  expect(renamed.messages).toEqual([
    expect.objectContaining({ ruleId, severity: 2 }),
  ]);
});

test("the DB SQL config allows trigger removal and definition comparison strings", async () => {
  const eslint = new ESLint({ cwd: dbRoot });
  const [result] = await eslint.lintText(
    `DROP TRIGGER example ON items;\nSELECT '${trigger}';`,
    { filePath: "src/migrations/9999_retire_trigger.sql" },
  );
  expect(result.messages).toEqual([]);
});

test.each([
  {
    cwd: dbRoot,
    production: "scripts/install-trigger.ts",
    fixture: "scripts/test-trigger.ts",
  },
  {
    cwd: apiRoot,
    production: "src/lib/install-trigger.ts",
    fixture: "src/test-fixtures/trigger.ts",
  },
])(
  "$production rejects trigger SQL while its test fixture stays allowed",
  async ({ cwd, production, fixture }) => {
    const eslint = new ESLint({ cwd });
    const code = `export const triggerSql = ${JSON.stringify(trigger)};`;
    const [blocked] = await eslint.lintText(code, { filePath: production });
    expect(
      blocked.messages.filter((message) => message.ruleId === ruleId),
    ).toEqual([expect.objectContaining({ ruleId, severity: 2 })]);
    const [allowed] = await eslint.lintText(code, { filePath: fixture });
    expect(
      allowed.messages.filter((message) => message.ruleId === ruleId),
    ).toEqual([]);
  },
);
