import { transactionVisitors } from "../transaction-policy.ts";
import { createRule } from "../utils.ts";

export const noDbTransaction = createRule({
  name: "no-db-transaction",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Prohibit new database transactions except necessary billing atomicity",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      transaction:
        "New non-billing database transactions are prohibited. Only necessary financial atomicity may use a reviewed next-line billing exception; legacy IDs must match the frozen inventory. See docs/eslint/no-db-transaction.md.",
    },
  },
  create(context) {
    return transactionVisitors(context.sourceCode, context.filename, (node) => {
      context.report({ node, messageId: "transaction" });
    });
  },
});
