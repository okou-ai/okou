import {
  parseTransactionDirective,
  transactionVisitors,
} from "../transaction-policy.ts";
import { createRule } from "../utils.ts";

export const dbTransactionExemptions = createRule({
  name: "db-transaction-exemptions",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Require narrow next-line transaction exemptions with legacy IDs or billing necessity",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: { invalid: "{{reason}}" },
  },
  create(context) {
    const lines = new Map<number, number>();
    const visitor = transactionVisitors(
      context.sourceCode,
      context.filename,
      (node) => {
        lines.set(
          node.loc.start.line,
          (lines.get(node.loc.start.line) ?? 0) + 1,
        );
      },
    );
    return {
      ...visitor,
      "Program:exit"(): void {
        const ids = new Set<string>();
        for (const comment of context.sourceCode.getAllComments()) {
          try {
            const exemption = parseTransactionDirective(comment);
            if (!exemption) continue;
            if (lines.get(comment.loc.end.line + 1) !== 1)
              throw new Error(
                "A transaction exemption must cover exactly one detected transaction on the next line.",
              );
            if (exemption.kind === "legacy") {
              if (ids.has(exemption.id))
                throw new Error(`${exemption.id} is duplicated in this file.`);
              ids.add(exemption.id);
            }
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            context.report({
              loc: comment.loc,
              messageId: "invalid",
              data: { reason: error.message },
            });
          }
        }
      },
    };
  },
});
