import { dirname, resolve } from "node:path";
import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

/** Repository-relative API testing guide; every test-boundary message links here. */
export function apiTestingDoc(anchor: string): string {
  return `docs/api/api-testing.md#${anchor}`;
}

/** Normalized absolute path of the linted file. */
export function lintedFile(context: { filename: string }): string {
  return context.filename.replaceAll("\\", "/");
}

/**
 * Whether a normalized path is the exact package-relative entry. Matching on
 * the path suffix keeps exceptions independent of ESLint's working directory.
 */
export function isEntry(path: string, entry: string): boolean {
  return path === entry || path.endsWith(`/${entry}`);
}

/**
 * Normalized absolute path of a relative module specifier, without a
 * TypeScript/JavaScript extension. Bare package specifiers return undefined.
 */
export function resolvedModule(
  context: { filename: string },
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  return resolve(dirname(context.filename), specifier)
    .replaceAll("\\", "/")
    .replace(/\.(?:[cm]?[jt]s|tsx|jsx)$/, "");
}

/**
 * API test, suite, case, benchmark, fixture and helper modules plus
 * executable acceptance entrypoints. Mirrors `apiTestModuleFiles` in the API
 * ESLint config.
 */
export function isTestModule(file: string): boolean {
  return (
    /(^|\/)(__tests__|__benches__|test-fixtures)\//.test(file) ||
    /\.(test|spec|suite|cases|bench)\.[cm]?[jt]s$/.test(file) ||
    /(^|\/)scripts\/(.*\/)?(acceptance|fixture)\.[cm]?[jt]s$/.test(file)
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
