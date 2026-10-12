import { RuleTester } from "@typescript-eslint/rule-tester";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { noTestCredentialForging } from "../rules/no-test-credential-forging.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester();

const legacy = join(
  process.cwd(),
  "src/signals/routes/__tests__/legacy.test.ts",
);
const fresh = join(process.cwd(), "src/signals/routes/__tests__/fresh.test.ts");
const options = [
  { legacyConsumers: ["src/signals/routes/__tests__/legacy.test.ts"] },
] as const;

tester.run("no-test-credential-forging", noTestCredentialForging, {
  valid: [
    {
      filename: legacy,
      code: 'import { signSandboxJwtForTests } from "../../auth/tokens";',
      options,
    },
    {
      filename: fresh,
      code: 'import { createRunnerFixture } from "./helpers/api-bdd";',
      options,
    },
  ],
  invalid: [
    {
      filename: fresh,
      code: 'import { signSandboxJwtForTests } from "../../auth/tokens";',
      options,
      errors: [
        { messageId: "forged", data: { name: "signSandboxJwtForTests" } },
      ],
    },
    {
      filename: fresh,
      code: 'import { signPatJwtForTests as sign } from "../../auth/tokens";',
      options,
      errors: [{ messageId: "forged" }],
    },
    {
      filename: fresh,
      code: 'import * as tokens from "../../auth/tokens"; tokens.generateSandboxToken("run");',
      options,
      errors: [{ messageId: "forged", data: { name: "generateSandboxToken" } }],
    },
    {
      filename: fresh,
      code: 'const { verifyOkouToken } = await import("../../auth/tokens");',
      options,
      errors: [{ messageId: "forged", data: { name: "verifyOkouToken" } }],
    },
    {
      filename: fresh,
      code: 'export { encryptSecretForTests } from "./helpers/encrypt-secret";',
      options,
      errors: [{ messageId: "forged" }],
    },
    {
      filename: fresh,
      code: 'import { signSkillImportJwtForTests } from "../../auth/tokens";',
      errors: [{ messageId: "forged" }],
    },
  ],
});
