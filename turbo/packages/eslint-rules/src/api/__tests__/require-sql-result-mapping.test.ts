import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { requireSqlResultMapping } from "../rules/require-sql-result-mapping.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
// Keep the synthetic import out of the repository's real-import boundary scan.
const schemaModule = `@okouai${"/db/schema/user"}`;

const preamble = `
  import { integer, pgTable, text } from "drizzle-orm/pg-core";

  const users = pgTable("users", {
    id: integer("id").notNull(),
    name: text("name").notNull(),
  });
  type Db = import("drizzle-orm/node-postgres").NodePgDatabase;
  declare const db: Db;
`;

ruleTester.run("require-sql-result-mapping", requireSqlResultMapping, {
  valid: [
    {
      code: `${preamble}
        import { chatThreads } from "@okouai${"/db/runtime/chat-thread"}";
        import { sql } from "drizzle-orm";
        db.select({ activeAt: sql\`max(\${chatThreads.lastMessageAt})\`.mapWith(chatThreads.lastMessageAt) }).from(chatThreads);
      `,
    },
    {
      code: `${preamble}
        import { agentRuns } from "@okouai${"/db/runtime/agent-run"}";
        import { sql } from "drizzle-orm";
        db.select({ createdAt: sql\`max(\${agentRuns.createdAt})\`.mapWith(agentRuns.createdAt) }).from(agentRuns);
      `,
    },
    {
      code: `${preamble}
        import { count, sql } from "drizzle-orm";
        db.select({
          id: users.id,
          count: count(users.id),
          normalized: sql\`upper(\${users.name})\`.mapWith(users.name),
        }).from(users);
      `,
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        import {
          nullableDriverValueDecoder,
          pgTextDecoder,
          zodDriverValueDecoder,
        } from "../../apps/api/src/lib/db-structured-result";
        import { z } from "zod";

        const parsed = zodDriverValueDecoder(z.string());
        const nullable = nullableDriverValueDecoder(pgTextDecoder);
        const selection = {
          first: sql\`'first'\`.mapWith(parsed),
          second: sql\`NULL::text\`.mapWith(nullable),
        } as const;
        db.select(selection).from(users);
      `,
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        const selected = db
          .select({ name: users.name })
          .from(users)
          .as("selected_users");
        db.select({
          value: sql\`upper(\${selected.name})\`.mapWith(selected.name),
        }).from(selected);
      `,
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        import * as decoders from
          "../../apps/api/src/lib/db-structured-result";
        db.select({
          value: sql\`'value'\`.mapWith(decoders.pgTextDecoder),
        }).from(users);
      `,
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        db.query.users.findMany({
          extras: (fields) => ({
            normalized: sql\`upper(\${fields.name})\`
              .mapWith(fields.name)
              .as("normalized"),
          }),
        });
      `,
    },
    {
      code: `
        function sql(strings: TemplateStringsArray) {
          return strings;
        }
        const client = { select(_fields: unknown) {} };
        client.select({ value: sql<string>\`value\` });
      `,
    },
    {
      code: `${preamble}
        import { sql, type SQL } from "drizzle-orm";
        const fragment: SQL = sql\`\${users.id} = \${1}\`;
        db.select().from(users).where(fragment);
      `,
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const db = {
          select(_selection: unknown) {
            return undefined;
          },
        };
        db.select({ value: sql\`value\` });
      `,
    },
    {
      code: `
        import { users } from "${schemaModule}";
        type Db = import("drizzle-orm/node-postgres").NodePgDatabase;
        declare const db: Db;
        db.select({ ...users });
      `,
    },
  ],
  invalid: [
    {
      code: `
        import { sql } from "drizzle-orm";
        const value = sql<string>\`value\`;
        void value;
      `,
      errors: [{ messageId: "sqlTypeArgument" }],
    },
    {
      code: `
        import type { SQL } from "drizzle-orm";
        declare const value: SQL<string>;
        void value;
      `,
      errors: [{ messageId: "sqlTypeReference" }],
    },
    {
      code: `
        import type { SQL } from "drizzle-orm";
        declare const value: SQL.Aliased<string>;
        void value;
      `,
      errors: [{ messageId: "sqlTypeReference" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const value = sql\`value\`.as<string>("value");
        void value;
      `,
      errors: [{ messageId: "sqlAliasTypeArgument" }],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        db.select({ value: sql\`upper(\${users.name})\` }).from(users);
        db.selectDistinct({ value: sql\`lower(\${users.name})\` }).from(users);
        db.delete(users).returning({ value: sql\`upper(\${users.name})\` });
      `,
      errors: [
        { messageId: "unmappedResult" },
        { messageId: "unmappedResult" },
        { messageId: "unmappedResult" },
      ],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        const recent = db.$with("recent").as(
          db.select({ id: users.id }).from(users),
        );
        const recentAlias = recent;
        db.with(recentAlias)
          .select({ value: sql\`upper(\${recentAlias.id})\` })
          .from(recentAlias);
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        const fields = {
          value: sql\`upper(\${users.name})\`,
        } as const;
        db.select(fields).from(users);
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        db.query.users.findMany({
          extras: {
            value: sql\`upper(\${users.name})\`.as("value"),
          },
        });
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        db.select({
          value: sql\`upper(\${users.name})\`.mapWith(String),
        }).from(users);
      `,
      errors: [{ messageId: "uninspectableResultDecoder" }],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        import { pgTextDecoder } from "./other/db-structured-result";
        db.select({
          value: sql\`value\`.mapWith(pgTextDecoder),
        }).from(users);
      `,
      errors: [{ messageId: "uninspectableResultDecoder" }],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        import { zodDriverValueDecoder } from
          "../../apps/api/src/lib/db-structured-result";
        declare const schemas: readonly [never];
        db.select({
          value: sql\`value\`.mapWith(zodDriverValueDecoder(...schemas)),
        }).from(users);
      `,
      errors: [{ messageId: "uninspectableResultDecoder" }],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        import { zodDriverValueDecoder } from
          "../../apps/api/src/lib/db-structured-result";
        db.select({
          value: sql\`value\`.mapWith(zodDriverValueDecoder),
        }).from(users);
      `,
      errors: [{ messageId: "uninspectableResultDecoder" }],
    },
    {
      code: `${preamble}
        import { sql } from "drizzle-orm";
        function query(args: { readonly db: Db }) {
          return args.db.select({ value: sql\`value\` });
        }
      `,
      errors: [{ messageId: "unmappedResult" }],
    },
    {
      code: `${preamble}
        declare const fields: Record<string, unknown>;
        db.select(fields).from(users);
      `,
      errors: [{ messageId: "uninspectableResultSelection" }],
    },
    {
      code: `${preamble}
        declare const arguments_: [];
        db.select(...arguments_);
      `,
      errors: [{ messageId: "uninspectableResultArguments" }],
    },
    {
      code: `${preamble}
        const select = db.select;
        void select;
      `,
      errors: [{ messageId: "resultMethodReference" }],
    },
    {
      code: `
        import { sql } from "drizzle-orm";
        const value = sql\`value\` as string;
        void value;
      `,
      errors: [{ messageId: "sqlAssertion" }],
    },
  ],
});
