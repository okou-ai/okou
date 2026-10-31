import {
  ASTUtils,
  AST_NODE_TYPES,
  ESLintUtils,
} from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";

const documentationUrl =
  "https://github.com/okou-ai/okou/blob/main/docs/zod-imports.md#string-formats";

// Zod 4 classic entry points whose `string()` returns `ZodString`. `zod/mini`
// has no chained format methods.
const classicSources = new Set(["zod", "zod/v4", "zod/v4/classic"]);

// Every format method that Zod 4 marks `@deprecated` on `ZodString`, mapped to
// the top-level replacement.
const replacements = new Map<string, string>([
  ["email", "email"],
  ["url", "url"],
  ["jwt", "jwt"],
  ["emoji", "emoji"],
  ["guid", "guid"],
  ["uuid", "uuid"],
  ["uuidv4", "uuidv4"],
  ["uuidv6", "uuidv6"],
  ["uuidv7", "uuidv7"],
  ["nanoid", "nanoid"],
  ["cuid", "cuid"],
  ["cuid2", "cuid2"],
  ["ulid", "ulid"],
  ["base64", "base64"],
  ["base64url", "base64url"],
  ["xid", "xid"],
  ["ksuid", "ksuid"],
  ["ipv4", "ipv4"],
  ["ipv6", "ipv6"],
  ["cidrv4", "cidrv4"],
  ["cidrv6", "cidrv6"],
  ["e164", "e164"],
  ["datetime", "iso.datetime"],
  ["date", "iso.date"],
  ["time", "iso.time"],
  ["duration", "iso.duration"],
]);

const createRule = ESLintUtils.RuleCreator(() => {
  return documentationUrl;
});

function propertyName(member: TSESTree.MemberExpression): string | undefined {
  if (!member.computed && member.property.type === AST_NODE_TYPES.Identifier) {
    return member.property.name;
  }
  return undefined;
}

function importedName(specifier: TSESTree.ImportSpecifier): string {
  return specifier.imported.type === AST_NODE_TYPES.Identifier
    ? specifier.imported.name
    : specifier.imported.value;
}

export const noZodStringFormatMethods = createRule({
  name: "no-string-format-methods",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the Zod 4 deprecated format methods on string(), such as string().uuid()",
    },
    schema: [],
    messages: {
      deprecatedFormat:
        'string().{{method}}() is deprecated in Zod 4. Use {{replacement}}() imported from "zod" with the original arguments. Use string().check({{replacement}}(...)) instead when earlier checks must run first or a custom message must apply only to the format. See {{documentationUrl}}.',
    },
  },
  create(context) {
    // Import specifiers of classic `string` and `coerce`.
    const stringImports = new Set<TSESTree.ImportSpecifier>();
    const coerceImports = new Set<TSESTree.ImportSpecifier>();

    function resolvesTo(
      identifier: TSESTree.Identifier,
      imports: ReadonlySet<TSESTree.ImportSpecifier>,
    ): boolean {
      const variable = ASTUtils.findVariable(
        context.sourceCode.getScope(identifier),
        identifier,
      );
      return (
        variable?.defs.some((definition) => {
          return (
            definition.node.type === AST_NODE_TYPES.ImportSpecifier &&
            imports.has(definition.node)
          );
        }) ?? false
      );
    }

    // `string(...)` or `coerce.string(...)` from a classic Zod entry point.
    function isZodStringCall(node: TSESTree.Node): boolean {
      if (node.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      const { callee } = node;
      if (callee.type === AST_NODE_TYPES.Identifier) {
        return resolvesTo(callee, stringImports);
      }
      return (
        callee.type === AST_NODE_TYPES.MemberExpression &&
        propertyName(callee) === "string" &&
        callee.object.type === AST_NODE_TYPES.Identifier &&
        resolvesTo(callee.object, coerceImports)
      );
    }

    return {
      ImportDeclaration(node) {
        if (
          !classicSources.has(node.source.value) ||
          node.importKind === "type"
        ) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type !== AST_NODE_TYPES.ImportSpecifier ||
            specifier.importKind === "type"
          ) {
            continue;
          }
          const name = importedName(specifier);
          if (name === "string") {
            stringImports.add(specifier);
          } else if (name === "coerce") {
            coerceImports.add(specifier);
          }
        }
      },
      CallExpression(node) {
        if (
          (stringImports.size === 0 && coerceImports.size === 0) ||
          node.callee.type !== AST_NODE_TYPES.MemberExpression
        ) {
          return;
        }
        const method = propertyName(node.callee);
        const replacement =
          method === undefined ? undefined : replacements.get(method);
        if (method === undefined || replacement === undefined) {
          return;
        }

        // Walk back through chained calls, e.g. string().trim().uuid().
        let receiver: TSESTree.Node = node.callee.object;
        while (
          receiver.type === AST_NODE_TYPES.CallExpression &&
          receiver.callee.type === AST_NODE_TYPES.MemberExpression
        ) {
          if (isZodStringCall(receiver)) {
            break;
          }
          receiver = receiver.callee.object;
        }
        if (!isZodStringCall(receiver)) {
          return;
        }

        context.report({
          node: node.callee.property,
          messageId: "deprecatedFormat",
          data: { method, replacement, documentationUrl },
        });
      },
    };
  },
});
