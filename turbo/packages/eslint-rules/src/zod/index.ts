import { namedZodImports } from "./named-imports.ts";

export const namedZodImportsConfig = {
  files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
  plugins: {
    zod: {
      rules: {
        "named-imports": namedZodImports,
      },
    },
  },
  rules: {
    "zod/named-imports": "error" as const,
  },
};
