import { join } from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { noTestPrivateAccess } from "../rules/no-test-private-access.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester();

const routeTest = join(
  process.cwd(),
  "src/signals/routes/__tests__/agents.test.ts",
);
const helper = join(
  process.cwd(),
  "src/signals/routes/__tests__/helpers/api-bdd.ts",
);
const testContext = join(process.cwd(), "src/__tests__/test-context.ts");
const infrastructure = [
  {
    file: "src/__tests__/test-context.ts",
    kinds: ["db-handle" as const],
    reason: "Owns connection-pool teardown.",
  },
];

tester.run("no-test-private-access", noTestPrivateAccess, {
  valid: [
    {
      filename: routeTest,
      code: 'import { setupApp } from "../../../__tests__/test-helpers";',
    },
    {
      filename: routeTest,
      code: 'import { agentsRoutes } from "../agents";',
    },
    {
      filename: routeTest,
      code: 'import { now } from "../../../lib/time";',
    },
    {
      filename: testContext,
      code: 'import { closeDb } from "../lib/db";',
      options: [{ infrastructure }],
    },
  ],
  invalid: [
    {
      filename: routeTest,
      code: 'import { agents } from "@okouai/db/schema";',
      errors: [
        {
          messageId: "privateAccess",
          data: { kind: "db-package", specifier: "@okouai/db/schema" },
        },
      ],
    },
    {
      filename: routeTest,
      code: 'import type { Db } from "@okouai/db";',
      errors: [{ messageId: "privateAccess" }],
    },
    {
      filename: routeTest,
      code: 'import { sql } from "drizzle-orm";',
      errors: [
        {
          messageId: "privateAccess",
          data: { kind: "db-driver", specifier: "drizzle-orm" },
        },
      ],
    },
    {
      filename: helper,
      code: 'import pg from "pg";',
      errors: [{ messageId: "privateAccess" }],
    },
    {
      filename: routeTest,
      code: 'import { db } from "../../external/db.ts";',
      errors: [
        {
          messageId: "privateAccess",
          data: { kind: "db-handle", specifier: "../../external/db.ts" },
        },
      ],
    },
    {
      filename: routeTest,
      code: 'export { db } from "../../../lib/db";',
      errors: [{ messageId: "privateAccess" }],
    },
    {
      filename: helper,
      code: 'const service = await import("../../../services/agents.service");',
      errors: [
        {
          messageId: "privateAccess",
          data: {
            kind: "service",
            specifier: "../../../services/agents.service",
          },
        },
      ],
    },
    {
      filename: routeTest,
      code: 'type Service = typeof import("../../services/agents.service");',
      errors: [{ messageId: "privateAccess" }],
    },
    {
      filename: routeTest,
      code: 'vi.mock("../../services/agents.service");',
      errors: [{ messageId: "privateAccess" }],
    },
    {
      filename: routeTest,
      code: 'import { agentRun$ } from "../../computed/agent-run";',
      errors: [
        {
          messageId: "privateAccess",
          data: {
            kind: "internal-signal",
            specifier: "../../computed/agent-run",
          },
        },
      ],
    },
    {
      filename: routeTest,
      code: 'import { startRun$ } from "../../commands/start-run";',
      errors: [{ messageId: "privateAccess" }],
    },
    {
      filename: testContext,
      code: 'import { closeDb } from "../lib/db"; import pg from "pg";',
      options: [{ infrastructure }],
      errors: [
        {
          messageId: "privateAccess",
          data: { kind: "db-driver", specifier: "pg" },
        },
      ],
    },
  ],
});
