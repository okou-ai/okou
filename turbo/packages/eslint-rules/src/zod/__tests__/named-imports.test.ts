import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { namedZodImports } from "../named-imports.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester();
const error = {
  messageId: "aggregateImport" as const,
  data: {
    documentationUrl:
      "https://github.com/okou-ai/okou/blob/main/docs/zod-imports.md",
  },
};

tester.run("named-imports", namedZodImports, {
  valid: [
    'import { object, string } from "zod"; object({ name: string() });',
    'import { object as zObject, string as zString } from "zod"; const object = zObject({ name: zString() });',
    'import { string as z } from "zod"; z();',
    'import { enum as zEnum, instanceof as zInstanceOf } from "zod";',
    'import { coerce, type ZodType } from "zod"; const schema: ZodType = coerce.number();',
    'import type { infer as Infer, output as Output, ZodType } from "zod"; type Value = Infer<ZodType>;',
    'import { type ZodType, type infer as Infer } from "zod/v4";',
    'import type { $ZodIssue } from "zod/v4/core";',
    'import { object, string } from "zod/mini";',
    'import en from "zod/v4/locales/en.js"; en();',
    'import { default as en } from "zod/v4/locales/en.js"; en();',
    'import * as schema from "other-validator";',
    'import { z } from "zod-extra";',
    'import { z } from "./zod";',
    {
      filename: "schema.tsx",
      code: 'import { string } from "zod"; const label = <span>{string().parse("name")}</span>;',
    },
  ],
  invalid: [
    {
      code: 'import { z } from "zod"; z.object({ name: z.string() });',
      errors: [error],
    },
    {
      code: 'import { z as schema } from "zod"; schema.string();',
      errors: [error],
    },
    {
      code: 'import { "z" as schema } from "zod";',
      errors: [error],
    },
    {
      code: 'import * as z from "zod";',
      errors: [error],
    },
    {
      code: 'import * as validator from "zod/v4"; validator.coerce.number();',
      errors: [error],
    },
    {
      code: 'import * as mini from "zod/mini";',
      errors: [error],
    },
    {
      code: 'import schema from "zod";',
      errors: [error],
    },
    {
      code: 'import { default as schema } from "zod/v4";',
      errors: [error],
    },
    {
      code: 'import type { z } from "zod"; type Value = z.infer<typeof schema>;',
      errors: [error],
    },
    {
      code: 'import { type z as schema } from "zod"; type Issue = schema.core.$ZodIssue;',
      errors: [error],
    },
    {
      code: 'import type * as types from "zod"; type Schema = types.ZodType;',
      errors: [error],
    },
    {
      code: 'import { string, z as schema, type ZodType } from "zod";',
      errors: [error],
    },
    {
      filename: "schema.tsx",
      code: 'import { z } from "zod"; const label = <span>{z.string().parse("name")}</span>;',
      errors: [error],
    },
  ],
});
