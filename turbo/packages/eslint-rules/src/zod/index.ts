import { namedZodImports } from "./named-imports.ts";
import { noZodStringFormatMethods } from "./string-format-methods.ts";

export const zodConfig = {
  files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
  plugins: {
    zod: {
      rules: {
        "named-imports": namedZodImports,
        "no-string-format-methods": noZodStringFormatMethods,
      },
    },
  },
  rules: {
    "zod/named-imports": "error" as const,
    "zod/no-string-format-methods": "error" as const,
  },
};
