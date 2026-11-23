import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { preferDrizzleApis } from "../rules/prefer-drizzle-apis.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const runtimeThreadModule = "@okouai/db/runtime/chat-thread";

const preamble = `
  import { integer, pgTable, text } from "drizzle-orm/pg-core";

  const users = pgTable("users", {
    id: integer("id").notNull(),
    name: text("name").notNull(),
    tags: text("tags").array().notNull(),
  });
  type Db = import("drizzle-orm/node-postgres").NodePgDatabase;
  declare const db: Db;
`;

ruleTester.run("prefer-drizzle-apis", preferDrizzleApis, {
  valid: [
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        const left = 1;
        const right = 2;
        declare const singleId: number;
        sql\`\${left} = \${right}\`;
        db.select().from(users).where(sql\`\${users.id} IN (\${singleId})\`);
        db.select().from(users).where(sql\`custom_predicate(\${users.id})\`);
        db.select().from(users).where(sql\`'\${users.id} = \${1}'\`);
        db.select().from(users).where(sql\`/* \${users.id} = \${1} */ true\`);
        db.select().from(users).where(sql\`$body$\${users.id} = \${1}$body$\`);
      `,
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        function deliberateFragment() {
          return sql\`\${users.id} = \${1}\`;
        }
        db.select().from(users).where(deliberateFragment());
      `,
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        db.select({
          name: sql\`\${users.name}\`
            .mapWith(users.name)
            .as("renamed_name"),
          transformed: sql\`upper(\${users.name})\`.mapWith(users.name),
        }).from(users);
        db.select().from(users).leftJoinLateral(
          db.select().from(users).as("selected"),
          sql\`true\`,
        );
        db.select({
          normalized: sql\`lower(\${users.name})\`
            .mapWith(users.name)
            .as("normalized"),
        })
          .from(users)
          .groupBy(sql\`lower(\${users.id})\`);
        const normalized = sql\`lower(\${users.name})\`.mapWith(users.name);
        db.select({ normalized }).from(users).groupBy(normalized);
      `,
    },
    {
      code: `${preamble}
        function sql(strings: TemplateStringsArray, ...values: unknown[]) {
          return { strings, values };
        }
        sql\`\${users.id} = \${1}\`;
        const client = {
          innerJoinLateral(_relation: unknown, _condition: unknown) {},
        };
        client.innerJoinLateral(users, sql\`true\`);
      `,
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        function run() {
          const db = {
            select() {
              return { where(value: unknown) { return value; } };
            },
          };
          db.select().where(sql\`\${users.id} = \${1}\`);
        }
        void run;
      `,
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const rowSchema: unknown;
        await executeRawRows(
          db,
          sql\`SELECT id FROM users WHERE id = \${1}\`,
          rowSchema,
        );
      `,
    },
    {
      code: `${preamble}
        import { eq, sql } from "drizzle-orm";
        import { executeRawRows } from "./other/db-raw-rows";
        declare const rowSchema: unknown;
        await executeRawRows(
          db,
          sql\`
            SELECT \${users.id}
            FROM \${users}
            WHERE \${eq(users.id, 1)}
          \`,
          rowSchema,
        );
      `,
    },
  ],
  invalid: [
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        import { chatThreads as connectors } from "${runtimeThreadModule}";
        db.select().from(connectors).where(sql\`\${connectors.id} = \${"connector-id"}\`);
      `,
      errors: [{ messageId: "typedApi", data: { helper: "eq" } }],
    },
    {
      code: `${preamble}
        import { eq, sql } from "drizzle-orm";
        db.select().from(users).where(sql\`\${users.id} = \${1}\`);
        db.select().from(users).where(sql\`\${users.id} <> \${2}\`);
        db.select().from(users).where(sql\`\${users.id} > \${3}\`);
        db.select().from(users).where(sql\`\${users.id} >= \${4}\`);
        db.select().from(users).where(sql\`\${users.id} < \${5}\`);
        db.select().from(users).where(sql\`\${users.id} <= \${6}\`);
        const selected = db
          .select({ id: users.id })
          .from(users)
          .as("selected_users");
        db.select().from(selected).where(sql\`\${selected.id} = \${7}\`);
        db.select()
          .from(users)
          .leftJoinLateral(selected, eq(selected.id, users.id))
          .where(sql\`\${selected.id} = \${8}\`);
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "ne" } },
        { messageId: "typedApi", data: { helper: "gt" } },
        { messageId: "typedApi", data: { helper: "gte" } },
        { messageId: "typedApi", data: { helper: "lt" } },
        { messageId: "typedApi", data: { helper: "lte" } },
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "eq" } },
      ],
    },
    {
      code: `${preamble}
        import { sql as query } from "drizzle-orm";
        declare function loadIds(): readonly number[];
        const ids: readonly number[] = loadIds();
        db.select().from(users).where(query\`\${users.name} IS NULL\`);
        db.select().from(users).where(query\`\${users.name} IS NOT NULL\`);
        db.select().from(users).where(query\`\${users.name} LIKE \${"a%"}\`);
        db.select().from(users).where(query\`\${users.id} IN (\${ids})\`);
        db.select().from(users).where(query\`\${users.id} BETWEEN \${1} AND \${2}\`);
        db.select().from(users).where(query\`\${users.tags} @> \${["tag"]}\`);
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "isNull" } },
        { messageId: "typedApi", data: { helper: "isNotNull" } },
        { messageId: "typedApi", data: { helper: "like" } },
        { messageId: "typedApi", data: { helper: "inArray" } },
        { messageId: "typedApi", data: { helper: "between" } },
        { messageId: "typedApi", data: { helper: "arrayContains" } },
      ],
    },
    {
      code: `${preamble}
        import * as drizzle from "drizzle-orm";
        const first = drizzle.eq(users.id, 1);
        const second = drizzle.eq(users.id, 2);
        db.select().from(users).where(drizzle.sql\`\${first} AND \${second}\`);
        db.select().from(users).where(drizzle.sql\`NOT \${first}\`);
        db.select().from(users).orderBy(drizzle.sql\`\${users.id} DESC\`);
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "typedApi", data: { helper: "not" } },
        { messageId: "typedApi", data: { helper: "desc" } },
      ],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        db.select({
          count: sql\`COUNT(\${users.id})\`.mapWith(users.id),
          total: sql\`SUM(DISTINCT \${users.id})\`.mapWith(users.id),
          allRows: sql\`COUNT(*)\`.mapWith(users.id),
        }).from(users);
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "count" } },
        { messageId: "typedApi", data: { helper: "sumDistinct" } },
        { messageId: "typedApi", data: { helper: "count" } },
      ],
    },
    {
      code: `${preamble}
        import { eq, sql } from "drizzle-orm";
        db.select().from(users).where(sql\`\`);
        db.select().from(users).where(
          sql.join([eq(users.id, 1), eq(users.id, 2)], sql\` AND \`),
        );
        db.select({
          name: sql\`\${users.name}\`.mapWith(users.name),
        }).from(users);
      `,
      errors: [
        { messageId: "emptyFragment" },
        { messageId: "typedApi", data: { helper: "and" } },
        { messageId: "directColumn" },
      ],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        const selected = db.select().from(users).as("selected");
        db.select().from(users).innerJoin(users, sql\`true\`);
        db.select().from(users).innerJoinLateral(selected, sql\`true\`);
      `,
      errors: [{ messageId: "crossJoin" }, { messageId: "crossJoinLateral" }],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        const recent = db.$with("recent").as(
          db.select({ id: users.id }).from(users),
        );
        const recentAlias = recent;
        db.with(recentAlias)
          .select()
          .from(recentAlias)
          .where(sql\`\${recentAlias.id} = \${1}\`);
        db.query.users.findMany({
          where: (fields, operators) =>
            operators.sql\`\${fields.id} = \${1}\`,
          orderBy: (fields, operators) =>
            operators.sql\`\${fields.id} DESC\`,
        });
      `,
      errors: [
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "eq" } },
        { messageId: "typedApi", data: { helper: "desc" } },
      ],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        await db.transaction(async (tx) => {
          await tx.execute(
            sql\`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ ONLY\`,
          );
        });
      `,
      errors: [{ messageId: "transactionConfig" }],
    },
    {
      code: `${preamble}
        import { eq, sql } from "drizzle-orm";
        import { executeRawRows } from "./lib/db-raw-rows";
        declare const rowSchema: unknown;
        const query = sql\`
          SELECT \${users.id}
          FROM \${users}
          WHERE \${eq(users.id, 1)}
          LIMIT 1
        \`;
        await executeRawRows(db, query, rowSchema);
      `,
      errors: [{ messageId: "queryBuilder" }],
    },
    {
      code: `${preamble}
        import { eq, sql } from "drizzle-orm";
        db.select({
          value: sql\`(
            SELECT \${users.name}
            FROM \${users}
            WHERE \${eq(users.id, 1)}
            LIMIT 1
          )\`.mapWith(users.name),
        });
      `,
      errors: [{ messageId: "structuredScalarQuery" }],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        db.select({
          normalized: sql\`lower(\${users.name})\`
            .mapWith(users.name)
            .as("normalized"),
        })
          .from(users)
          .groupBy(sql\`lower(\${users.name})\`);
        db.select({ id: users.id }).from(users).groupBy(sql\`1\`);
      `,
      errors: [
        { messageId: "unstableGrouping" },
        { messageId: "unstableGrouping" },
      ],
    },
  ],
});
