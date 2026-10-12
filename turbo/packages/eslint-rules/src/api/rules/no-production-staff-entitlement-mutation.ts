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
type MutationKind = "delete" | "grant" | "upsert";

const PRODUCTION_STAFF_ORG_ID = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

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

interface ParameterBinding {
  readonly index: number;
  readonly property: string | null;
}

function parameterBinding(
  node: FunctionNode,
  name: string,
): ParameterBinding | null {
  for (const [index, rawParameter] of node.params.entries()) {
    const parameter =
      rawParameter.type === AST_NODE_TYPES.AssignmentPattern
        ? rawParameter.left
        : rawParameter;
    if (
      parameter.type === AST_NODE_TYPES.Identifier &&
      parameter.name === name
    ) {
      return { index, property: null };
    }
    if (parameter.type !== AST_NODE_TYPES.ObjectPattern) {
      continue;
    }
    for (const entry of parameter.properties) {
      if (
        entry.type === AST_NODE_TYPES.Property &&
        entry.value.type === AST_NODE_TYPES.Identifier &&
        entry.value.name === name
      ) {
        return { index, property: propertyName(entry) };
      }
    }
  }
  return null;
}

function isEntitlementFixtureModule(source: string): boolean {
  return (
    source.endsWith("/test-fixtures/org-plan-entitlement") ||
    source.endsWith("/test-fixtures/org-plan-entitlement.ts")
  );
}

export const noProductionStaffEntitlementMutation = createRule({
  name: "no-production-staff-entitlement-mutation",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep the fixed production staff organization identity read-only in API tests",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      productionStaffMutation:
        "Do not mutate entitlements for the fixed production staff organization. Use createUniqueStaffOrgIdFixture() or another test-owned organization. See docs/api/api-testing.md#shared-persistent-state.",
    },
  },
  create(context) {
    const calls: TSESTree.CallExpression[] = [];
    const functionReturns = new Map<FunctionNode, TSESTree.Expression[]>();

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

    function expressionProperty(
      expression: TSESTree.Expression,
      name: string,
      seen: ReadonlySet<TSESTree.Node>,
    ): TSESTree.Expression | null {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return null;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.ObjectExpression) {
        for (const property of current.properties) {
          if (
            property.type === AST_NODE_TYPES.Property &&
            propertyName(property) === name &&
            property.value.type !== AST_NODE_TYPES.AssignmentPattern
          ) {
            return property.value as TSESTree.Expression;
          }
          if (property.type === AST_NODE_TYPES.SpreadElement) {
            const nested = expressionProperty(
              property.argument,
              name,
              nextSeen,
            );
            if (nested) {
              return nested;
            }
          }
        }
      }
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return expressionProperty(definition.node.init, name, nextSeen);
        }
      }
      return null;
    }

    function parameterResolvesToStaff(
      identifier: TSESTree.Identifier,
      property: "actor" | "orgId",
      seen: ReadonlySet<TSESTree.Node>,
    ): boolean {
      const owner = enclosingFunction(identifier);
      if (!owner) {
        return false;
      }
      const binding = parameterBinding(owner, identifier.name);
      if (!binding) {
        return false;
      }
      return callsTo(owner).some((call) => {
        const argument = call.arguments[binding.index];
        if (!argument || argument.type === AST_NODE_TYPES.SpreadElement) {
          return false;
        }
        const value = binding.property
          ? expressionProperty(argument, binding.property, seen)
          : argument;
        if (!value) {
          return false;
        }
        return property === "actor"
          ? isStaffActor(value, seen)
          : isStaffOrgId(value, seen);
      });
    }

    function objectPropertyResolvesToStaff(
      expression: TSESTree.Expression,
      name: string,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      const property = expressionProperty(current, name, seen);
      if (property) {
        return isStaffOrgId(property, nextSeen);
      }
      if (current.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const definition = variableInScope(context.sourceCode, current)?.defs[0];
      if (definition?.type !== "Parameter") {
        return false;
      }
      const owner = enclosingFunction(current);
      if (!owner) {
        return false;
      }
      const binding = parameterBinding(owner, current.name);
      if (!binding) {
        return false;
      }
      return callsTo(owner).some((call) => {
        const argument = call.arguments[binding.index];
        if (!argument || argument.type === AST_NODE_TYPES.SpreadElement) {
          return false;
        }
        const value = binding.property
          ? expressionProperty(argument, binding.property, nextSeen)
          : argument;
        return Boolean(
          value && objectPropertyResolvesToStaff(value, name, nextSeen),
        );
      });
    }

    function isStaffOrgId(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (
        current.type === AST_NODE_TYPES.Literal &&
        current.value === PRODUCTION_STAFF_ORG_ID
      ) {
        return true;
      }
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return isStaffOrgId(definition.node.init, nextSeen);
        }
        if (definition?.type === "Parameter") {
          return parameterResolvesToStaff(current, "orgId", nextSeen);
        }
        return false;
      }
      if (
        current.type === AST_NODE_TYPES.MemberExpression &&
        memberName(current) === "orgId"
      ) {
        return isStaffActor(current.object, nextSeen);
      }
      if (current.type === AST_NODE_TYPES.ConditionalExpression) {
        return (
          isStaffOrgId(current.consequent, nextSeen) ||
          isStaffOrgId(current.alternate, nextSeen)
        );
      }
      return false;
    }

    function isStaffActor(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.ObjectExpression) {
        const orgId = expressionProperty(current, "orgId", seen);
        return orgId ? isStaffOrgId(orgId, nextSeen) : false;
      }
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return isStaffActor(definition.node.init, nextSeen);
        }
        if (definition?.type === "Parameter") {
          return parameterResolvesToStaff(current, "actor", nextSeen);
        }
        return false;
      }
      if (current.type === AST_NODE_TYPES.CallExpression) {
        const calleeName =
          current.callee.type === AST_NODE_TYPES.Identifier
            ? current.callee.name
            : current.callee.type === AST_NODE_TYPES.MemberExpression
              ? memberName(current.callee)
              : null;
        if (calleeName === "user") {
          const options = current.arguments[0];
          if (!options || options.type === AST_NODE_TYPES.SpreadElement) {
            return false;
          }
          const orgId = expressionProperty(options, "orgId", nextSeen);
          return orgId ? isStaffOrgId(orgId, nextSeen) : false;
        }
        if (current.callee.type === AST_NODE_TYPES.Identifier) {
          const calleeName = current.callee.name;
          const localFunction = [...functionReturns.keys()].find(
            (candidate) => {
              return functionName(candidate) === calleeName;
            },
          );
          if (!localFunction) {
            return false;
          }
          return (functionReturns.get(localFunction) ?? []).some((returned) => {
            return isStaffActor(returned, nextSeen);
          });
        }
      }
      return false;
    }

    function isEntitlementNamespace(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current) || current.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      const imported = importReference(context.sourceCode, current);
      if (
        imported?.importedName === "*" &&
        isEntitlementFixtureModule(imported.source)
      ) {
        return true;
      }
      const definition = variableInScope(context.sourceCode, current)?.defs[0];
      return Boolean(
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
        definition.node.init &&
        isEntitlementNamespace(definition.node.init, nextSeen),
      );
    }

    function mutationKind(
      callee: TSESTree.CallExpression["callee"],
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): MutationKind | null {
      if (seen.has(callee)) {
        return null;
      }
      const nextSeen = new Set(seen).add(callee);
      if (callee.type === AST_NODE_TYPES.MemberExpression) {
        const name = memberName(callee);
        if (name === "grantProEntitlement") {
          return "grant";
        }
        if (
          callee.object.type !== AST_NODE_TYPES.Super &&
          isEntitlementNamespace(callee.object)
        ) {
          if (name === "upsertOrgPlanEntitlementFixture") {
            return "upsert";
          }
          if (name === "deleteOrgPlanEntitlementFixture") {
            return "delete";
          }
        }
        return null;
      }
      if (callee.type !== AST_NODE_TYPES.Identifier) {
        return null;
      }
      const imported = importReference(context.sourceCode, callee);
      if (imported && isEntitlementFixtureModule(imported.source)) {
        if (imported.importedName === "upsertOrgPlanEntitlementFixture") {
          return "upsert";
        }
        if (imported.importedName === "deleteOrgPlanEntitlementFixture") {
          return "delete";
        }
      }
      const definition = variableInScope(context.sourceCode, callee)?.defs[0];
      if (
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
        definition.node.init
      ) {
        if (definition.node.id.type === AST_NODE_TYPES.ObjectPattern) {
          const destructured = definition.node.id.properties.find((entry) => {
            return (
              entry.type === AST_NODE_TYPES.Property &&
              entry.value.type === AST_NODE_TYPES.Identifier &&
              entry.value.name === callee.name
            );
          });
          const name =
            destructured?.type === AST_NODE_TYPES.Property
              ? propertyName(destructured)
              : null;
          if (isEntitlementNamespace(definition.node.init)) {
            if (name === "upsertOrgPlanEntitlementFixture") {
              return "upsert";
            }
            if (name === "deleteOrgPlanEntitlementFixture") {
              return "delete";
            }
          }
        }
        return mutationKind(definition.node.init, nextSeen);
      }
      return null;
    }

    function checkMutation(call: TSESTree.CallExpression): void {
      const kind = mutationKind(call.callee);
      if (!kind) {
        return;
      }
      const first = call.arguments[0];
      if (!first || first.type === AST_NODE_TYPES.SpreadElement) {
        return;
      }
      let mutatesStaff = false;
      if (kind === "upsert") {
        mutatesStaff = objectPropertyResolvesToStaff(first, "orgId");
      } else if (kind === "delete") {
        mutatesStaff = isStaffOrgId(first);
      } else {
        mutatesStaff = isStaffActor(first);
      }
      if (mutatesStaff) {
        context.report({ node: call, messageId: "productionStaffMutation" });
      }
    }

    function registerFunction(node: FunctionNode): void {
      if (!functionReturns.has(node)) {
        functionReturns.set(node, []);
      }
      if (
        node.type === AST_NODE_TYPES.ArrowFunctionExpression &&
        node.body.type !== AST_NODE_TYPES.BlockStatement
      ) {
        functionReturns.get(node)?.push(node.body);
      }
    }

    return {
      ArrowFunctionExpression: registerFunction,
      FunctionDeclaration: registerFunction,
      FunctionExpression: registerFunction,
      ReturnStatement(node: TSESTree.ReturnStatement) {
        const owner = enclosingFunction(node);
        if (owner && node.argument) {
          functionReturns.get(owner)?.push(node.argument);
        }
      },
      CallExpression(node: TSESTree.CallExpression) {
        calls.push(node);
      },
      "Program:exit"() {
        for (const call of calls) {
          checkMutation(call);
        }
      },
    };
  },
});
