import {
  AST_NODE_TYPES,
  ESLintUtils,
  type TSESTree,
} from "@typescript-eslint/utils";
import { factoryProof } from "./factories.ts";
import {
  importedName,
  importFix,
  typeExportFix,
  type ImportTarget,
} from "./import-fixes.ts";
import {
  contractPaths,
  type ClientContractImportOptions,
  type ContractSource,
} from "./paths.ts";
import { onlyTypeReferences, variableInScope } from "./scope.ts";

type MessageId =
  | "preferClient"
  | "preferIndependent"
  | "typeOnly"
  | "manualMigration"
  | "runtimeImport";

type Options = [ClientContractImportOptions];

const createRule = ESLintUtils.RuleCreator(() => {
  return "https://github.com/okou-ai/okou/blob/main/docs/zod-imports.md#browser-http-contract-imports";
});

function staticSource(node: TSESTree.Node): string | null {
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === "string") {
    return node.value;
  }
  if (
    node.type === AST_NODE_TYPES.TemplateLiteral &&
    node.expressions.length === 0
  ) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

export const preferClientDescriptors = createRule<Options, MessageId>({
  name: "prefer-client-descriptors",
  defaultOptions: [{ modules: [], contractsDirectory: "" }],
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep runtime route schemas out of clients using proven descriptor and independent imports",
    },
    fixable: "code",
    schema: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: [
        {
          type: "object",
          additionalProperties: false,
          required: ["modules", "contractsDirectory"],
          properties: {
            contractsDirectory: { type: "string", minLength: 1 },
            modules: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["module", "contracts", "bindings"],
                properties: {
                  module: { type: "string", minLength: 1 },
                  contracts: {
                    type: "array",
                    items: { type: "string", minLength: 1 },
                  },
                  bindings: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["name", "source", "imported"],
                      properties: {
                        name: { type: "string", minLength: 1 },
                        source: { type: "string", minLength: 1 },
                        imported: { type: "string", minLength: 1 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    },
    messages: {
      preferClient:
        "Use the schema-free client descriptor for proven HTTP client and route metadata consumers.",
      preferIndependent:
        "Import independent values directly from their generated defining modules instead of route-bearing contracts.",
      typeOnly:
        "Use a statement-level type-only import or export to avoid loading runtime route schemas.",
      manualMigration:
        "This route-bearing import needs manual migration: schema, unknown, unused, or ambiguous usages cannot be safely rewritten.",
      runtimeImport:
        "Do not load a route-bearing contract module or barrel through this runtime import or export; migrate its usages explicitly.",
    },
  },
  create(context, [options]) {
    const sourceCode = context.sourceCode;
    const paths = contractPaths(options, context.filename);
    const proof = factoryProof(
      sourceCode,
      paths.isTransport,
      paths.isApiClientSignalSource,
    );

    function importTarget(
      node: TSESTree.ImportDeclaration,
      specifier: TSESTree.ImportClause,
    ): ImportTarget {
      const variable = variableInScope(sourceCode, specifier.local);
      return {
        specifier,
        source: node.source.value,
        imported:
          specifier.type === AST_NODE_TYPES.ImportSpecifier
            ? importedName(specifier)
            : null,
        typeOnly:
          (specifier.type === AST_NODE_TYPES.ImportSpecifier &&
            specifier.importKind === "type") ||
          (variable !== null && onlyTypeReferences(variable)),
      };
    }

    function fixImport(
      node: TSESTree.ImportDeclaration,
      targets: readonly ImportTarget[],
    ) {
      const destinations = new Set(targets.map((target) => target.source));
      for (const other of sourceCode.ast.body) {
        if (other.type !== AST_NODE_TYPES.ImportDeclaration || other === node) {
          continue;
        }
        if (destinations.has(other.source.value)) {
          return undefined;
        }
        // Also reserve destinations of other legacy imports: ESLint may apply
        // both fixes in one pass, before either new declaration is visible.
        const otherSource = paths.identify(other.source.value);
        const otherModule = otherSource?.module;
        if (
          otherSource === null ||
          otherModule === null ||
          otherModule === undefined ||
          other.importKind === "type"
        ) {
          continue;
        }
        for (const specifier of other.specifiers) {
          if (
            specifier.type !== AST_NODE_TYPES.ImportSpecifier ||
            specifier.importKind === "type"
          ) {
            continue;
          }
          const name = importedName(specifier);
          if (
            otherModule.contracts.includes(name) &&
            destinations.has(
              paths.destination(otherSource, `client/${otherModule.module}`),
            )
          ) {
            return undefined;
          }
          if (
            otherModule.bindings.some((binding) => {
              return (
                binding.name === name &&
                paths.independentSource(binding.source) &&
                destinations.has(paths.destination(otherSource, binding.source))
              );
            })
          ) {
            return undefined;
          }
        }
      }
      return importFix(sourceCode, node, targets);
    }

    function checkImport(
      node: TSESTree.ImportDeclaration,
      source: ContractSource,
    ): void {
      if (node.importKind === "type") {
        return;
      }
      const targets = node.specifiers.map((specifier) => {
        return importTarget(node, specifier);
      });
      if (targets.length > 0 && targets.every((target) => target.typeOnly)) {
        context.report({
          node,
          messageId: "typeOnly",
          fix: fixImport(node, targets),
        });
        return;
      }
      if (
        targets.length === 0 ||
        targets.some((target) => {
          return (
            !target.typeOnly &&
            target.specifier.type !== AST_NODE_TYPES.ImportSpecifier
          );
        })
      ) {
        context.report({ node, messageId: "runtimeImport" });
        return;
      }
      if (source.module === null) {
        context.report({ node, messageId: "manualMigration" });
        return;
      }

      let hasClient = false;
      let hasIndependent = false;
      let unsafe = false;
      const module = source.module;
      const migrated = targets.map((target): ImportTarget => {
        if (target.typeOnly) {
          return target;
        }
        const variable = variableInScope(sourceCode, target.specifier.local);
        if (variable === null || variable.references.length === 0) {
          unsafe = true;
          return target;
        }
        const isRouter =
          target.imported !== null &&
          module.contracts.includes(target.imported);
        const bindings = module.bindings.filter((binding) => {
          return binding.name === target.imported;
        });
        if (isRouter && bindings.length === 0 && proof.safeRouter(variable)) {
          hasClient = true;
          return {
            ...target,
            source: paths.destination(source, `client/${module.module}`),
          };
        }
        const binding = bindings[0];
        if (
          !isRouter &&
          bindings.length === 1 &&
          binding !== undefined &&
          paths.independentSource(binding.source)
        ) {
          hasIndependent = true;
          return {
            ...target,
            source: paths.destination(source, binding.source),
            imported: binding.imported,
          };
        }
        unsafe = true;
        return target;
      });
      const messageId: MessageId = unsafe
        ? "manualMigration"
        : hasClient
          ? "preferClient"
          : hasIndependent
            ? "preferIndependent"
            : "typeOnly";
      context.report({
        node,
        messageId,
        fix: unsafe ? undefined : fixImport(node, migrated),
      });
    }

    return {
      ImportDeclaration(node) {
        const source = paths.identify(node.source.value);
        if (source !== null) {
          checkImport(node, source);
        }
      },
      ImportExpression(node) {
        const source = staticSource(node.source);
        if (source !== null && paths.identify(source) !== null) {
          context.report({ node, messageId: "runtimeImport" });
        }
      },
      CallExpression(node) {
        if (
          node.callee.type !== AST_NODE_TYPES.Identifier ||
          node.callee.name !== "require"
        ) {
          return;
        }
        const variable = variableInScope(sourceCode, node.callee);
        if (variable !== null && variable.defs.length > 0) {
          return;
        }
        const argument = node.arguments[0];
        const source = argument === undefined ? null : staticSource(argument);
        if (source !== null && paths.identify(source) !== null) {
          context.report({ node, messageId: "runtimeImport" });
        }
      },
      TSImportEqualsDeclaration(node) {
        if (
          node.importKind !== "type" &&
          node.moduleReference.type ===
            AST_NODE_TYPES.TSExternalModuleReference &&
          paths.identify(node.moduleReference.expression.value) !== null
        ) {
          context.report({ node, messageId: "runtimeImport" });
        }
      },
      ExportNamedDeclaration(node) {
        if (
          node.source === null ||
          node.exportKind === "type" ||
          paths.identify(node.source.value) === null
        ) {
          return;
        }
        if (
          node.specifiers.length > 0 &&
          node.specifiers.every((specifier) => specifier.exportKind === "type")
        ) {
          context.report({
            node,
            messageId: "typeOnly",
            fix: typeExportFix(sourceCode, node),
          });
        } else {
          context.report({ node, messageId: "runtimeImport" });
        }
      },
      ExportAllDeclaration(node) {
        if (
          node.exportKind !== "type" &&
          paths.identify(node.source.value) !== null
        ) {
          context.report({ node, messageId: "runtimeImport" });
        }
      },
    };
  },
});
