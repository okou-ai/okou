import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { noZodStringFormatMethods } from "../string-format-methods.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester();
const documentationUrl =
  "https://github.com/okou-ai/okou/blob/main/docs/zod-imports.md#string-formats";

function error(method: string, replacement: string) {
  return {
    messageId: "deprecatedFormat" as const,
    data: { method, replacement, documentationUrl },
  };
}

tester.run("no-string-format-methods", noZodStringFormatMethods, {
  valid: [
    'import { uuid } from "zod"; uuid();',
    'import { iso, url } from "zod"; url(); iso.datetime({ offset: true });',
    'import { string, uuid } from "zod"; string().trim().check(uuid());',
    'import { string } from "zod"; string().min(1).max(10).trim();',
    // Not a Zod string schema.
    'const string = () => ({ uuid: () => "" }); string().uuid();',
    'import { string } from "./local-schema"; string().uuid();',
    'import { url } from "zod"; const browser = { url: (value: string) => value }; browser.url("https://okou.ai");',
    // zod/mini has no chained format methods to forbid.
    'import { string } from "zod/mini"; string().check();',
    // A shadowing binding is not the Zod import.
    'import { string } from "zod"; function build(string: () => { email(): void }) { string().email(); }',
    // Methods outside the deprecated format set.
    'import { string } from "zod"; string().regex(/x/).startsWith("x");',
  ],
  invalid: [
    {
      code: 'import { string } from "zod"; string().uuid();',
      errors: [error("uuid", "uuid")],
    },
    {
      code: 'import { string } from "zod"; string().url().optional();',
      errors: [error("url", "url")],
    },
    {
      code: 'import { string } from "zod"; string().datetime({ offset: true });',
      errors: [error("datetime", "iso.datetime")],
    },
    {
      code: 'import { string } from "zod"; string().date();',
      errors: [error("date", "iso.date")],
    },
    {
      code: 'import { string } from "zod/v4"; string().email("Invalid email");',
      errors: [error("email", "email")],
    },
    {
      code: 'import { string as zString } from "zod"; zString().trim().min(1).uuid();',
      errors: [error("uuid", "uuid")],
    },
    {
      code: 'import { coerce } from "zod"; coerce.string().ipv4();',
      errors: [error("ipv4", "ipv4")],
    },
    {
      code: 'import { string } from "zod"; string().base64().nullable(); string().cuid2();',
      errors: [error("base64", "base64"), error("cuid2", "cuid2")],
    },
  ],
});
