import { RuleTester } from "@typescript-eslint/rule-tester";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { testControlAllowlist } from "../rules/test-control-allowlist.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester();

const timeModule = join(process.cwd(), "src/lib/time.ts");
const otherModule = join(process.cwd(), "src/lib/other.ts");
const routeTest = join(
  process.cwd(),
  "src/signals/routes/__tests__/agents.test.ts",
);
const options = [
  {
    controls: [
      {
        file: "src/lib/time.ts",
        exports: ["withMockNowForTest"],
        reason: "Scoped application clock.",
      },
    ],
  },
] as const;

tester.run("test-control-allowlist", testControlAllowlist, {
  valid: [
    {
      filename: timeModule,
      code: "export async function withMockNowForTest() {}",
      options,
    },
    {
      filename: otherModule,
      code: "export function regularExport() {}",
      options,
    },
    {
      filename: routeTest,
      code: 'import { withMockNowForTest } from "../../../lib/time.ts";',
      options,
    },
    {
      filename: routeTest,
      code: 'import { encryptSecretForTests } from "./helpers/encrypt-secret";',
      options,
    },
  ],
  invalid: [
    {
      filename: timeModule,
      code: "export function freezeClockForTests() {}",
      options,
      errors: [
        { messageId: "unlistedExport", data: { name: "freezeClockForTests" } },
      ],
    },
    {
      filename: otherModule,
      code: "const resetForTest = () => {}; export { resetForTest };",
      options,
      errors: [{ messageId: "unlistedExport" }],
    },
    {
      filename: otherModule,
      code: "export const seedForTest = () => {};",
      options,
      errors: [{ messageId: "unlistedExport" }],
    },
    {
      filename: routeTest,
      code: 'import { resetCacheForTest } from "../../../lib/other";',
      options,
      errors: [
        {
          messageId: "unlistedImport",
          data: { name: "resetCacheForTest", specifier: "../../../lib/other" },
        },
      ],
    },
    {
      filename: routeTest,
      code: 'import { withNowScopeForTest } from "../../../lib/time";',
      options,
      errors: [{ messageId: "unlistedImport" }],
    },
  ],
});
