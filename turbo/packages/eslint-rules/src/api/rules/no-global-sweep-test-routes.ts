import { AST_NODE_TYPES, type TSESTree } from "@typescript-eslint/utils";

import {
  importReference,
  memberName,
  propertyName,
  resolveLocalExpression,
  unwrapExpression,
  variableInScope,
} from "../syntax.ts";
import { createRule } from "../utils.ts";

type FunctionNode =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression;

interface ObjectBinding {
  readonly defaultValue: TSESTree.Expression | null;
  readonly property: string | null;
}

interface ParameterBinding extends ObjectBinding {
  readonly index: number;
  readonly parameterDefault: TSESTree.Expression | null;
}

interface ParameterSource {
  readonly binding: ParameterBinding;
  readonly source: TSESTree.Expression;
}

type FactoryPropertyResolution =
  "canonical" | "missing" | "noncanonical" | "undefined" | "unknown";
type FactoryValueKind = "factory" | "namespace";

interface GlobalSweepBoundary {
  readonly exportName: string;
  readonly moduleName: string;
  readonly path: string;
}

const GLOBAL_SWEEP_BOUNDARIES: readonly GlobalSweepBoundary[] = [
  {
    exportName: "cronCleanupSandboxesRoutes",
    moduleName: "cron-cleanup-sandboxes",
    path: "/api/cron/cleanup-sandboxes",
  },
  {
    exportName: "cronReconcileBillingEntitlementsRoutes",
    moduleName: "cron-reconcile-billing-entitlements",
    path: "/api/cron/reconcile-billing-entitlements",
  },
  {
    exportName: "cronDrainEmailOutboxRoutes",
    moduleName: "cron-drain-email-outbox",
    path: "/api/cron/drain-email-outbox",
  },
  {
    exportName: "cronBrowserReconcileRoutes",
    moduleName: "cron-browser-reconcile",
    path: "/api/cron/reconcile-browsers",
  },
  {
    exportName: "cronConnectorOauthStateCleanupRoutes",
    moduleName: "cron-connector-oauth-state-cleanup",
    path: "/api/cron/connector-oauth-state-cleanup",
  },
  {
    exportName: "cronComputerUseScreenshotCleanupRoutes",
    moduleName: "cron-computer-use-screenshot-cleanup",
    path: "/api/cron/computer-use-screenshot-cleanup",
  },
  {
    exportName: "cronSyncSkillsRoutes",
    moduleName: "cron-sync-skills",
    path: "/api/cron/sync-skills",
  },
  {
    exportName: "cronExecuteWorkflowAutomationsRoutes",
    moduleName: "cron-execute-workflow-automations",
    path: "/api/cron/execute-workflow-automations",
  },
];

const CONTRACT_HARNESS_SUFFIX =
  "/src/signals/routes/__tests__/global-sweep-contracts.test.ts";
const PRODUCTION_ROUTE_SUFFIX = "/src/signals/route.ts";
const CONTRACT_HELPER_SUFFIX =
  "/signals/routes/__tests__/helpers/global-sweep-contract";
const CONTRACT_HELPER_RELATIVE = "./helpers/global-sweep-contract";
const UNAUTHORIZED_HELPERS = new Set([
  "expectGlobalSweepMissingAuth",
  "expectGlobalSweepWrongAuth",
]);
const APP_FACTORIES = new Set(["createApp", "createAppWithRoutes", "setupApp"]);

function isCanonicalAppFactoryModule(source: string): boolean {
  const normalizedSource = source.replace(/\.(?:[cm]?[jt]s)$/u, "");
  return (
    normalizedSource.endsWith("/app-factory") ||
    normalizedSource.endsWith("/app-factory-core") ||
    normalizedSource.endsWith("/__tests__/test-helpers")
  );
}

function normalizedFilename(filename: string): string {
  return filename.replaceAll("\\", "/");
}

function resolvesToProductionRoute(filename: string, source: string): boolean {
  const normalizedSource = source.replace(/\.(?:[cm]?[jt]s)$/u, "");
  if (!normalizedSource.startsWith(".")) {
    return normalizedSource.endsWith("/src/signals/route");
  }
  const segments = normalizedFilename(filename).split("/");
  segments.pop();
  for (const segment of normalizedSource.split("/")) {
    if (segment === "." || segment === "") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/").endsWith("/src/signals/route");
}

function moduleName(source: string): string {
  const finalSegment = source.split("/").at(-1) ?? source;
  return finalSegment.replace(/\.(?:[cm]?[jt]s)$/, "");
}

function boundaryForImport(
  source: string,
  importedName: string,
): GlobalSweepBoundary | undefined {
  const importedModule = moduleName(source);
  return GLOBAL_SWEEP_BOUNDARIES.find((boundary) => {
    return (
      boundary.moduleName === importedModule &&
      boundary.exportName === importedName
    );
  });
}

function boundariesForModule(source: string): readonly GlobalSweepBoundary[] {
  const importedModule = moduleName(source);
  return GLOBAL_SWEEP_BOUNDARIES.filter((boundary) => {
    return boundary.moduleName === importedModule;
  });
}

function staticString(
  expression: TSESTree.CallExpressionArgument,
): string | null {
  if (
    expression.type === AST_NODE_TYPES.Literal &&
    typeof expression.value === "string"
  ) {
    return expression.value;
  }
  if (
    expression.type === AST_NODE_TYPES.TemplateLiteral &&
    expression.expressions.length === 0
  ) {
    return expression.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function isApprovedHarnessReference(
  identifier: TSESTree.Identifier,
  boundary: GlobalSweepBoundary,
  context: Readonly<{ sourceCode: Parameters<typeof importReference>[0] }>,
): boolean {
  const call = identifier.parent;
  if (
    call.type !== AST_NODE_TYPES.CallExpression ||
    call.arguments.length !== 3 ||
    call.arguments[1] !== identifier ||
    call.callee.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }
  const helper = importReference(context.sourceCode, call.callee);
  if (
    !helper ||
    (helper.source !== CONTRACT_HELPER_RELATIVE &&
      !helper.source.endsWith(CONTRACT_HELPER_SUFFIX)) ||
    helper.importedName === "default"
  ) {
    return false;
  }
  const pathArgument = call.arguments[2];
  if (!pathArgument || pathArgument.type === AST_NODE_TYPES.SpreadElement) {
    return false;
  }
  const path = staticString(pathArgument);
  return (
    UNAUTHORIZED_HELPERS.has(helper.importedName) && path === boundary.path
  );
}

export const noGlobalSweepTestRoutes = createRule({
  name: "no-global-sweep-test-routes",
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep API test correctness on fixture-scoped state routes instead of production-global sweeps",
      requiresTypeChecking: false,
    },
    schema: [],
    messages: {
      globalSweep:
        "Production-global route '{{ routeName }}' is not an approved correctness boundary. Use a fixture-scoped test route; contract coverage may pass it directly only to the fixed no-auth helper.",
    },
  },
  create(context) {
    const filename = normalizedFilename(context.filename);
    const isProductionRoute = filename.endsWith(PRODUCTION_ROUTE_SUFFIX);
    const isContractHarness = filename.endsWith(CONTRACT_HARNESS_SUFFIX);
    const harnessBindings: {
      readonly boundary: GlobalSweepBoundary;
      readonly specifier: TSESTree.ImportSpecifier;
    }[] = [];
    const calls: TSESTree.CallExpression[] = [];

    function report(node: TSESTree.Node, boundary: GlobalSweepBoundary): void {
      context.report({
        node,
        messageId: "globalSweep",
        data: { routeName: boundary.exportName },
      });
    }

    function reportAggregateRoutes(node: TSESTree.Node): void {
      context.report({
        node,
        messageId: "globalSweep",
        data: { routeName: "ROUTES" },
      });
    }

    function localFunctionForCallee(
      expression: TSESTree.CallExpression["callee"],
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): FunctionNode | null {
      if (
        seen.has(expression) ||
        expression.type !== AST_NODE_TYPES.Identifier
      ) {
        return null;
      }
      const nextSeen = new Set(seen).add(expression);
      const definitions =
        variableInScope(context.sourceCode, expression)?.defs ?? [];
      for (const definition of definitions) {
        if (definition.type === "Parameter") {
          continue;
        }
        const node = definition.node;
        if (
          node.type === AST_NODE_TYPES.ArrowFunctionExpression ||
          node.type === AST_NODE_TYPES.FunctionDeclaration ||
          node.type === AST_NODE_TYPES.FunctionExpression
        ) {
          return node;
        }
        if (node.type === AST_NODE_TYPES.VariableDeclarator && node.init) {
          if (
            node.init.type === AST_NODE_TYPES.ArrowFunctionExpression ||
            node.init.type === AST_NODE_TYPES.FunctionExpression
          ) {
            return node.init;
          }
          if (node.init.type === AST_NODE_TYPES.Identifier) {
            const localFunction = localFunctionForCallee(node.init, nextSeen);
            if (localFunction) {
              return localFunction;
            }
          }
        }
      }
      return null;
    }

    function parameterOwner(
      identifier: TSESTree.Identifier,
    ): FunctionNode | null {
      const definition = variableInScope(
        context.sourceCode,
        identifier,
      )?.defs.find((candidate) => {
        return candidate.type === "Parameter";
      });
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

    function objectBinding(
      pattern: TSESTree.ObjectPattern,
      name: string,
    ): ObjectBinding | null {
      for (const entry of pattern.properties) {
        if (entry.type !== AST_NODE_TYPES.Property) {
          continue;
        }
        if (
          entry.value.type === AST_NODE_TYPES.Identifier &&
          entry.value.name === name
        ) {
          return { defaultValue: null, property: propertyName(entry) };
        }
        if (
          entry.value.type === AST_NODE_TYPES.AssignmentPattern &&
          entry.value.left.type === AST_NODE_TYPES.Identifier &&
          entry.value.left.name === name
        ) {
          return {
            defaultValue: entry.value.right,
            property: propertyName(entry),
          };
        }
      }
      return null;
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
        const parameterDefault =
          rawParameter.type === AST_NODE_TYPES.AssignmentPattern
            ? rawParameter.right
            : null;
        if (
          parameter.type === AST_NODE_TYPES.Identifier &&
          parameter.name === name
        ) {
          return {
            defaultValue: null,
            index,
            parameterDefault,
            property: null,
          };
        }
        if (parameter.type !== AST_NODE_TYPES.ObjectPattern) {
          continue;
        }
        const binding = objectBinding(parameter, name);
        if (binding) {
          return { ...binding, index, parameterDefault };
        }
      }
      return null;
    }

    function parameterSources(
      identifier: TSESTree.Identifier,
    ): readonly ParameterSource[] {
      const owner = parameterOwner(identifier);
      if (!owner) {
        return [];
      }
      const binding = parameterBinding(owner, identifier.name);
      if (!binding) {
        return [];
      }
      return calls.flatMap((call) => {
        if (localFunctionForCallee(call.callee) !== owner) {
          return [];
        }
        const argument = call.arguments[binding.index];
        const explicitArgument =
          argument && argument.type !== AST_NODE_TYPES.SpreadElement
            ? argument
            : null;
        const source =
          explicitArgument &&
          (!binding.parameterDefault ||
            !isStaticallyUndefined(explicitArgument))
            ? explicitArgument
            : binding.parameterDefault;
        return source ? [{ binding, source }] : [];
      });
    }

    function aggregateObjectBinding(
      source: TSESTree.Expression,
      defaultValue: TSESTree.Expression | null,
      seen: ReadonlySet<TSESTree.Node>,
    ): boolean {
      const resolution = aggregateRoutesOption(source, seen);
      if (resolution !== null) {
        return resolution;
      }
      return Boolean(defaultValue && isAggregateRoutes(defaultValue, seen));
    }

    function isAggregateRoutes(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return false;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        const imported = importReference(context.sourceCode, current);
        if (
          imported?.importedName === "ROUTES" &&
          resolvesToProductionRoute(filename, imported.source)
        ) {
          return true;
        }
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init &&
          definition.node.id.type === AST_NODE_TYPES.ObjectPattern
        ) {
          const binding = objectBinding(definition.node.id, current.name);
          if (binding?.property === "routes") {
            return aggregateObjectBinding(
              definition.node.init,
              binding.defaultValue,
              nextSeen,
            );
          }
        }
        if (definition?.type === "Parameter") {
          return parameterSources(current).some(({ binding, source }) => {
            if (binding.property === null) {
              return isAggregateRoutes(source, nextSeen);
            }
            return (
              binding.property === "routes" &&
              aggregateObjectBinding(source, binding.defaultValue, nextSeen)
            );
          });
        }
        return Boolean(
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init &&
          isAggregateRoutes(definition.node.init, nextSeen),
        );
      }
      if (current.type === AST_NODE_TYPES.MemberExpression) {
        const name = memberName(current);
        if (
          name === "ROUTES" &&
          current.object.type === AST_NODE_TYPES.Identifier
        ) {
          const imported = importReference(context.sourceCode, current.object);
          return Boolean(
            imported?.importedName === "*" &&
            resolvesToProductionRoute(filename, imported.source),
          );
        }
        if (name === "routes" && current.object.type !== AST_NODE_TYPES.Super) {
          return aggregateRoutesOption(current.object, nextSeen) === true;
        }
      }
      if (current.type === AST_NODE_TYPES.ArrayExpression) {
        return current.elements.some((element) => {
          return Boolean(
            element &&
            isAggregateRoutes(
              element.type === AST_NODE_TYPES.SpreadElement
                ? element.argument
                : element,
              nextSeen,
            ),
          );
        });
      }
      return false;
    }

    function aggregateRoutesOption(
      expression: TSESTree.Expression,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean | null {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return null;
      }
      const nextSeen = new Set(seen).add(current);
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          return aggregateRoutesOption(definition.node.init, nextSeen);
        }
        if (definition?.type === "Parameter") {
          const resolutions = parameterSources(current)
            .filter(({ binding }) => binding.property === null)
            .map(({ source }) => {
              return aggregateRoutesOption(source, nextSeen);
            });
          if (resolutions.some((resolution) => resolution === true)) {
            return true;
          }
          return resolutions.length > 0 &&
            resolutions.every((resolution) => resolution === false)
            ? false
            : null;
        }
        return null;
      }
      if (current.type !== AST_NODE_TYPES.ObjectExpression) {
        return null;
      }
      for (const property of [...current.properties].reverse()) {
        if (property.type === AST_NODE_TYPES.SpreadElement) {
          const spread = aggregateRoutesOption(property.argument, nextSeen);
          if (spread !== null) {
            return spread;
          }
          continue;
        }
        if (
          propertyName(property) === "routes" &&
          property.value.type !== AST_NODE_TYPES.AssignmentPattern
        ) {
          return isAggregateRoutes(
            property.value as TSESTree.Expression,
            nextSeen,
          );
        }
      }
      return null;
    }

    function isAppFactoryNamespace(
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
        isCanonicalAppFactoryModule(imported.source)
      ) {
        return true;
      }
      const definition = variableInScope(context.sourceCode, current)?.defs[0];
      if (definition?.type === "Parameter") {
        const sources = parameterSources(current);
        return sources.some(({ binding, source }) => {
          return (
            factoryBindingResolution(
              source,
              binding,
              [],
              "namespace",
              nextSeen,
            ) === "canonical"
          );
        });
      }
      return Boolean(
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
        definition.node.init &&
        isAppFactoryNamespace(definition.node.init, nextSeen),
      );
    }

    function combineFactoryResolutions(
      resolutions: readonly FactoryPropertyResolution[],
    ): FactoryPropertyResolution {
      if (resolutions.some((resolution) => resolution === "canonical")) {
        return "canonical";
      }
      if (resolutions.some((resolution) => resolution === "undefined")) {
        return "undefined";
      }
      if (resolutions.some((resolution) => resolution === "missing")) {
        return "missing";
      }
      if (resolutions.some((resolution) => resolution === "unknown")) {
        return "unknown";
      }
      return resolutions.length > 0 ? "noncanonical" : "unknown";
    }

    function isStaticallyUndefined(expression: TSESTree.Expression): boolean {
      const current = resolveLocalExpression(context.sourceCode, expression);
      if (
        current.type === AST_NODE_TYPES.UnaryExpression &&
        current.operator === "void"
      ) {
        return true;
      }
      if (
        current.type !== AST_NODE_TYPES.Identifier ||
        current.name !== "undefined"
      ) {
        return false;
      }
      const variable = variableInScope(context.sourceCode, current);
      return !variable || variable.defs.length === 0;
    }

    function factoryBindingResolution(
      source: TSESTree.Expression,
      binding: ObjectBinding,
      remainingPath: readonly string[],
      kind: FactoryValueKind,
      seen: ReadonlySet<TSESTree.Node>,
    ): FactoryPropertyResolution {
      if (binding.property === null) {
        return factoryPathResolution(source, remainingPath, kind, seen);
      }
      const resolution = factoryPathResolution(
        source,
        [binding.property, ...remainingPath],
        kind,
        seen,
      );
      if (
        (resolution !== "missing" && resolution !== "undefined") ||
        !binding.defaultValue
      ) {
        return resolution;
      }
      return factoryPathResolution(
        binding.defaultValue,
        remainingPath,
        kind,
        seen,
      );
    }

    function factoryPathResolution(
      expression: TSESTree.Expression,
      path: readonly string[],
      kind: FactoryValueKind,
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): FactoryPropertyResolution {
      const current = unwrapExpression(expression);
      if (seen.has(current)) {
        return "unknown";
      }
      const nextSeen = new Set(seen).add(current);
      if (path.length === 0) {
        if (isStaticallyUndefined(current)) {
          return "undefined";
        }
        if (
          current.type === AST_NODE_TYPES.MemberExpression &&
          current.object.type !== AST_NODE_TYPES.Super
        ) {
          const name = memberName(current);
          return name
            ? factoryPathResolution(current.object, [name], kind, nextSeen)
            : "unknown";
        }
        const isCanonical =
          kind === "namespace"
            ? isAppFactoryNamespace(current, seen)
            : isAppFactory(current, seen);
        return isCanonical ? "canonical" : "noncanonical";
      }
      const [name, ...remainingPath] = path;
      if (
        name &&
        remainingPath.length === 0 &&
        kind === "factory" &&
        APP_FACTORIES.has(name) &&
        isAppFactoryNamespace(current, seen)
      ) {
        return "canonical";
      }
      if (current.type === AST_NODE_TYPES.Identifier) {
        const definition = variableInScope(context.sourceCode, current)
          ?.defs[0];
        if (
          definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
          definition.node.init
        ) {
          if (definition.node.id.type === AST_NODE_TYPES.ObjectPattern) {
            const binding = objectBinding(definition.node.id, current.name);
            return binding
              ? factoryBindingResolution(
                  definition.node.init,
                  binding,
                  path,
                  kind,
                  nextSeen,
                )
              : "unknown";
          }
          return factoryPathResolution(
            definition.node.init,
            path,
            kind,
            nextSeen,
          );
        }
        if (definition?.type === "Parameter") {
          const resolutions = parameterSources(current).map(
            ({ binding, source }) => {
              return factoryBindingResolution(
                source,
                binding,
                path,
                kind,
                nextSeen,
              );
            },
          );
          return combineFactoryResolutions(resolutions);
        }
        return importReference(context.sourceCode, current)
          ? "noncanonical"
          : "unknown";
      }
      if (current.type !== AST_NODE_TYPES.ObjectExpression) {
        return "unknown";
      }
      for (const property of [...current.properties].reverse()) {
        if (property.type === AST_NODE_TYPES.SpreadElement) {
          const spread = factoryPathResolution(
            property.argument,
            path,
            kind,
            nextSeen,
          );
          if (spread !== "missing") {
            return spread;
          }
          continue;
        }
        if (
          propertyName(property) === name &&
          property.value.type !== AST_NODE_TYPES.AssignmentPattern
        ) {
          return factoryPathResolution(
            property.value as TSESTree.Expression,
            remainingPath,
            kind,
            nextSeen,
          );
        }
      }
      return "missing";
    }

    function isAppFactory(
      expression: TSESTree.CallExpression["callee"],
      seen: ReadonlySet<TSESTree.Node> = new Set(),
    ): boolean {
      if (seen.has(expression)) {
        return false;
      }
      const nextSeen = new Set(seen).add(expression);
      if (expression.type === AST_NODE_TYPES.MemberExpression) {
        const name = memberName(expression);
        return Boolean(
          name &&
          APP_FACTORIES.has(name) &&
          expression.object.type !== AST_NODE_TYPES.Super &&
          isAppFactoryNamespace(expression.object, nextSeen),
        );
      }
      if (expression.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const imported = importReference(context.sourceCode, expression);
      if (
        (imported && APP_FACTORIES.has(imported.importedName)) ||
        APP_FACTORIES.has(expression.name)
      ) {
        return true;
      }
      const definition = variableInScope(context.sourceCode, expression)
        ?.defs[0];
      if (definition?.type === "Parameter") {
        const sources = parameterSources(expression);
        return sources.some(({ binding, source }) => {
          return (
            factoryBindingResolution(
              source,
              binding,
              [],
              "factory",
              nextSeen,
            ) === "canonical"
          );
        });
      }
      if (
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
        definition.node.init &&
        definition.node.id.type === AST_NODE_TYPES.ObjectPattern
      ) {
        const binding = objectBinding(definition.node.id, expression.name);
        if (
          binding &&
          factoryBindingResolution(
            definition.node.init,
            binding,
            [],
            "factory",
            nextSeen,
          ) === "canonical"
        ) {
          return true;
        }
      }
      return Boolean(
        definition?.node.type === AST_NODE_TYPES.VariableDeclarator &&
        definition.node.init &&
        isAppFactory(definition.node.init, nextSeen),
      );
    }

    function isAggregateAppFactoryMount(
      call: TSESTree.CallExpression,
    ): boolean {
      if (!isAppFactory(call.callee)) {
        return false;
      }
      const options = call.arguments[0];
      return Boolean(
        options &&
        options.type !== AST_NODE_TYPES.SpreadElement &&
        aggregateRoutesOption(options) === true,
      );
    }

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (typeof node.source.value !== "string") {
          return;
        }
        const moduleBoundaries = boundariesForModule(node.source.value);
        if (moduleBoundaries.length === 0 || isProductionRoute) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type !== AST_NODE_TYPES.ImportSpecifier) {
            const boundary = moduleBoundaries[0];
            if (boundary) {
              report(specifier, boundary);
            }
            continue;
          }
          const importedName =
            specifier.imported.type === AST_NODE_TYPES.Identifier
              ? specifier.imported.name
              : String(specifier.imported.value);
          const boundary = boundaryForImport(node.source.value, importedName);
          if (!boundary) {
            continue;
          }
          if (
            !isContractHarness ||
            specifier.local.name !== boundary.exportName
          ) {
            report(specifier, boundary);
            continue;
          }
          harnessBindings.push({ boundary, specifier });
        }
      },
      ExportNamedDeclaration(node: TSESTree.ExportNamedDeclaration) {
        if (!node.source || typeof node.source.value !== "string") {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type !== AST_NODE_TYPES.ExportSpecifier) {
            continue;
          }
          const localName =
            specifier.local.type === AST_NODE_TYPES.Identifier
              ? specifier.local.name
              : String(specifier.local.value);
          const boundary = boundaryForImport(node.source.value, localName);
          if (boundary && !isProductionRoute) {
            report(specifier, boundary);
          }
        }
      },
      ExportAllDeclaration(node: TSESTree.ExportAllDeclaration) {
        if (typeof node.source.value !== "string" || isProductionRoute) {
          return;
        }
        const boundary = boundariesForModule(node.source.value)[0];
        if (boundary) {
          report(node, boundary);
        }
      },
      ImportExpression(node: TSESTree.ImportExpression) {
        if (
          node.source.type !== AST_NODE_TYPES.Literal ||
          typeof node.source.value !== "string" ||
          isProductionRoute
        ) {
          return;
        }
        const boundary = boundariesForModule(node.source.value)[0];
        if (boundary) {
          report(node, boundary);
        }
      },
      CallExpression(node: TSESTree.CallExpression) {
        calls.push(node);
      },
      "Program:exit"() {
        for (const call of calls) {
          if (isAggregateAppFactoryMount(call)) {
            reportAggregateRoutes(call);
          }
        }
        for (const { boundary, specifier } of harnessBindings) {
          const variables = context.sourceCode.getDeclaredVariables(specifier);
          for (const variable of variables) {
            for (const reference of variable.references) {
              const identifier = reference.identifier;
              if (
                identifier.type === AST_NODE_TYPES.Identifier &&
                !isApprovedHarnessReference(identifier, boundary, context)
              ) {
                report(identifier, boundary);
              }
            }
          }
        }
      },
    };
  },
});
