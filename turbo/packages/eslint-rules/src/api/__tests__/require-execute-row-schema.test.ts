import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { requireExecuteRowSchema } from "../rules/require-execute-row-schema.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const drizzlePreamble = `
    type DrizzleDatabase =
      import("drizzle-orm/node-postgres").NodePgDatabase;
    declare const db: DrizzleDatabase;
    declare const database: DrizzleDatabase;
    declare const executor: DrizzleDatabase;
    declare const tx: DrizzleDatabase;
`;

ruleTester.run("require-execute-row-schema", requireExecuteRowSchema, {
  valid: [
    {
      code: `${drizzlePreamble}
        import { parseRawRows } from "../../lib/db-raw-rows";
        const rows = parseRawRows(rowSchema, await tx.execute(query));
      `,
    },
    {
      code: `${drizzlePreamble}
        import { parseRawRows as decode } from "../../lib/db-raw-rows.ts";
        const rows = decode(rowSchema, await tx.execute(query));
      `,
    },
    {
      code: `${drizzlePreamble}
        import * as rows from "../../lib/db-raw-rows";
        const result = rows.parseRawRows(rowSchema, await tx.execute(query));
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(sql\`DELETE FROM jobs\`);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const holder = { query: sql\`DELETE FROM jobs\` };
        await db.execute(holder.query);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const { rowCount } = await db.execute(sql\`DELETE FROM jobs\`);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const { rowCount: deleted } = await db.execute(
          sql\`DELETE FROM jobs\`,
        );
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const { "rowCount": deleted } = await db.execute(
          sql\`DELETE FROM jobs\`,
        );
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const { ["rowCount"]: deleted } = await db.execute(
          sql\`DELETE FROM jobs\`,
        );
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const count = (await db.execute(sql\`DELETE FROM jobs\`)).rowCount;
      `,
    },
    {
      code: `${drizzlePreamble}
        import * as drizzle from "drizzle-orm";
        await tx.execute(drizzle.sql\`SELECT pg_advisory_xact_lock(1)\`);
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        await db.execute(lockQuery());
        function lockQuery() {
          return sql\`SELECT pg_advisory_xact_lock(1)\`;
        }
      `,
    },
    {
      code: `${drizzlePreamble}
        import { commandQuery } from "./command-query";
        const { rowCount } = await db.execute(commandQuery());
      `,
    },
    {
      code: `${drizzlePreamble}
        const result = await client.run<Row>("SELECT 1");
      `,
    },
    {
      code: `${drizzlePreamble}
        interface Client {
          execute<TRow>(query: string): Promise<TRow>;
        }
        declare const client: Client;
        const result = await client.execute<Row>("SELECT 1");
      `,
    },
    {
      code: `${drizzlePreamble}
        interface Contract {
          execute: { path: string };
        }
        declare const contract: Contract;
        const route = contract.execute;
        const path = contract.execute.path;
      `,
    },
    {
      code: `${drizzlePreamble}
        interface Client {
          execute<TRow>(query: string): Promise<TRow>;
        }
        declare const client: Client;
        const { execute: run } = client;
        const result = await run<Row>("SELECT 1");
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const db = {
          execute<T>(_query: unknown): T {
            throw new Error("not implemented");
          },
        };
        const result = db.execute<Row>(sql\`SELECT 1\`);
        void result;
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { db } from "./other/db";
        const result = db.execute<Row>(sql\`SELECT 1\`);
        void result;
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import type { Db } from "@fake/db";
        declare const client: Db;
        const result = client.execute<Row>(sql\`SELECT 1\`);
        void result;
      `,
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        interface Client<TContext> {
          execute<TRow>(query: unknown): TRow;
          readonly context: TContext;
        }
        declare const client: Client<DrizzleDatabase>;
        const result = client.execute<Row>(sql\`SELECT 1\`);
        void result;
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        type Db = { execute<T>(query: unknown): T };
        declare const db: Db;
        const result = db.execute<Row>(sql\`SELECT 1\`);
        void result;
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        declare const client: {
          transaction<T>(callback: (tx: { execute<T>(query: unknown): T }) => T): T;
        };
        client.transaction((tx) => {
          const result = tx.execute<Row>(sql\`SELECT 1\`);
          return result;
        });
      `,
    },
  ],
  invalid: [
    {
      code: `${drizzlePreamble}
        import { parseRawRows } from "./other-decoder";
        parseRawRows(rowSchema, await tx.execute(query));
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { parseRawRows } from "../../lib/db-raw-rows";
        function run(parseRawRows) {
          return parseRawRows(rowSchema, tx.execute(query));
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { parseRawRows } from "../../lib/db-raw-rows";
        async function run(parseRawRows) {
          return parseRawRows(rowSchema, await tx.execute(query));
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { parseRawRows } from "../../lib/db-raw-rows";
        parseRawRows(rowSchema, tx.execute(query));
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { parseRawRows } from "../../lib/db-raw-rows";
        parseRawRows(rowSchema, (await tx.execute(query)).rows);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { parseRawRows } from "../../lib/db-raw-rows";
        parseRawRows(rowSchema, await tx.execute<Row>(query));
      `,
      errors: [{ messageId: "rowTypeArgument" }],
    },
    {
      code: `${drizzlePreamble}
        import { parseRawRows } from "../../lib/db-raw-rows";
        parseRawRows(rowSchema, (await tx.execute(query)) as QueryResult<Row>);
      `,
      errors: [{ messageId: "assertedResult" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        async function query({
          db: database,
        }: {
          readonly db: DrizzleDatabase;
        }) {
          const result = await database.execute(sql\`SELECT 1\`);
          return result;
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        type ExecuteDb = Pick<DrizzleDatabase, "execute">;
        declare const pickedDb: ExecuteDb;
        const result = await pickedDb.execute(sql\`SELECT 1\`);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        declare function createDatabase(): DrizzleDatabase;
        const typedDb: DrizzleDatabase = createDatabase();
        const result = await typedDb.execute(sql\`SELECT 1\`);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { db$, writeDb$ } from "./external/db";
        declare function get(signal: typeof db$): DrizzleDatabase;
        declare const store: {
          set(signal: typeof writeDb$): DrizzleDatabase;
        };
        const first = await get(db$).execute(sql\`SELECT 1\`);
        const second = await store.set(writeDb$).execute(sql\`SELECT 2\`);
      `,
      errors: [{ messageId: "rawResult" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const result = await db.execute<Row>(sql\`SELECT 1 AS value\`);
      `,
      errors: [{ messageId: "rowTypeArgument" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const result = await db.execute(sql\`SELECT 1 AS value\`);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        interface QueryArgs {
          readonly db: DrizzleDatabase;
        }
        async function query(args: QueryArgs) {
          const result = await args.db.execute(sql\`SELECT 1 AS value\`);
          return result;
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        import { db as createDb } from "./lib/db";
        type Database = ReturnType<typeof createDb>;
        declare const database: Database;
        const result = await database.execute(sql\`SELECT 1 AS value\`);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        async function query(args: { readonly db: DrizzleDatabase }) {
          const result = await args.db.execute(sql\`SELECT 1 AS value\`);
          return result;
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const result = await db.execute(sql\`SELECT 1 AS value\`);
        consume(result.rows);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const { rows } = await db.execute(sql\`SELECT 1 AS value\`);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const { rowCount, rows } = await db.execute(
          sql\`DELETE FROM jobs RETURNING id\`,
        );
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const query = sql\`SELECT 1 AS value\`;
        return db.execute(query);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const query = () => sql\`SELECT 1 AS value\`;
        const result = await database.execute(query());
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        function query() {
          return sql\`SELECT 1 AS value\`;
        }
        const result = await database.transaction(async (transaction) => {
          return await transaction.execute(query());
        });
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import type { SQLWrapper } from "drizzle-orm";
        async function unsafe(
          executor: DrizzleDatabase,
          query: SQLWrapper,
        ) {
          const result = await executor.execute(query);
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import type { SQLWrapper as DrizzleQuery } from "drizzle-orm";
        type Query = DrizzleQuery;
        async function unsafe(db: DrizzleDatabase, query: Query) {
          const result = await db.execute<Row>(query);
        }
      `,
      errors: [{ messageId: "rowTypeArgument" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQL } from "drizzle-orm";
        function query(): SQL {
          if (condition) {
            return sql\`SELECT 1 AS value\`;
          }
          return sql\`SELECT 2 AS value\`;
        }
        const rows = (await db.execute(query())).rows;
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import type { SQLWrapper } from "drizzle-orm";
        const result = await db.execute(query as unknown as SQLWrapper);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import type * as drizzle from "drizzle-orm";
        async function unsafe(
          db: DrizzleDatabase,
          query: drizzle.SQLWrapper,
        ) {
          return await db.execute(query);
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql as drizzleSql } from "drizzle-orm";
        const rows = (await tx.execute(drizzleSql.raw("SELECT 1"))).rows;
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const query = condition
          ? sql\`SELECT 1 AS value\`
          : sql\`SELECT 2 AS value\`;
        const result = await tx.execute(query);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const query = sql\`SELECT 1\`.append(sql\` AS value\`);
        const rows = (await tx.execute(query)).rows;
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import * as drizzle from "drizzle-orm";
        const rows = (
          await tx.execute(drizzle.sql\`SELECT 1 AS value\`)
        ).rows;
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        consume(await db.execute(sql\`SELECT 1\`));
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const result = (await db.execute(sql\`SELECT 1\`)) as QueryResult<Row>;
      `,
      errors: [{ messageId: "assertedResult" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const row = (await db.execute(sql\`SELECT 1 AS value\`)).rows[0] as Row;
      `,
      errors: [{ messageId: "assertedResult" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const rows = (await db.execute(sql\`SELECT 1 AS value\`)).rows as Row[];
      `,
      errors: [{ messageId: "assertedResult" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const rowCount = (
          (await db.execute(sql\`DELETE FROM jobs\`)) as QueryResult
        ).rowCount;
      `,
      errors: [{ messageId: "assertedResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        await db.execute<Row>(sql\`DELETE FROM jobs\`);
      `,
      errors: [{ messageId: "rowTypeArgument" }],
    },
    {
      code: `${drizzlePreamble}
        const result = await db.execute(sql\`SELECT 1\`);
        import { sql } from "drizzle-orm";
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const holder = { query: sql\`SELECT NOW() AS value\` };
        const result = await db.execute<Row>(holder.query);
      `,
      errors: [{ messageId: "rowTypeArgument" }, { messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql } from "drizzle-orm";
        const queries = [sql\`SELECT 1 AS value\`];
        const result = await db.execute(queries[0]);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { sql, type SQLWrapper } from "drizzle-orm";
        const holder = {
          query(): SQLWrapper {
            return sql\`SELECT 1 AS value\`;
          },
        };
        return await db.execute(holder.query());
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import { importedQuery } from "./query";
        const result = await db.execute(importedQuery());
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import type { SQLWrapper } from "drizzle-orm";
        interface Query extends SQLWrapper {}
        async function unsafe(db: DrizzleDatabase, query: Query) {
          return await db.execute(query);
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        import type { SQLWrapper } from "drizzle-orm";
        type Query = Readonly<SQLWrapper>;
        async function unsafe(db: DrizzleDatabase, query: Query) {
          const result = await db.execute(query);
        }
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        const result = await db["execute"](query);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        const result = await db.ex\\u0065cute(query);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        const result = await db["e\\x78ecute"](query);
      `,
      errors: [{ messageId: "rawResult" }],
    },
    {
      code: `${drizzlePreamble}
        const execute = db.execute.bind(db);
      `,
      errors: [{ messageId: "executeReference" }],
    },
    {
      code: `${drizzlePreamble}
        const { execute: run } = db;
      `,
      errors: [{ messageId: "executeReference" }],
    },
    {
      code: `${drizzlePreamble}
        const { ["e\\x78ecute"]: run } = db;
      `,
      errors: [{ messageId: "executeReference" }],
    },
  ],
});
