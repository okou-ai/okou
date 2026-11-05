/**
 * ESLint rule: require-anchor-href
 *
 * An anchor is navigation: it owns a destination the browser can open, copy,
 * bookmark, or send to a new tab, and it is the one element that draws the
 * pointer cursor. An `<a>` without a real `href` is a button in disguise. It
 * shows the link cursor, is announced as a link, and loses keyboard activation
 * once the href is gone, while it only runs a click handler. Actions use
 * `Button`; navigation uses an anchor or Router `Link` with its destination.
 *
 * Flagged:
 * - `<a>` with no `href` attribute (a spread does not count: the destination
 *   must be visible where the anchor is written);
 * - an `href` that is empty, a bare `#`, or a `javascript:`, `vbscript:` or
 *   `data:` URL, including as a branch of a conditional;
 * - `role="button"` on an anchor.
 *
 * Fragment links such as `href="#pricing"` stay valid: they navigate.
 */

import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

function attribute(
  node: TSESTree.JSXOpeningElement,
  name: string,
): TSESTree.JSXAttribute | null {
  for (const candidate of node.attributes) {
    if (
      candidate.type === AST_NODE_TYPES.JSXAttribute &&
      candidate.name.type === AST_NODE_TYPES.JSXIdentifier &&
      candidate.name.name === name
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * Schemes that do not navigate from an anchor: `javascript:` and `vbscript:`
 * run code, and browsers block top-level navigation to `data:` URLs. A
 * generated download uses an object URL, as the message PDF link does.
 */
const NON_NAVIGATING_SCHEMES = ["javascript:", "vbscript:", "data:"];

function isPlaceholderHref(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "#" ||
    NON_NAVIGATING_SCHEMES.some((scheme) => {
      return normalized.startsWith(scheme);
    })
  );
}

/** A literal or a conditional branch that resolves to a placeholder href. */
function placeholderHref(
  node: TSESTree.Node | null | undefined,
): string | null {
  if (!node) {
    return null;
  }
  switch (node.type) {
    case AST_NODE_TYPES.Literal: {
      if (node.value === null) {
        return "null";
      }
      return typeof node.value === "string" && isPlaceholderHref(node.value)
        ? node.value
        : null;
    }
    case AST_NODE_TYPES.TemplateLiteral: {
      if (node.expressions.length > 0) {
        return null;
      }
      const raw = node.quasis.map((quasi) => quasi.value.cooked).join("");
      return isPlaceholderHref(raw) ? raw : null;
    }
    case AST_NODE_TYPES.Identifier: {
      return node.name === "undefined" ? "undefined" : null;
    }
    case AST_NODE_TYPES.ConditionalExpression: {
      return (
        placeholderHref(node.consequent) ?? placeholderHref(node.alternate)
      );
    }
    case AST_NODE_TYPES.LogicalExpression: {
      return placeholderHref(node.right);
    }
    case AST_NODE_TYPES.JSXExpressionContainer: {
      return node.expression.type === AST_NODE_TYPES.JSXEmptyExpression
        ? ""
        : placeholderHref(node.expression);
    }
    default: {
      return null;
    }
  }
}

function roleValue(node: TSESTree.JSXAttribute | null): string | null {
  const value = node?.value;
  if (!value) {
    return null;
  }
  if (value.type === AST_NODE_TYPES.Literal) {
    return typeof value.value === "string" ? value.value : null;
  }
  if (
    value.type === AST_NODE_TYPES.JSXExpressionContainer &&
    value.expression.type === AST_NODE_TYPES.Literal &&
    typeof value.expression.value === "string"
  ) {
    return value.expression.value;
  }
  return null;
}

export default createRule({
  name: "require-anchor-href",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Require anchors to carry a real destination instead of simulating a button.",
      recommended: true,
    },
    schema: [],
    messages: {
      missingHref:
        "An <a> without `href` is a button in disguise: it shows the link cursor and is announced as a link but has nowhere to go. Give it its destination, or use `Button` for an action. See docs/app/styles.md#semantic-elements-and-base-ui-composition.",
      placeholderHref:
        "`href={{value}}` is not a destination. Give the anchor a real URL or path, or use `Button` for an action. See docs/app/styles.md#semantic-elements-and-base-ui-composition.",
      roleButton:
        'An anchor with `role="button"` is a button in disguise. Use `Button` for the action, or drop the role and keep a real destination.',
    },
  },
  create(context) {
    return {
      JSXOpeningElement(node: TSESTree.JSXOpeningElement): void {
        if (
          node.name.type !== AST_NODE_TYPES.JSXIdentifier ||
          node.name.name !== "a"
        ) {
          return;
        }

        if (roleValue(attribute(node, "role")) === "button") {
          context.report({ node, messageId: "roleButton" });
        }

        const href = attribute(node, "href");
        if (!href) {
          context.report({ node, messageId: "missingHref" });
          return;
        }
        const placeholder = href.value ? placeholderHref(href.value) : "";
        if (placeholder !== null) {
          context.report({
            node: href,
            messageId: "placeholderHref",
            data: { value: JSON.stringify(placeholder) },
          });
        }
      },
    };
  },
});
