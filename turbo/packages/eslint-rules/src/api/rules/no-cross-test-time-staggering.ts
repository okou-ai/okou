import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import {
  importReference,
  memberName,
  propertyName,
  unwrapExpression,
  variableInScope,
} from "../syntax.ts";
import { createRule } from "../utils.ts";

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression;

const TIME_FUNCTIONS = new Set(["mockNow", "withMockNowForTest"]);

function isTimeModule(source: string): boolean {
  return source.endsWith("/lib/time") || source.endsWith("/lib/time.ts");
}

function enclosingFunction(node: TSESTree.Node): FunctionNode | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === AST_NODE_TYPES.ArrowFunctionExpression ||
      current.type === AST_NODE_TYPES.FunctionDeclaration ||
      current.type === AST_NODE_TYPES.FunctionExpression
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function functionName(node: FunctionNode): string | null {
  if (node.type === AST_NODE_TYPES.FunctionDeclaration) {
    return node.id?.name ?? null;
  }
  if (node.id) {
    return node.id.name;
  }
  if (
    node.parent.type === AST_NODE_TYPES.VariableDeclarator &&
    node.parent.id.type === AST_NODE_TYPES.Identifier
  ) {
    return node.parent.id.name;
  }
  return null;
}

function parameterIndex(node: FunctionNode, name: string): number {
  return node.params.findIndex((parameter) => {
    return (
      parameter.type === AST_NODE_TYPES.Identifier && parameter.name === name
    );
  });
}

function isDescribeCallback(
  node: FunctionNode,
  sourceCode: Parameters<typeof importReference>[0],
): boolean {
  if (node.type === AST_NODE_TYPES.FunctionDeclaration) {
    return false;
  }
  if (
    node.parent.type !== AST_NODE_TYPES.CallExpression ||
    !node.parent.arguments.includes(node)
  ) {
    return false;
  }
  const callee = node.parent.callee;
  if (callee.type === AST_NODE_TYPES.Identifier) {
    const imported = importReference(sourceCode, callee);
    return (
      callee.name === "describe" ||
      (imported?.source === "vitest" && imported.importedName === "describe")
    );
  }
  return (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    memberName(callee) === "describe"
  );
}

function declarationIsSuiteShared(
  node: TSESTree.VariableDeclarator,
  sourceCode: Parameters<typeof importReference>[0],
): boolean {
  let current: TSESTree.Node | undefined = node.parent;
  while (current) {
    if (
      current.type === AST_NODE_TYPES.ArrowFunctionExpression ||
      current.type === AST_NODE_TYPES.FunctionDeclaration ||
      current.type === AST_NODE_TYPES.FunctionExpression
    ) {
      return isDescribeCallback(current, sourceCode);
    }
    current = current.parent;
  }
  return true;
}

function isMutationReference(identifier: TSESTree.Identifier): boolean {
  let target: TSESTree.Node = identifier;
  while (
    target.parent.type === AST_NODE_TYPES.MemberExpression &&
    target.parent.object === target
  ) {
    target = target.parent;
  }
  const parent = target.parent;
  if (
    parent.type === AST_NODE_TYPES.UpdateExpression &&
    parent.argument === target
  ) {
    return true;
  }
  return (
    parent.type === AST_NODE_TYPES.AssignmentExpression &&
    parent.left === target
  );
}

export const noCrossTestTimeStaggering = createRule({
  name: "no-cross-test-time-staggering",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Prevent API cache tests from deriving mocked time from suite-shared mutable order",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      sharedTime:
        "Mocked time must not depend on a mutable package/describe-scope counter. Isolate cache state by owned keys and keep TTL advances inside the owning test. See docs/api/api-testing.md#shared-persistent-state.",
    },
  },
  create(context) {
    const calls: TSESTree.CallExpression[] = [];
    const timeCalls: TSESTree.CallExpression[] = [];

    function callsTo(node: FunctionNode): readonly TSESTree.CallExpression[] {
      const name = functionName(node);
      if (!name) {
        return [];
      }
      return calls.filter((call) => {
        return (
          call.callee.type === AST_NODE_TYPES.Identifier &&
          call.callee.name === name
        );
      });
    }

    function identifierIsSharedMutable(
      identifier: TSESTree.Identifier,
    ): boolean {
      const variable = variableInScope(context.sourceCode, identifier);
      const definition = variable?.defs[0];
      if (
        !variable ||
        definition?.node.type !== AST_NODE_TYPES.VariableDeclarator ||
        definition.node.parent.type !== AST_NODE_TYPES.VariableDeclaration ||
        !declarationIsSuiteShared(definition.node, context.sourceCode)
      ) {
        return false;
      }
      return variable.references.some((reference) => {
        return (
          reference.identifier.type === AST_NODE_TYPES.Identifier &&
          isMutationReference(reference.identifier)
        );
      });
    }

    function dependsOnSharedMutable(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        if (identifierIsSharedMutable(current)) {
          return true;
        }
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return dependsOnSharedMutable(definition.node.init, nextSeen);
        }
        if (definition?.type === "Parameter") {
          const owner = enclosingFunction(current);
          if (!owner) {
            return false;
          }
          const index = parameterIndex(owner, current.name);
          return callsTo(owner).some((call) => {
            const argument = call.arguments[index];
            return Boolean(
              argument &&
              argument.type !== AST_NODE_TYPES.SpreadElement &&
              dependsOnSharedMutable(argument, nextSeen),
            );
          });
        }
        return false;
      }
      if (
        current.type === AST_NODE_TYPES.BinaryExpression ||
        current.type === AST_NODE_TYPES.LogicalExpression
      ) {
        return (
          (current.left.type !== AST_NODE_TYPES.PrivateIdentifier &&
            dependsOnSharedMutable(current.left, nextSeen)) ||
          dependsOnSharedMutable(current.right, nextSeen)
        );
      }
      if (
        current.type === AST_NODE_TYPES.UnaryExpression ||
        current.type === AST_NODE_TYPES.UpdateExpression ||
        current.type === AST_NODE_TYPES.AwaitExpression
      ) {
        return dependsOnSharedMutable(current.argument, nextSeen);
      }
      if (current.type === AST_NODE_TYPES.ConditionalExpression) {
        return (
          dependsOnSharedMutable(current.test, nextSeen) ||
          dependsOnSharedMutable(current.consequent, nextSeen) ||
          dependsOnSharedMutable(current.alternate, nextSeen)
        );
      }
      if (current.type === AST_NODE_TYPES.TemplateLiteral) {
        return current.expressions.some((part) => {
          return dependsOnSharedMutable(part, nextSeen);
        });
      }
      if (current.type === AST_NODE_TYPES.SequenceExpression) {
        return current.expressions.some((part) => {
          return dependsOnSharedMutable(part, nextSeen);
        });
      }
      if (current.type === AST_NODE_TYPES.ArrayExpression) {
        return current.elements.some((element) => {
          return Boolean(
            element &&
            dependsOnSharedMutable(
              element.type === AST_NODE_TYPES.SpreadElement
                ? element.argument
                : element,
              nextSeen,
            ),
          );
        });
      }
      if (current.type === AST_NODE_TYPES.ObjectExpression) {
        return current.properties.some((property) => {
          if (property.type === AST_NODE_TYPES.SpreadElement) {
            return dependsOnSharedMutable(property.argument, nextSeen);
          }
          return (
            (property.computed &&
              dependsOnSharedMutable(property.key, nextSeen)) ||
            (property.value.type !== AST_NODE_TYPES.AssignmentPattern &&
              dependsOnSharedMutable(
                property.value as TSESTree.Expression,
                nextSeen,
              ))
          );
        });
      }
      if (current.type === AST_NODE_TYPES.MemberExpression) {
        return (
          dependsOnSharedMutable(current.object, nextSeen) ||
          (current.computed &&
            dependsOnSharedMutable(current.property, nextSeen))
        );
      }
      if (current.type === AST_NODE_TYPES.CallExpression) {
        return current.arguments.some((argument) => {
          return dependsOnSharedMutable(
            argument.type === AST_NODE_TYPES.SpreadElement
              ? argument.argument
              : argument,
            nextSeen,
          );
        });
      }
      return false;
    }

    function isTimeNamespace(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current) || current.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      const imported = importReference(context.sourceCode, current);
      if (imported?.importedName === "*" && isTimeModule(imported.source)) {
        return true;
      }
      const definition = variableInScope(context.sourceCode, current)?.defs[0];
      return Boolean(
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
        definition.node.init &&
        isTimeNamespace(definition.node.init, nextSeen),
      );
    }

    function isTimeFunction(
      expression: TSESTree.CallExpression["callee"],
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      if (seen.has(expression)) {
        return false;
      }
      const nextSeen = new Set(seen).add(expression);
      if (expression.type === AST_NODE_TYPES.Identifier) {
        const imported = importReference(context.sourceCode, expression);
        if (
          imported &&
          isTimeModule(imported.source) &&
          TIME_FUNCTIONS.has(imported.importedName)
        ) {
          return true;
        }
        const definition = variableInScope(context.sourceCode, expression)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init &&
          definition.node.id.type === AST_NODE_TYPES.ObjectPattern
        ) {
          const destructured = definition.node.id.properties.find((entry) => {
            return (
              entry.type === AST_NODE_TYPES.Property &&
              entry.value.type === AST_NODE_TYPES.Identifier &&
              entry.value.name === expression.name
            );
          });
          const name =
            destructured?.type === AST_NODE_TYPES.Property
              ? propertyName(destructured)
              : null;
          if (
            name &&
            TIME_FUNCTIONS.has(name) &&
            isTimeNamespace(definition.node.init)
          ) {
            return true;
          }
        }
        return Boolean(
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init &&
          isTimeFunction(definition.node.init, nextSeen),
        );
      }
      if (
        expression.type === AST_NODE_TYPES.MemberExpression &&
        expression.object.type !== AST_NODE_TYPES.Super
      ) {
        const name = memberName(expression);
        return (
          name === "setSystemTime" ||
          Boolean(
            name &&
            TIME_FUNCTIONS.has(name) &&
            isTimeNamespace(expression.object),
          )
        );
      }
      return false;
    }

    function isTimeCall(node: TSESTree.CallExpression): boolean {
      return isTimeFunction(node.callee);
    }

    return {
      CallExpression(node: TSESTree.CallExpression) {
        calls.push(node);
        if (isTimeCall(node)) {
          timeCalls.push(node);
        }
      },
      "Program:exit"() {
        for (const call of timeCalls) {
          if (
            call.arguments.some((argument) => {
              return dependsOnSharedMutable(
                argument.type === AST_NODE_TYPES.SpreadElement
                  ? argument.argument
                  : argument,
              );
            })
          ) {
            context.report({ node: call, messageId: "sharedTime" });
          }
        }
      },
    };
  },
});
