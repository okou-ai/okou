import { TSESLint } from "@typescript-eslint/utils";
import tseslint from "typescript-eslint";

import { dbTransactionExemptions } from "./rules/db-transaction-exemptions.ts";
import { transactionSqlParser } from "./sql-analysis/transaction-statements.ts";
import {
  describeTransactionSite,
  parseTransactionDirective,
  transactionVisitors,
  type TransactionExemption,
  type TransactionSite,
} from "./transaction-policy.ts";
import { createRule } from "./utils.ts";

export interface ScannedTransaction {
  readonly site: TransactionSite;
  readonly exemption?: TransactionExemption;
}

export async function scanTransactionSources(
  sources: readonly { file: string; code: string }[],
  cwd: string,
): Promise<ScannedTransaction[]> {
  const found: ScannedTransaction[] = [];
  const collector = createRule({
    name: "collect-db-transactions",
    defaultOptions: [],
    meta: {
      type: "problem",
      docs: {
        description:
          "Collect transaction sites independently of inline exemptions",
        requiresTypeChecking: false,
      },
      schema: [],
      messages: {},
    },
    create(context) {
      return transactionVisitors(
        context.sourceCode,
        context.filename,
        (node, fingerprintNode) => {
          const file = context.filename
            .slice(cwd.length + 1)
            .replaceAll("\\", "/");
          const site = describeTransactionSite(
            context.sourceCode,
            file,
            node,
            fingerprintNode,
          );
          const comment = context.sourceCode
            .getAllComments()
            .find((entry) => entry.loc.end.line === site.line - 1);
          found.push({
            site,
            exemption: comment ? parseTransactionDirective(comment) : undefined,
          });
        },
      );
    },
  });
  const eslint = new TSESLint.FlatESLint({
    cwd,
    overrideConfigFile: true,
    // Unlike a regular package lint, this collector cannot be suppressed,
    // including by disabling the exemption-validation rule itself.
    allowInlineConfig: false,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx,js,mjs,cjs}"],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
      },
      {
        files: ["**/*.sql"],
        languageOptions: { parser: transactionSqlParser },
      },
      {
        files: ["**/*.{ts,tsx,js,mjs,cjs,sql}"],
        plugins: {
          api: {
            rules: {
              "collect-db-transactions": collector,
              "db-transaction-exemptions": dbTransactionExemptions,
            },
          },
        },
        rules: {
          "api/collect-db-transactions": "error",
          "api/db-transaction-exemptions": "error",
        },
      },
    ],
  });
  for (const { file, code } of sources) {
    const [result] = await eslint.lintText(code, { filePath: file });
    if (!result || result.messages.length) {
      throw new Error(
        `${file}: ${result?.messages.map((message) => `${message.line}:${message.column} ${message.message}`).join("\n") ?? "source was not scanned"}`,
      );
    }
  }
  return found;
}
