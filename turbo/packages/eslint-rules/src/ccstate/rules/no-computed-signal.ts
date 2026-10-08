/**
 * ESLint rule: no-computed-signal
 *
 * A computed belongs to the static signal graph and has no lifecycle owner.
 * It must not read, capture, create, or pass AbortSignal values. Lifecycle-
 * bound work belongs in commands, which receive their AbortSignal explicitly.
 *
 * Good:
 *   computed(async (get) => load(get(id$)))
 *
 * Bad:
 *   computed(async (get) => load(get(id$), get(pageSignal$)))
 *   computed((get) => (signal: AbortSignal) => load(get(id$), signal))
 */

import {
  AST_NODE_TYPES,
  ASTUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";

type CallbackNode =
  TSESTree.ArrowFunctionExpression | TSESTree.FunctionExpression;

interface ImportReference {
  importedName: string;
  source: string;
}

interface ComputedContext {
  callback: CallbackNode;
  call: TSESTree.CallExpression;
  consumesAbortSignal: boolean;
}

function memberName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === AST_NODE_TYPES.Literal &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return null;
}

function patternMentionsAbortSignal(
  sourceCode: Readonly<{ getText(node: TSESTree.Node): string }>,
  pattern: TSESTree.Node,
): boolean {
  if (
    (pattern.type === AST_NODE_TYPES.Identifier ||
      pattern.type === AST_NODE_TYPES.ArrayPattern ||
      pattern.type === AST_NODE_TYPES.ObjectPattern ||
      pattern.type === AST_NODE_TYPES.RestElement) &&
    pattern.typeAnnotation &&
    /\bAbortSignal\b/.test(sourceCode.getText(pattern.typeAnnotation))
  ) {
    return true;
  }

  switch (pattern.type) {
    case AST_NODE_TYPES.AssignmentPattern:
      return patternMentionsAbortSignal(sourceCode, pattern.left);
    case AST_NODE_TYPES.RestElement:
      return patternMentionsAbortSignal(sourceCode, pattern.argument);
    case AST_NODE_TYPES.ArrayPattern:
      return pattern.elements.some((element) => {
        return (
          element !== null && patternMentionsAbortSignal(sourceCode, element)
        );
      });
    case AST_NODE_TYPES.ObjectPattern:
      return pattern.properties.some((property) => {
        return property.type === AST_NODE_TYPES.RestElement
          ? patternMentionsAbortSignal(sourceCode, property.argument)
          : property.value.type === AST_NODE_TYPES.AssignmentPattern ||
              property.value.type === AST_NODE_TYPES.ArrayPattern ||
              property.value.type === AST_NODE_TYPES.Identifier ||
              property.value.type === AST_NODE_TYPES.ObjectPattern
            ? patternMentionsAbortSignal(sourceCode, property.value)
            : false;
      });
    default:
      return false;
  }
}

export default createRule({
  name: "no-computed-signal",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description: "Disallow AbortSignal consumption in computed callbacks",
      recommended: true,
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      noComputedSignal:
        "Computed callbacks must not consume AbortSignal. Move lifecycle-bound work into a command and pass its signal explicitly.",
    },
  },
  create(context) {
    const computedStack: ComputedContext[] = [];

    function importReference(
      node: TSESTree.Identifier,
    ): ImportReference | null {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(node),
        node,
      );
      const definition = variable?.defs.find((candidate) => {
        return candidate.type === "ImportBinding";
      });
      const specifier = definition?.node;
      if (
        specifier === undefined ||
        (specifier.type !== AST_NODE_TYPES.ImportNamespaceSpecifier &&
          specifier.type !== AST_NODE_TYPES.ImportSpecifier) ||
        specifier.parent.type !== AST_NODE_TYPES.ImportDeclaration ||
        typeof specifier.parent.source.value !== "string"
      ) {
        return null;
      }

      return {
        importedName:
          specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier
            ? "*"
            : specifier.imported.type === AST_NODE_TYPES.Identifier
              ? specifier.imported.name
              : String(specifier.imported.value),
        source: specifier.parent.source.value,
      };
    }

    function isComputedCall(node: TSESTree.CallExpression): boolean {
      const callee = node.callee;
      if (callee.type === AST_NODE_TYPES.Identifier) {
        const reference = importReference(callee);
        return (
          reference?.source === "ccstate" &&
          reference.importedName === "computed"
        );
      }

      if (
        callee.type !== AST_NODE_TYPES.MemberExpression ||
        callee.object.type !== AST_NODE_TYPES.Identifier ||
        memberName(callee) !== "computed"
      ) {
        return false;
      }

      const reference = importReference(callee.object);
      return reference?.source === "ccstate" && reference.importedName === "*";
    }

    function computedCallForCallback(
      node: CallbackNode,
    ): TSESTree.CallExpression | null {
      const parent = node.parent;
      return parent.type === AST_NODE_TYPES.CallExpression &&
        parent.arguments[0] === node &&
        isComputedCall(parent)
        ? parent
        : null;
    }

    function markAbortSignalUse(): void {
      const current = computedStack[computedStack.length - 1];
      if (current) {
        current.consumesAbortSignal = true;
      }
    }

    function isCallCallee(node: TSESTree.Identifier): boolean {
      const parent = node.parent;
      return (
        parent.type === AST_NODE_TYPES.CallExpression && parent.callee === node
      );
    }

    function identifierLooksLikeAbortSignal(
      node: TSESTree.Identifier,
    ): boolean {
      if (node.name === "AbortSignal") {
        return true;
      }
      // Platform reserves `signal`, `*Signal`, and `*Signal$` for AbortSignal
      // values. Exclude call targets so helpers such as resetSignal() remain
      // usable in a computed without requiring type-checker-backed linting.
      if (isCallCallee(node)) {
        return false;
      }
      return (
        node.name === "signal" ||
        /^[a-z_$][A-Za-z0-9_$]*Signal\$?$/.test(node.name)
      );
    }

    function identifierHasAbortSignalType(node: TSESTree.Identifier): boolean {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(node),
        node,
      );
      return (
        variable?.defs.some((definition) => {
          return patternMentionsAbortSignal(
            context.sourceCode,
            definition.name,
          );
        }) ?? false
      );
    }

    function enterCallback(node: CallbackNode): void {
      const call = computedCallForCallback(node);
      if (!call) {
        return;
      }
      computedStack.push({
        callback: node,
        call,
        consumesAbortSignal: node.params.length > 1,
      });
    }

    function exitCallback(node: CallbackNode): void {
      const current = computedStack[computedStack.length - 1];
      if (!current || current.callback !== node) {
        return;
      }
      computedStack.pop();
      if (current.consumesAbortSignal) {
        context.report({ node: current.call, messageId: "noComputedSignal" });
      }
    }

    return {
      ArrowFunctionExpression: enterCallback,
      "ArrowFunctionExpression:exit": exitCallback,
      FunctionExpression: enterCallback,
      "FunctionExpression:exit": exitCallback,
      Identifier(node: TSESTree.Identifier): void {
        if (
          computedStack.length > 0 &&
          (identifierLooksLikeAbortSignal(node) ||
            identifierHasAbortSignalType(node))
        ) {
          markAbortSignalUse();
        }
      },
      MemberExpression(node: TSESTree.MemberExpression): void {
        if (computedStack.length > 0 && memberName(node) === "signal") {
          markAbortSignalUse();
        }
      },
    };
  },
});
