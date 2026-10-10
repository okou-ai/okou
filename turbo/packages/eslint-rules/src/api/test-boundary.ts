import { dirname, relative, resolve } from "node:path";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

/** Repository-relative API testing guide; every test-boundary message links here. */
export function apiTestingDoc(anchor: string): string {
  return `docs/api/api-testing.md#${anchor}`;
}

/** Normalized linted file path relative to the ESLint working directory. */
export function lintedFile(context: { filename: string; cwd: string }): string {
  return relative(context.cwd, context.filename).replaceAll("\\", "/");
}

/**
 * Path of a relative module specifier, relative to the ESLint working
 * directory and without a TypeScript/JavaScript extension. Bare package
 * specifiers return undefined.
 */
export function resolvedModule(
  context: { filename: string; cwd: string },
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  return relative(context.cwd, resolve(dirname(context.filename), specifier))
    .replaceAll("\\", "/")
    .replace(/\.(?:[cm]?[jt]s|tsx|jsx)$/, "");
}

/** API test, suite, case, fixture and helper modules. */
export function isTestModule(file: string): boolean {
  return (
    /(^|\/)(__tests__|test-fixtures|helpers)\//.test(file) ||
    /\.(test|spec|suite|cases)\.[cm]?[jt]s$/.test(file)
  );
}

const viModuleCalls = new Set(["mock", "doMock", "importActual", "importMock"]);

/**
 * Visits every static, dynamic, type-level and Vitest module specifier in a
 * file, so aliases, re-exports and `import()` types cannot bypass a ban.
 */
export function moduleSpecifierVisitors(
  visit: (node: TSESTree.Node, specifier: string) => void,
) {
  function visitLiteral(node: TSESTree.Node, source: TSESTree.Node | null) {
    if (
      source?.type === AST_NODE_TYPES.Literal &&
      typeof source.value === "string"
    ) {
      visit(node, source.value);
    }
  }
  return {
    ImportDeclaration(node: TSESTree.ImportDeclaration) {
      visitLiteral(node, node.source);
    },
    ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration) {
      visitLiteral(node, node.source);
    },
    ExportAllDeclaration(node: TSESTree.ExportAllDeclaration) {
      visitLiteral(node, node.source);
    },
    ImportExpression(node: TSESTree.ImportExpression) {
      visitLiteral(node, node.source);
    },
    TSImportType(node: TSESTree.TSImportType) {
      const argument = node.argument;
      if (argument.type === AST_NODE_TYPES.TSLiteralType) {
        visitLiteral(node, argument.literal);
      }
    },
    CallExpression(node: TSESTree.CallExpression) {
      const callee = node.callee;
      if (
        callee.type === AST_NODE_TYPES.MemberExpression &&
        callee.object.type === AST_NODE_TYPES.Identifier &&
        callee.object.name === "vi" &&
        callee.property.type === AST_NODE_TYPES.Identifier &&
        viModuleCalls.has(callee.property.name)
      ) {
        visitLiteral(node, node.arguments[0] ?? null);
      }
    },
  };
}
