/**
 * ESLint rule: no-get-by-role-name
 *
 * Warns when *ByRole queries are used for roles whose accessible name comes
 * from subtree text content (button, link, menuitem, tab, …).
 *
 * Two layers of cost in @testing-library/happy-dom:
 *
 * 1. Adding `{ name }` forces the accessible-name algorithm to walk every
 *    candidate element's subtree. With 20+ buttons that is ~300–900ms per
 *    call.
 * 2. Even without `{ name }`, *ByRole walks the entire document running ARIA
 *    role inference per node. Profiling the /connectors page showed
 *    `getAllByRole("button")` taking ~360ms with only 5 buttons present —
 *    pushed the stripe CLI close test over the 5s vitest timeout in CI
 *    (#14871, then re-skipped in #14891) until we replaced the call.
 *
 * For native HTML elements (`button`, `a` → `link`, `[role="tab"]`, …) the
 * tag is the role, so querySelectorAll resolves the same set without the
 * ARIA tree walk.
 *
 * Bad:
 *   screen.getByRole("button", { name: /Add member/i })       // ~333ms
 *   within(dialog).getByRole("link", { name: "Cancel" })      // still slow
 *   screen.getAllByRole("button").find(el => /…/.test(el.textContent ?? ""))
 *
 * Good — native tag selector + textContent filter:
 *   for (const btn of document.body.querySelectorAll<HTMLButtonElement>("button")) {
 *     if (/Add member/.test(btn.textContent ?? "")) return btn;
 *   }
 *   // or, when uniqueness is guaranteed, screen.getByText("Add member")
 *
 * Exception — roles that have few instances or whose names come from labels
 * (heading, dialog, combobox, textbox, checkbox) are not flagged because they
 * either rarely have many DOM instances or are better queried via getByLabelText.
 */

import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/okou-ai/okou/blob/main/docs/eslint/${name}.md`,
);

/**
 * Roles whose accessible name is derived from subtree text content.
 * These are the roles where *ByRole(role, { name }) is expensive because
 * the library must walk the subtree of every matching element.
 *
 * Not included: roles with few instances per page (heading, dialog, alert),
 * or roles whose name comes from associated label elements (checkbox, radio,
 * textbox, combobox) — those should use getByLabelText instead.
 */
const TEXT_CONTENT_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "cell",
  "columnheader",
  "rowheader",
  "gridcell",
]);

const BY_ROLE_METHODS = new Set([
  "getByRole",
  "getAllByRole",
  "queryByRole",
  "queryAllByRole",
  "findByRole",
  "findAllByRole",
]);

type MessageIds = "avoidRoleWithName";

export default createRule<[], MessageIds>({
  name: "no-get-by-role-name",
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Avoid *ByRole(role, { name }) for text-content roles — accessible name computation is O(n×subtree) and causes severe slowdowns in happy-dom",
    },
    schema: [],
    messages: {
      avoidRoleWithName:
        'Avoid *ByRole("{{role}}", …) — even without `{ name }` this walks the whole DOM running ARIA role inference per node (~360ms per call on a typical page). Use `queryAllByRoleFast("{{role}}"[, container])` from src/__tests__/page-helper, then filter on textContent.',
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        // Resolve the method name — handles both `screen.getByRole(...)` and
        // `getByRole(...)` and `within(x).getByRole(...)`.
        let methodName: string | undefined;
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier"
        ) {
          methodName = node.callee.property.name;
        } else if (node.callee.type === "Identifier") {
          methodName = node.callee.name;
        }

        if (!methodName || !BY_ROLE_METHODS.has(methodName)) {
          return;
        }

        // First argument must be a string literal role name.
        const roleArg = node.arguments[0];
        if (
          !roleArg ||
          roleArg.type !== "Literal" ||
          typeof roleArg.value !== "string"
        ) {
          return;
        }

        const role = roleArg.value;
        if (!TEXT_CONTENT_ROLES.has(role)) {
          return;
        }

        context.report({
          node,
          messageId: "avoidRoleWithName",
          data: { role },
        });
      },
    };
  },
});
