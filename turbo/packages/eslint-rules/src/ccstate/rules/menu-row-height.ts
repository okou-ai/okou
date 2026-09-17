/**
 * ESLint rule: menu-row-height
 *
 * Keeps the row height of popup lists with the shared component instead of the
 * call site. `DropdownMenuItem`, `DropdownMenuSubTrigger` and `SelectItem` each
 * draw the app's 36px row; a caller that restates the height with `py-*` or
 * `h-*` silently forks it, which is how the composer's `+` menu ended up at
 * 32px, the account and growth menus at 40px, and the model picker beside them
 * at 36px.
 *
 * Content still owns the row: the shared class is padding, not a fixed height,
 * so a wrapping row grows on its own. `min-h-*` stays allowed because it only
 * raises the floor — a deliberate touch target, never a second row height.
 * Horizontal rhythm (`px-*`, `gap-*`) is a caller decision and out of scope.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

/** Components whose row height is owned by `@okouai/ui`. */
const MENU_ROWS = new Set([
  "DropdownMenuItem",
  "DropdownMenuModalItem",
  "DropdownMenuSubTrigger",
  "SelectItem",
]);

/**
 * A vertical-geometry utility, with or without a variant prefix (`sm:`,
 * `data-highlighted:`). The leading lookbehind is what keeps `min-h-11` and the
 * `h` inside `overflow-hidden` out: both are preceded by a hyphen.
 */
const ROW_HEIGHT_CLASS =
  /(?<![\w:/-])(?:[a-z][\w@[\]./-]*:)*(?:py|h)-[\w./[\]-]+(?![\w/-])/;

function classNameAttribute(
  node: TSESTree.JSXOpeningElement,
): TSESTree.JSXAttribute | null {
  for (const attribute of node.attributes) {
    if (
      attribute.type === AST_NODE_TYPES.JSXAttribute &&
      attribute.name.type === AST_NODE_TYPES.JSXIdentifier &&
      attribute.name.name === "className" &&
      attribute.value
    ) {
      return attribute;
    }
  }
  return null;
}

export default createRule({
  name: "menu-row-height",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow caller-owned row height on shared menu and select rows.",
      recommended: true,
    },
    schema: [],
    messages: {
      menuRowHeight:
        "<{{component}}> owns its 36px row height. Remove `{{marker}}` and let the shared component set it, so this menu keeps the same rhythm as every other one. Use `min-h-*` only to raise the floor for a deliberate touch target.",
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement): void {
        if (node.name.type !== AST_NODE_TYPES.JSXIdentifier) {
          return;
        }
        const component = node.name.name;
        if (!MENU_ROWS.has(component)) {
          return;
        }

        const attribute = classNameAttribute(node);
        if (!attribute?.value) {
          return;
        }

        // A literal, a template literal, or `cn(...)`: the utilities appear
        // verbatim in the source either way, so match the raw text.
        const marker = ROW_HEIGHT_CLASS.exec(
          context.sourceCode.getText(attribute.value),
        );
        if (!marker) {
          return;
        }

        context.report({
          node: attribute,
          messageId: "menuRowHeight",
          data: { component, marker: marker[0] },
        });
      },
    };
  },
});
