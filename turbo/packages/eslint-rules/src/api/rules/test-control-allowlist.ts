import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "../utils.ts";
import {
  apiTestingDoc,
  isTestModule,
  lintedFile,
  resolvedModule,
} from "../test-boundary.ts";

interface ControlEntry {
  /** Exact production file path relative to the linted package (no globs). */
  readonly file: string;
  readonly exports: readonly string[];
  readonly reason: string;
}

interface Options {
  readonly controls?: readonly ControlEntry[];
}

const testControlName = /ForTests?$/;

function nameOf(node: TSESTree.Node): string | undefined {
  if (node.type === AST_NODE_TYPES.Identifier) {
    return node.name;
  }
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === "string") {
    return node.value;
  }
  return undefined;
}

function declaredNames(
  declaration: TSESTree.ExportNamedDeclaration["declaration"],
): string[] {
  if (declaration === null) {
    return [];
  }
  if (declaration.type === AST_NODE_TYPES.VariableDeclaration) {
    return declaration.declarations.flatMap((declarator) =>
      declarator.id.type === AST_NODE_TYPES.Identifier
        ? [declarator.id.name]
        : [],
    );
  }
  if (
    "id" in declaration &&
    declaration.id?.type === AST_NODE_TYPES.Identifier
  ) {
    return [declaration.id.name];
  }
  return [];
}

/**
 * Production modules may export `*ForTest(s)` boundary controls only from an
 * explicit allowlist, and tests may import only those allowlisted controls.
 */
export const testControlAllowlist = createRule<
  [Options],
  "unlistedExport" | "unlistedImport"
>({
  name: "test-control-allowlist",
  defaultOptions: [{}],
  meta: {
    type: "problem",
    docs: {
      description:
        "Restrict production *ForTest(s) exports and their test imports to an explicit allowlist",
      requiresTypeChecking: false,
    },
    schema: [
      {
        type: "object",
        additionalProperties: false,
        properties: {
          controls: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["file", "exports", "reason"],
              properties: {
                file: { type: "string", minLength: 1, pattern: "^[^*?]+$" },
                exports: {
                  type: "array",
                  minItems: 1,
                  uniqueItems: true,
                  items: { type: "string", pattern: "ForTests?$" },
                },
                reason: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    ],
    messages: {
      unlistedExport: `Production code must not export test control {{name}} unless it is an allowlisted boundary control. See ${apiTestingDoc("boundary-test-controls")}.`,
      unlistedImport: `Tests may import only allowlisted boundary controls; {{name}} from "{{specifier}}" is not one. See ${apiTestingDoc("boundary-test-controls")}.`,
    },
  },
  create(context, [options]) {
    const file = lintedFile(context);
    const allowed = new Map<string, Set<string>>();
    for (const entry of options.controls ?? []) {
      allowed.set(
        entry.file.replace(/\.[cm]?[jt]s$/, ""),
        new Set(entry.exports),
      );
    }
    const ownExports = allowed.get(file.replace(/\.[cm]?[jt]s$/, ""));

    if (!isTestModule(file)) {
      function checkExport(node: TSESTree.Node, name: string | undefined) {
        if (
          name !== undefined &&
          testControlName.test(name) &&
          !ownExports?.has(name)
        ) {
          context.report({ node, messageId: "unlistedExport", data: { name } });
        }
      }
      return {
        ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration) {
          for (const name of declaredNames(node.declaration)) {
            checkExport(node, name);
          }
          for (const specifier of node.specifiers) {
            checkExport(specifier, nameOf(specifier.exported));
          }
        },
      };
    }

    function checkImport(
      node: TSESTree.Node,
      specifier: string,
      name: string | undefined,
    ) {
      if (name === undefined || !testControlName.test(name)) {
        return;
      }
      const resolved = resolvedModule(context, specifier);
      if (resolved === undefined || isTestModule(`${resolved}.ts`)) {
        return;
      }
      if (!allowed.get(resolved)?.has(name)) {
        context.report({
          node,
          messageId: "unlistedImport",
          data: { name, specifier },
        });
      }
    }
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        for (const specifier of node.specifiers) {
          if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
            checkImport(
              specifier,
              node.source.value,
              nameOf(specifier.imported),
            );
          }
        }
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration) {
        if (node.source === null) {
          return;
        }
        for (const specifier of node.specifiers) {
          checkImport(specifier, node.source.value, nameOf(specifier.local));
        }
      },
    };
  },
});
