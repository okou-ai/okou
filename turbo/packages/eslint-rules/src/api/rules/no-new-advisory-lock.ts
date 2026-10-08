import { createRule } from "../utils.ts";

// SQL function calls rather than mentions in docs, log messages, or lock-name checks.
const ADVISORY_LOCK_CALL =
  /\bpg_(?:try_)?advisory_(?:(?:xact_)?lock(?:_shared)?|unlock(?:_shared|_all)?)\s*\(/i;

export const noNewAdvisoryLock = createRule({
  name: "no-new-advisory-lock",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow new PostgreSQL advisory lock calls in SQL literals",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      advisoryLock:
        "Do not add PostgreSQL advisory locks. Use a database constraint, row lock, or conditional update instead.",
    },
  },
  create(context) {
    return {
      Literal(node): void {
        if (
          typeof node.value === "string" &&
          ADVISORY_LOCK_CALL.test(node.value)
        ) {
          context.report({ node, messageId: "advisoryLock" });
        }
      },
      TemplateLiteral(node): void {
        if (
          node.quasis.some((quasi) => ADVISORY_LOCK_CALL.test(quasi.value.raw))
        ) {
          // Report the template's first line, so an inline next-line disable
          // works even when the SQL call itself is on a later line.
          context.report({ node, messageId: "advisoryLock" });
        }
      },
    };
  },
});
