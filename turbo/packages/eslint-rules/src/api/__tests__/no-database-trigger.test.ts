import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noDatabaseTrigger } from "../rules/no-database-trigger.ts";
import { sqlSourceParser } from "../sql-analysis/sql-source-parser.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const createTrigger =
  "CREATE TRIGGER example BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION capture_item();";

ruleTester.run("no-database-trigger", noDatabaseTrigger, {
  valid: [
    "const query = 'DROP TRIGGER example ON items';",
    "const name = 'trigger_source';",
    "// CREATE TRIGGER example is documentation",
    "const query = sql`SELECT trigger_source FROM agent_runs`;",
    "const query = sql`SELECT 'CREATE TRIGGER example'`;",
    "const query = `SELECT '${\"CREATE TRIGGER example\"}'`;",
    "const query = sql`-- CREATE TRIGGER example\nSELECT 1`;",
    "const query = sql`/* CREATE TRIGGER example */ SELECT 1`;",
  ],
  invalid: [
    {
      name: "a static interpolation reports its assembled SQL once",
      code: 'const query = `${"CREATE TRIGGER example BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION capture_item()"}`;',
      errors: [{ messageId: "databaseTrigger" }],
    },
    {
      name: "SQL string passed to a PostgreSQL client",
      code: `client.query(${JSON.stringify(createTrigger)});`,
      errors: [{ messageId: "databaseTrigger" }],
    },
    {
      name: "Drizzle template with a dynamic trigger identifier",
      code: "db.execute(sql`CREATE TRIGGER ${sql.identifier(name)} BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION capture_item()`);",
      errors: [{ messageId: "databaseTrigger" }],
    },
    {
      name: "cooked newlines in a template",
      code: "const query = sql`CREATE\\nOR\\nREPLACE\\nTRIGGER example BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION capture_item()`;",
      errors: [{ messageId: "databaseTrigger" }],
    },
    {
      name: "static string concatenation cannot hide the keywords",
      code: 'const query = "CREATE " + "TRIGGER example BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION capture_item()";',
      errors: [{ messageId: "databaseTrigger" }],
    },
    {
      name: "unknown concatenated suffix still checks the known SQL",
      code: 'const query = "CREATE TRIGGER example BEFORE INSERT ON items " + suffix;',
      errors: [{ messageId: "databaseTrigger" }],
    },
    {
      name: "interpolation does not erase known CREATE TRIGGER text",
      code: "const query = `CREATE TRIGGER example BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION capture_item()`;",
      errors: [{ messageId: "databaseTrigger" }],
    },
  ],
});

const sqlRuleTester = new RuleTester({
  languageOptions: { parser: sqlSourceParser },
});
const filename = "migration.sql";
sqlRuleTester.run("no-database-trigger SQL", noDatabaseTrigger, {
  valid: [
    "DROP TRIGGER example ON items;",
    "CREATE TABLE items (trigger_source text);",
    "-- CREATE TRIGGER example\nSELECT 1;",
    "/* outer /* nested */ CREATE TRIGGER example */ SELECT 1;",
    "SELECT 'CREATE TRIGGER example', 'it''s CREATE TRIGGER text';",
    'SELECT "CREATE TRIGGER example" FROM items;',
    "SELECT $$CREATE TRIGGER example$$, $data$CREATE TRIGGER example$data$;",
    "SELECT E'escaped \\' CREATE TRIGGER example';",
    "DO $$ BEGIN RAISE NOTICE 'CREATE TRIGGER is data here'; END $$;",
    "DO 'BEGIN RAISE NOTICE ''CREATE TRIGGER is data here''; END';",
  ].map((code) => ({ code, filename })),
  invalid: [
    ...[
      "CREATE TRIGGER",
      "CREATE OR REPLACE TRIGGER",
      "CREATE CONSTRAINT TRIGGER",
      "cReAtE /* comment */ OR -- another comment\n REPLACE TRIGGER",
      "CREATE /* outer /* nested */ comment */ TRIGGER",
    ].map((prefix) => ({
      name: prefix,
      code: `${prefix} example AFTER INSERT ON items FOR EACH ROW EXECUTE FUNCTION capture_item();`,
      filename,
      errors: [{ messageId: "databaseTrigger" as const }],
    })),
    {
      code: "CREATE EVENT TRIGGER example ON ddl_command_end EXECUTE FUNCTION capture_ddl();",
      filename,
      errors: [{ messageId: "databaseTrigger" }],
    },
    {
      name: "each trigger has its own source location",
      code: `-- migration\n${createTrigger}\n\n${createTrigger}`,
      filename,
      errors: [
        { messageId: "databaseTrigger", line: 2, column: 1 },
        { messageId: "databaseTrigger", line: 4, column: 1 },
      ],
    },
    ...[
      `DO $$ BEGIN ${createTrigger} END $$;`,
      `DO LANGUAGE plpgsql $$ BEGIN ${createTrigger} END $$;`,
      `DO LANGUAGE "plpgsql" $$ BEGIN ${createTrigger} END $$;`,
      `DO $migration$ BEGIN EXECUTE '${createTrigger}'; END $migration$;`,
      `DO $$ BEGIN EXECUTE ('${createTrigger}'); END $$;`,
      `DO $$ BEGIN EXECUTE format('${createTrigger}'); END $$;`,
      `DO $$ BEGIN EXECUTE pg_catalog.format('${createTrigger}'); END $$;`,
      "DO $$ BEGIN EXECUTE E'CREATE\\nTRIGGER example BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION capture_item()'; END $$;",
      `CREATE FUNCTION install_trigger() RETURNS void LANGUAGE plpgsql AS $$ BEGIN ${createTrigger} END $$;`,
      `CREATE FUNCTION install_trigger() RETURNS void LANGUAGE plpgsql AS 'BEGIN RAISE NOTICE ''--''; ${createTrigger} END';`,
    ].map((code) => ({
      name: "procedure SQL is executable",
      code,
      filename,
      errors: [{ messageId: "databaseTrigger" as const }],
    })),
  ],
});
