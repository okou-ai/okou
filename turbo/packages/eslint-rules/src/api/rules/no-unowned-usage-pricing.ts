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

interface CallFrame {
  readonly call: TSESTree.CallExpression;
  readonly functionNode: FunctionNode;
  readonly parent: CallFrame | null;
}

interface FramedExpression {
  readonly expression: TSESTree.Expression;
  readonly frame: CallFrame | null;
}

type MutationName =
  | "deleteUsagePricingRows"
  | "seedUsagePricingRows"
  | "upsertUsagePricingRows";

const RAW_MUTATIONS = new Set<MutationName>([
  "deleteUsagePricingRows",
  "seedUsagePricingRows",
  "upsertUsagePricingRows",
]);
const RUN_FACTORY_NAMES = new Set([
  "createThreadRun",
  "insertRunFixture",
  "sendChatRun",
]);

function isPricingFixtureModule(source: string): boolean {
  return (
    source.endsWith("/test-fixtures/system-config-seeds") ||
    source.endsWith("/test-fixtures/system-config-seeds.ts") ||
    source.endsWith("/test-fixtures/usage-pricing") ||
    source.endsWith("/test-fixtures/usage-pricing.ts")
  );
}

function isApprovedRunClientFactory(
  source: string,
  exportName: string,
): boolean {
  return (
    exportName === "createRunsApi" &&
    (source.endsWith("/helpers/api-bdd-runs") ||
      source.endsWith("/helpers/api-bdd-runs.ts"))
  );
}

function isApprovedScopedRunStateRoute(
  source: string,
  exportName: string,
): boolean {
  return (
    exportName === "testCronCleanupSandboxesStateRoutes" &&
    (source.endsWith("/test-cron-cleanup-sandboxes-state") ||
      source.endsWith("/test-cron-cleanup-sandboxes-state.ts"))
  );
}

function isApprovedScopedAppFactory(
  source: string,
  exportName: string,
): boolean {
  if (exportName === "createAppWithRoutes") {
    return (
      source.endsWith("/app-factory-core") ||
      source.endsWith("/app-factory-core.ts")
    );
  }
  if (exportName === "createApp") {
    return (
      source.endsWith("/app-factory") || source.endsWith("/app-factory.ts")
    );
  }
  return (
    exportName === "setupApp" &&
    (source.endsWith("/__tests__/test-helpers") ||
      source.endsWith("/__tests__/test-helpers.ts"))
  );
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

function definingParameterFunction(
  sourceCode: Readonly<Parameters<typeof variableInScope>[0]>,
  identifier: TSESTree.Identifier,
): FunctionNode | null {
  const definition = variableInScope(sourceCode, identifier)?.defs.find(
    (candidate) => {
      return candidate.type === "Parameter";
    },
  );
  const node = definition?.node;
  if (
    node?.type === AST_NODE_TYPES.ArrowFunctionExpression ||
    node?.type === AST_NODE_TYPES.FunctionDeclaration ||
    node?.type === AST_NODE_TYPES.FunctionExpression
  ) {
    return node;
  }
  return null;
}

export const noUnownedUsagePricing = createRule({
  name: "no-unowned-usage-pricing",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Require raw usage-pricing test mutations to prove UUID, run, or fixture ownership",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      unownedPricing:
        "Raw usage-pricing mutations require a provider proven unique to this test (randomUUID/runId/lookupProvider). Use createUsagePricingFixture for canonical operator-managed providers.",
    },
  },
  create(context) {
    const importedMutations = new Map<string, MutationName>();
    const fixtureNamespaces = new Set<string>();
    const calls: TSESTree.CallExpression[] = [];
    const functionReturns = new Map<FunctionNode, TSESTree.Expression[]>();

    function addReturn(
      node: FunctionNode,
      expression: TSESTree.Expression,
    ): void {
      const returns = functionReturns.get(node) ?? [];
      returns.push(expression);
      functionReturns.set(node, returns);
    }

    function objectPropertyExpression(
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
            const spread = objectPropertyExpression(
              property.argument,
              name,
              nextSeen,
            );
            if (spread) {
              return spread;
            }
          }
        }
        return null;
      }
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return objectPropertyExpression(definition.node.init, name, nextSeen);
        }
      }
      return null;
    }

    function callsTo(node: FunctionNode): readonly TSESTree.CallExpression[] {
      const name = functionName(node);
      if (!name) {
        return [];
      }
      return calls.filter((call) => {
        const callee = call.callee;
        return (
          callee.type === AST_NODE_TYPES.Identifier && callee.name === name
        );
      });
    }

    function localFunctionCalledBy(
      call: TSESTree.CallExpression,
    ): FunctionNode | null {
      if (call.callee.type !== AST_NODE_TYPES.Identifier) {
        return null;
      }
      const definitions =
        variableInScope(context.sourceCode, call.callee)?.defs ?? [];
      return (
        [...functionReturns.keys()].find((candidate) => {
          return definitions.some((definition) => {
            return (
              definition.node === candidate ||
              (definition.node.type === AST_NODE_TYPES.VariableDeclarator &&
                definition.node.init === candidate)
            );
          });
        }) ?? null
      );
    }

    function argumentForParameter(
      identifier: TSESTree.Identifier,
      frame: CallFrame | null,
    ): {
      readonly expression: TSESTree.Expression;
      readonly frame: CallFrame | null;
    } | null {
      const owner = definingParameterFunction(context.sourceCode, identifier);
      if (!owner) {
        return null;
      }
      let ownerFrame = frame;
      while (ownerFrame && ownerFrame.functionNode !== owner) {
        ownerFrame = ownerFrame.parent;
      }
      if (!ownerFrame) {
        return null;
      }
      const index = parameterIndex(owner, identifier.name);
      const argument = ownerFrame.call.arguments[index];
      if (!argument || argument.type === AST_NODE_TYPES.SpreadElement) {
        return null;
      }
      return { expression: argument, frame: ownerFrame.parent };
    }

    function propertyExpressionInFrame(
      expression: TSESTree.Expression,
      name: string,
      frame: CallFrame | null,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): FramedExpression | null {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return null;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.ObjectExpression) {
        if (
          current.properties.some((property) => {
            return property.type === AST_NODE_TYPES.SpreadElement;
          })
        ) {
          return null;
        }
        const matches = current.properties.filter((property) => {
          return (
            property.type === AST_NODE_TYPES.Property &&
            propertyName(property) === name &&
            property.value.type !== AST_NODE_TYPES.AssignmentPattern
          );
        });
        const match = matches.length === 1 ? matches[0] : null;
        return match?.type === AST_NODE_TYPES.Property
          ? {
              expression: match.value as TSESTree.Expression,
              frame,
            }
          : null;
      }
      if (current.type !== AST_NODE_TYPES.Identifier) {
        return null;
      }
      const definition = variableInScope(context.sourceCode, current)?.defs[0];
      if (
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
        definition.node.init
      ) {
        return propertyExpressionInFrame(
          definition.node.init,
          name,
          frame,
          nextSeen,
        );
      }
      if (definition?.type !== "Parameter") {
        return null;
      }
      const argument = argumentForParameter(current, frame);
      return argument
        ? propertyExpressionInFrame(
            argument.expression,
            name,
            argument.frame,
            nextSeen,
          )
        : null;
    }

    function isSeedRunAction(
      expression: TSESTree.Expression,
      frame: CallFrame | null,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (
        current.type === AST_NODE_TYPES.Literal &&
        current.value === "seed-run"
      ) {
        return true;
      }
      if (current.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const definition = variableInScope(context.sourceCode, current)?.defs[0];
      if (
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
        definition.node.init
      ) {
        return isSeedRunAction(definition.node.init, frame, nextSeen);
      }
      if (definition?.type !== "Parameter") {
        return false;
      }
      const argument = argumentForParameter(current, frame);
      return Boolean(
        argument &&
        isSeedRunAction(argument.expression, argument.frame, nextSeen),
      );
    }

    function isSeedRunPayload(
      expression: TSESTree.Expression,
      frame: CallFrame | null,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const action = propertyExpressionInFrame(
        expression,
        "action",
        frame,
        seen,
      );
      return Boolean(
        action && isSeedRunAction(action.expression, action.frame, seen),
      );
    }

    function isSerializedSeedRunPayload(
      expression: TSESTree.Expression,
      frame: CallFrame | null,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return isSerializedSeedRunPayload(
            definition.node.init,
            frame,
            nextSeen,
          );
        }
        if (definition?.type === "Parameter") {
          const argument = argumentForParameter(current, frame);
          return Boolean(
            argument &&
            isSerializedSeedRunPayload(
              argument.expression,
              argument.frame,
              nextSeen,
            ),
          );
        }
        return false;
      }
      if (
        current.type !== AST_NODE_TYPES.CallExpression ||
        current.callee.type !== AST_NODE_TYPES.MemberExpression ||
        memberName(current.callee) !== "stringify" ||
        current.callee.object.type !== AST_NODE_TYPES.Identifier ||
        current.callee.object.name !== "JSON"
      ) {
        return false;
      }
      const payload = current.arguments[0];
      return Boolean(
        payload &&
        payload.type !== AST_NODE_TYPES.SpreadElement &&
        isSeedRunPayload(payload, frame, nextSeen),
      );
    }

    function isScopedRunStateRoutes(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const imported = importReference(context.sourceCode, current);
      if (
        imported &&
        isApprovedScopedRunStateRoute(imported.source, imported.importedName)
      ) {
        return true;
      }
      const definition = variableInScope(context.sourceCode, current)?.defs[0];
      return Boolean(
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
        definition.node.init &&
        isScopedRunStateRoutes(definition.node.init, nextSeen),
      );
    }

    function isScopedAppFactory(
      expression: TSESTree.CallExpression["callee"],
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      if (
        seen.has(expression) ||
        expression.type !== AST_NODE_TYPES.Identifier
      ) {
        return false;
      }
      const nextSeen = new Set(seen).add(expression);
      const imported = importReference(context.sourceCode, expression);
      if (
        imported &&
        isApprovedScopedAppFactory(imported.source, imported.importedName)
      ) {
        return true;
      }
      const definition = variableInScope(context.sourceCode, expression)
        ?.defs[0];
      return Boolean(
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
        definition.node.init &&
        isScopedAppFactory(definition.node.init, nextSeen),
      );
    }

    function isScopedRunStateApp(
      expression: TSESTree.Expression,
      frame: CallFrame | null,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return isScopedRunStateApp(definition.node.init, frame, nextSeen);
        }
        if (definition?.type === "Parameter") {
          const argument = argumentForParameter(current, frame);
          return Boolean(
            argument &&
            isScopedRunStateApp(argument.expression, argument.frame, nextSeen),
          );
        }
        return false;
      }
      if (current.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      if (!isScopedAppFactory(current.callee)) {
        return false;
      }
      const options = current.arguments[0];
      if (!options || options.type !== AST_NODE_TYPES.ObjectExpression) {
        return false;
      }
      return options.properties.some((property) => {
        return (
          property.type === AST_NODE_TYPES.Property &&
          propertyName(property) === "routes" &&
          property.value.type !== AST_NODE_TYPES.AssignmentPattern &&
          isScopedRunStateRoutes(property.value as TSESTree.Expression)
        );
      });
    }

    function isScopedRunStateResponse(
      expression: TSESTree.Expression,
      frame: CallFrame | null,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return isScopedRunStateResponse(
            definition.node.init,
            frame,
            nextSeen,
          );
        }
        if (definition?.type === "Parameter") {
          const argument = argumentForParameter(current, frame);
          return Boolean(
            argument &&
            isScopedRunStateResponse(
              argument.expression,
              argument.frame,
              nextSeen,
            ),
          );
        }
        return false;
      }
      if (current.type === AST_NODE_TYPES.AwaitExpression) {
        return isScopedRunStateResponse(current.argument, frame, nextSeen);
      }
      if (current.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      if (
        current.callee.type === AST_NODE_TYPES.MemberExpression &&
        current.callee.object.type !== AST_NODE_TYPES.Super
      ) {
        const name = memberName(current.callee);
        if (name === "request") {
          if (!isScopedRunStateApp(current.callee.object, frame)) {
            return false;
          }
          const options = current.arguments[1];
          if (!options || options.type === AST_NODE_TYPES.SpreadElement) {
            return false;
          }
          const body = propertyExpressionInFrame(
            options,
            "body",
            frame,
            nextSeen,
          );
          return Boolean(
            body &&
            isSerializedSeedRunPayload(body.expression, body.frame, nextSeen),
          );
        }
        if (name === "json") {
          return isScopedRunStateResponse(
            current.callee.object,
            frame,
            nextSeen,
          );
        }
        if (name === "resolve") {
          const value = current.arguments[0];
          return Boolean(
            value &&
            value.type !== AST_NODE_TYPES.SpreadElement &&
            isScopedRunStateResponse(value, frame, nextSeen),
          );
        }
      }
      const called = localFunctionCalledBy(current);
      if (!called) {
        return false;
      }
      const returns = functionReturns.get(called) ?? [];
      const calledFrame: CallFrame = {
        call: current,
        functionNode: called,
        parent: frame,
      };
      return (
        returns.length > 0 &&
        returns.every((returned) => {
          return isScopedRunStateResponse(returned, calledFrame, nextSeen);
        })
      );
    }

    function isScopedSeedRunResult(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        return Boolean(
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init &&
          isScopedSeedRunResult(definition.node.init, nextSeen),
        );
      }
      if (current.type === AST_NODE_TYPES.AwaitExpression) {
        return isScopedSeedRunResult(current.argument, nextSeen);
      }
      if (current.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      const called = localFunctionCalledBy(current);
      if (!called) {
        return false;
      }
      const returns = functionReturns.get(called) ?? [];
      const frame: CallFrame = {
        call: current,
        functionNode: called,
        parent: null,
      };
      return (
        returns.length > 0 &&
        returns.every((returned) => {
          return isScopedRunStateResponse(returned, frame, nextSeen);
        })
      );
    }

    function isScopedSeedRunId(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        return Boolean(
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init &&
          isScopedSeedRunId(definition.node.init, nextSeen),
        );
      }
      if (current.type === AST_NODE_TYPES.MemberExpression) {
        return (
          memberName(current) === "run_id" &&
          current.object.type !== AST_NODE_TYPES.Super &&
          isScopedSeedRunResult(current.object, nextSeen)
        );
      }
      if (
        current.type !== AST_NODE_TYPES.CallExpression ||
        current.arguments.length < 2
      ) {
        return false;
      }
      const response = current.arguments[0];
      const field = current.arguments[1];
      if (
        !response ||
        response.type === AST_NODE_TYPES.SpreadElement ||
        field?.type !== AST_NODE_TYPES.Literal ||
        field.value !== "run_id"
      ) {
        return false;
      }
      return isScopedSeedRunResult(response, nextSeen);
    }

    function isScopedRunFixtureFactory(node: FunctionNode): boolean {
      const returns = functionReturns.get(node) ?? [];
      return (
        returns.length > 0 &&
        returns.every((returned) => {
          const runId = objectPropertyExpression(returned, "runId", new Set());
          return Boolean(runId && isScopedSeedRunId(runId));
        })
      );
    }

    function ownedParameterValue(
      identifier: TSESTree.Identifier,
      property: string | null,
      seen: ReadonlySet<TSESTree.Node>,
    ): boolean {
      const owner = definingParameterFunction(context.sourceCode, identifier);
      if (!owner) {
        return false;
      }
      const index = parameterIndex(owner, identifier.name);
      if (index < 0) {
        return false;
      }
      const callSites = callsTo(owner);
      if (callSites.length === 0) {
        return false;
      }
      return callSites.every((call) => {
        const argument = call.arguments[index];
        if (!argument || argument.type === AST_NODE_TYPES.SpreadElement) {
          return false;
        }
        const value = property
          ? objectPropertyExpression(argument, property, seen)
          : argument;
        return value ? isOwnedProvider(value, seen) : false;
      });
    }

    function isUsagePricingFixtureSource(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node>,
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return isUsagePricingFixtureSource(definition.node.init, nextSeen);
        }
        if (definition?.type === "Parameter") {
          const owner = definingParameterFunction(context.sourceCode, current);
          if (!owner) {
            return false;
          }
          const index = parameterIndex(owner, current.name);
          const callSites = callsTo(owner);
          return (
            callSites.length > 0 &&
            callSites.every((call) => {
              const argument = call.arguments[index];
              return Boolean(
                argument &&
                argument.type !== AST_NODE_TYPES.SpreadElement &&
                isUsagePricingFixtureSource(argument, nextSeen),
              );
            })
          );
        }
        return false;
      }
      if (current.type === AST_NODE_TYPES.AwaitExpression) {
        return isUsagePricingFixtureSource(current.argument, nextSeen);
      }
      if (current.type === AST_NODE_TYPES.MemberExpression) {
        return (
          current.object.type !== AST_NODE_TYPES.Super &&
          isUsagePricingFixtureSource(current.object, nextSeen)
        );
      }
      if (current.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      if (current.callee.type === AST_NODE_TYPES.Identifier) {
        const calleeName = current.callee.name;
        const imported = importReference(context.sourceCode, current.callee);
        if (
          imported?.importedName === "createUsagePricingFixture" &&
          isPricingFixtureModule(imported.source)
        ) {
          return true;
        }
        const localFunction = [...functionReturns.keys()].find((candidate) => {
          return functionName(candidate) === calleeName;
        });
        if (localFunction) {
          const returns = functionReturns.get(localFunction) ?? [];
          return (
            returns.length > 0 &&
            returns.every((returned) => {
              return isUsagePricingFixtureSource(returned, nextSeen);
            })
          );
        }
      }
      return (
        current.callee.type === AST_NODE_TYPES.MemberExpression &&
        current.callee.object.type !== AST_NODE_TYPES.Super &&
        isUsagePricingFixtureSource(current.callee.object, nextSeen)
      );
    }

    function isRunFixtureSource(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node>,
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return isRunFixtureSource(definition.node.init, nextSeen);
        }
        if (definition?.type === "Parameter") {
          const owner = definingParameterFunction(context.sourceCode, current);
          if (!owner) {
            return false;
          }
          const index = parameterIndex(owner, current.name);
          const callSites = callsTo(owner);
          return (
            callSites.length > 0 &&
            callSites.every((call) => {
              const argument = call.arguments[index];
              return Boolean(
                argument &&
                argument.type !== AST_NODE_TYPES.SpreadElement &&
                isRunFixtureSource(argument, nextSeen),
              );
            })
          );
        }
        return false;
      }
      if (current.type === AST_NODE_TYPES.AwaitExpression) {
        return isRunFixtureSource(current.argument, nextSeen);
      }
      if (current.type === AST_NODE_TYPES.MemberExpression) {
        return (
          current.object.type !== AST_NODE_TYPES.Super &&
          isRunFixtureSource(current.object, nextSeen)
        );
      }
      if (current.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      const calleeName =
        current.callee.type === AST_NODE_TYPES.Identifier
          ? current.callee.name
          : current.callee.type === AST_NODE_TYPES.MemberExpression
            ? memberName(current.callee)
            : null;
      if (calleeName && RUN_FACTORY_NAMES.has(calleeName)) {
        if (
          current.callee.type === AST_NODE_TYPES.MemberExpression &&
          current.callee.object.type !== AST_NODE_TYPES.Super &&
          isRunClientSource(current.callee.object, nextSeen)
        ) {
          return true;
        }
      }
      if (calleeName === "trackRun") {
        return current.arguments.some((argument) => {
          return (
            argument.type !== AST_NODE_TYPES.SpreadElement &&
            isRunFixtureSource(argument, nextSeen)
          );
        });
      }
      if (current.callee.type === AST_NODE_TYPES.Identifier) {
        const localFunction = localFunctionCalledBy(current);
        if (localFunction) {
          if (isScopedRunFixtureFactory(localFunction)) {
            return true;
          }
          const returns = functionReturns.get(localFunction) ?? [];
          return (
            returns.length > 0 &&
            returns.every((returned) => {
              return isRunFixtureSource(returned, nextSeen);
            })
          );
        }
      }
      return false;
    }

    function isRunClientSource(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node>,
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        return Boolean(
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init &&
          isRunClientSource(definition.node.init, nextSeen),
        );
      }
      if (current.type !== AST_NODE_TYPES.CallExpression) {
        return false;
      }
      if (current.callee.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const imported = importReference(context.sourceCode, current.callee);
      return Boolean(
        imported &&
        isApprovedRunClientFactory(imported.source, imported.importedName),
      );
    }

    function isOwnedProvider(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);

      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return isOwnedProvider(definition.node.init, nextSeen);
        }
        if (definition?.type === "Parameter") {
          return ownedParameterValue(current, null, nextSeen);
        }
        return false;
      }

      if (current.type === AST_NODE_TYPES.MemberExpression) {
        const name = memberName(current);
        if (current.object.type === AST_NODE_TYPES.Super) {
          return false;
        }
        if (name === "lookupProvider") {
          return isUsagePricingFixtureSource(current.object, nextSeen);
        }
        if (name === "runId") {
          return isRunFixtureSource(current.object, nextSeen);
        }
        if (
          name &&
          current.object.type === AST_NODE_TYPES.Identifier &&
          variableInScope(context.sourceCode, current.object)?.defs[0]?.type ===
            "Parameter"
        ) {
          return ownedParameterValue(current.object, name, nextSeen);
        }
        return false;
      }

      if (current.type === AST_NODE_TYPES.CallExpression) {
        if (current.callee.type === AST_NODE_TYPES.Identifier) {
          const calleeName = current.callee.name;
          const imported = importReference(context.sourceCode, current.callee);
          if (
            imported?.source === "node:crypto" &&
            imported.importedName === "randomUUID"
          ) {
            return true;
          }
          const localFunction = [...functionReturns.keys()].find(
            (candidate) => {
              return functionName(candidate) === calleeName;
            },
          );
          const returns = localFunction
            ? (functionReturns.get(localFunction) ?? [])
            : [];
          if (returns.length > 0) {
            return returns.every((returned) => {
              return isOwnedProvider(returned, nextSeen);
            });
          }
        }
        if (
          current.callee.type === AST_NODE_TYPES.MemberExpression &&
          current.callee.object.type !== AST_NODE_TYPES.Super
        ) {
          return isOwnedProvider(current.callee.object, nextSeen);
        }
        return false;
      }

      if (current.type === AST_NODE_TYPES.TemplateLiteral) {
        return current.expressions.some((part) => {
          return isOwnedProvider(part, nextSeen);
        });
      }
      if (current.type === AST_NODE_TYPES.BinaryExpression) {
        return (
          (current.left.type !== AST_NODE_TYPES.PrivateIdentifier &&
            isOwnedProvider(current.left, nextSeen)) ||
          isOwnedProvider(current.right, nextSeen)
        );
      }
      if (
        current.type === AST_NODE_TYPES.ConditionalExpression ||
        current.type === AST_NODE_TYPES.LogicalExpression
      ) {
        return (
          isOwnedProvider(
            current.type === AST_NODE_TYPES.ConditionalExpression
              ? current.consequent
              : current.left,
            nextSeen,
          ) &&
          isOwnedProvider(
            current.type === AST_NODE_TYPES.ConditionalExpression
              ? current.alternate
              : current.right,
            nextSeen,
          )
        );
      }
      if (current.type === AST_NODE_TYPES.SequenceExpression) {
        const finalExpression = current.expressions.at(-1);
        return finalExpression
          ? isOwnedProvider(finalExpression, nextSeen)
          : false;
      }
      if (current.type === AST_NODE_TYPES.AwaitExpression) {
        return isOwnedProvider(current.argument, nextSeen);
      }
      return false;
    }

    function providerExpressions(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): readonly TSESTree.Expression[] {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return [];
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.ArrayExpression) {
        return current.elements.flatMap((element) => {
          if (!element) {
            return [];
          }
          return providerExpressions(
            element.type === AST_NODE_TYPES.SpreadElement
              ? element.argument
              : element,
            nextSeen,
          );
        });
      }
      if (current.type === AST_NODE_TYPES.ObjectExpression) {
        return current.properties.flatMap((property) => {
          if (property.type === AST_NODE_TYPES.SpreadElement) {
            return providerExpressions(property.argument, nextSeen);
          }
          if (
            propertyName(property) === "provider" &&
            property.value.type !== AST_NODE_TYPES.AssignmentPattern
          ) {
            return [property.value as TSESTree.Expression];
          }
          return [];
        });
      }
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return providerExpressions(definition.node.init, nextSeen);
        }
        return [];
      }
      if (
        current.type === AST_NODE_TYPES.CallExpression &&
        current.callee.type === AST_NODE_TYPES.MemberExpression &&
        memberName(current.callee) === "map"
      ) {
        const callback = current.arguments[0];
        if (
          callback?.type === AST_NODE_TYPES.ArrowFunctionExpression ||
          callback?.type === AST_NODE_TYPES.FunctionExpression
        ) {
          return (functionReturns.get(callback) ?? []).flatMap((returned) => {
            return providerExpressions(returned, nextSeen);
          });
        }
        return [];
      }
      if (current.type === AST_NODE_TYPES.ConditionalExpression) {
        return [
          ...providerExpressions(current.consequent, nextSeen),
          ...providerExpressions(current.alternate, nextSeen),
        ];
      }
      return [];
    }

    function mutationName(
      callee: TSESTree.CallExpression["callee"],
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): MutationName | null {
      if (seen.has(callee)) {
        return null;
      }
      const nextSeen = new Set(seen).add(callee);
      if (callee.type === AST_NODE_TYPES.Identifier) {
        const imported = importedMutations.get(callee.name);
        if (imported) {
          return imported;
        }
        const definition = variableInScope(context.sourceCode, callee)?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init &&
          (definition.node.init.type === AST_NODE_TYPES.Identifier ||
            definition.node.init.type === AST_NODE_TYPES.MemberExpression)
        ) {
          return mutationName(definition.node.init, nextSeen);
        }
        return null;
      }
      if (
        callee.type === AST_NODE_TYPES.MemberExpression &&
        callee.object.type === AST_NODE_TYPES.Identifier &&
        fixtureNamespaces.has(callee.object.name)
      ) {
        const name = memberName(callee);
        return name && RAW_MUTATIONS.has(name as MutationName)
          ? (name as MutationName)
          : null;
      }
      return null;
    }

    function checkMutation(call: TSESTree.CallExpression): void {
      const mutation = mutationName(call.callee);
      if (!mutation) {
        return;
      }
      const argument = call.arguments[0];
      if (!argument || argument.type === AST_NODE_TYPES.SpreadElement) {
        context.report({ node: call, messageId: "unownedPricing" });
        return;
      }
      const providers = providerExpressions(argument);
      if (providers.length === 0) {
        context.report({ node: argument, messageId: "unownedPricing" });
        return;
      }
      for (const provider of providers) {
        if (!isOwnedProvider(provider)) {
          context.report({ node: provider, messageId: "unownedPricing" });
        }
      }
    }

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (
          typeof node.source.value !== "string" ||
          !isPricingFixtureModule(node.source.value)
        ) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
            fixtureNamespaces.add(specifier.local.name);
            continue;
          }
          if (specifier.type !== AST_NODE_TYPES.ImportSpecifier) {
            continue;
          }
          const importedName =
            specifier.imported.type === AST_NODE_TYPES.Identifier
              ? specifier.imported.name
              : String(specifier.imported.value);
          if (RAW_MUTATIONS.has(importedName as MutationName)) {
            importedMutations.set(
              specifier.local.name,
              importedName as MutationName,
            );
          }
        }
      },
      ArrowFunctionExpression(node: TSESTree.ArrowFunctionExpression) {
        if (node.body.type !== AST_NODE_TYPES.BlockStatement) {
          addReturn(node, node.body);
        } else if (!functionReturns.has(node)) {
          functionReturns.set(node, []);
        }
      },
      FunctionDeclaration(node: TSESTree.FunctionDeclaration) {
        if (!functionReturns.has(node)) {
          functionReturns.set(node, []);
        }
      },
      FunctionExpression(node: TSESTree.FunctionExpression) {
        if (!functionReturns.has(node)) {
          functionReturns.set(node, []);
        }
      },
      ReturnStatement(node: TSESTree.ReturnStatement) {
        const owner = enclosingFunction(node);
        if (owner && node.argument) {
          addReturn(owner, node.argument);
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
