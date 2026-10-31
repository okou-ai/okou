import {
  AST_NODE_TYPES,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";
import {
  constInitializer,
  importedBinding,
  isTypePosition,
  readOnly,
  variableInScope,
} from "./scope.ts";

type Origin =
  "getter" | "signal" | "factory" | "transport" | "computed" | "command";

/** Proof is deliberately local: annotations and matching names are not origins. */
export function factoryProof(
  sourceCode: TSESLint.SourceCode,
  isTransport: (source: string) => boolean,
  isApiClientSignalSource: (source: string) => boolean,
) {
  function hasOrigin(
    expression: TSESTree.Node,
    origin: Origin,
    seen: ReadonlySet<TSESLint.Scope.Variable> = new Set(),
  ): boolean {
    if (expression.type === AST_NODE_TYPES.Identifier) {
      const variable = variableInScope(sourceCode, expression);
      if (variable === null || seen.has(variable) || !readOnly(variable)) {
        return false;
      }
      const next = new Set(seen).add(variable);
      const imported = importedBinding(variable);
      if (imported !== null) {
        switch (origin) {
          case "computed":
          case "command":
            return imported.source === "ccstate" && imported.name === origin;
          case "signal":
            return (
              imported.name === "apiClient$" &&
              isApiClientSignalSource(imported.source)
            );
          case "transport":
            return (
              imported.name === "initClient" && isTransport(imported.source)
            );
          case "factory":
          case "getter":
            return false;
        }
      }
      const initializer = constInitializer(variable);
      if (initializer !== null) {
        return hasOrigin(initializer, origin, next);
      }
      if (origin === "getter" && variable.defs.length === 1) {
        const definition = variable.defs[0];
        if (definition?.type === "Parameter") {
          const fn = definition.node;
          if (
            (fn.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
              fn.type !== AST_NODE_TYPES.FunctionExpression) ||
            definition.name.type !== AST_NODE_TYPES.Identifier ||
            fn.parent.type !== AST_NODE_TYPES.CallExpression ||
            fn.parent.optional ||
            fn.parent.typeArguments !== undefined ||
            fn.parent.arguments[0] !== fn
          ) {
            return false;
          }
          const parameter = fn.params[0];
          if (
            (parameter?.type === AST_NODE_TYPES.Identifier ||
              parameter?.type === AST_NODE_TYPES.ObjectPattern) &&
            parameter.typeAnnotation !== undefined
          ) {
            return false;
          }
          if (parameter === definition.name) {
            return hasOrigin(fn.parent.callee, "computed", next);
          }
          if (
            parameter?.type !== AST_NODE_TYPES.ObjectPattern ||
            parameter.properties.some((property) => {
              return (
                property.type !== AST_NODE_TYPES.Property ||
                property.computed ||
                property.method ||
                property.kind !== "init" ||
                property.value.type !== AST_NODE_TYPES.Identifier
              );
            })
          ) {
            return false;
          }
          const getters = parameter.properties.filter((property) => {
            return (
              property.type === AST_NODE_TYPES.Property &&
              ((property.key.type === AST_NODE_TYPES.Identifier &&
                property.key.name === "get") ||
                (property.key.type === AST_NODE_TYPES.Literal &&
                  property.key.value === "get"))
            );
          });
          const property = getters[0];
          return (
            getters.length === 1 &&
            property?.type === AST_NODE_TYPES.Property &&
            property.value === definition.name &&
            hasOrigin(fn.parent.callee, "command", next)
          );
        }
      }
      return false;
    }
    return (
      origin === "factory" &&
      expression.type === AST_NODE_TYPES.CallExpression &&
      !expression.optional &&
      expression.typeArguments === undefined &&
      expression.arguments.length === 1 &&
      hasOrigin(expression.callee, "getter", seen) &&
      expression.arguments[0] !== undefined &&
      hasOrigin(expression.arguments[0], "signal", seen)
    );
  }

  function safeConfig(config: TSESTree.Node | undefined): boolean {
    if (config?.type !== AST_NODE_TYPES.ObjectExpression) {
      return false;
    }
    const keys = new Set<string>();
    return config.properties.every((property) => {
      if (
        property.type !== AST_NODE_TYPES.Property ||
        property.computed ||
        property.method ||
        property.kind !== "init"
      ) {
        return false;
      }
      const key =
        property.key.type === AST_NODE_TYPES.Identifier
          ? property.key.name
          : property.key.type === AST_NODE_TYPES.Literal &&
              typeof property.key.value === "string"
            ? property.key.value
            : null;
      if (key === null || keys.has(key)) {
        return false;
      }
      keys.add(key);
      // A custom fetcher receives the route, and may inspect its schemas.
      if (key === "api" || key === "__proto__") {
        return false;
      }
      return (
        key !== "validateResponse" ||
        (property.value.type === AST_NODE_TYPES.Literal &&
          property.value.value === false)
      );
    });
  }

  function safeCall(call: TSESTree.CallExpression): boolean {
    if (
      call.optional ||
      call.typeArguments !== undefined ||
      call.arguments.some((argument) => {
        return argument.type === AST_NODE_TYPES.SpreadElement;
      })
    ) {
      return false;
    }
    if (hasOrigin(call.callee, "factory")) {
      return call.arguments.length === 1;
    }
    return (
      hasOrigin(call.callee, "transport") &&
      call.arguments.length === 2 &&
      safeConfig(call.arguments[1])
    );
  }

  function metadataRead(node: TSESTree.Identifier): boolean {
    const route = node.parent;
    if (
      route.type !== AST_NODE_TYPES.MemberExpression ||
      route.object !== node ||
      route.computed ||
      route.optional ||
      route.property.type !== AST_NODE_TYPES.Identifier
    ) {
      return false;
    }
    const metadata = route.parent;
    if (
      metadata.type !== AST_NODE_TYPES.MemberExpression ||
      metadata.object !== route ||
      metadata.computed ||
      metadata.optional ||
      metadata.property.type !== AST_NODE_TYPES.Identifier ||
      !["method", "path", "contentType"].includes(metadata.property.name)
    ) {
      return false;
    }
    // Metadata is readable, not writable or callable. Follow destructuring
    // targets as well, so `({x: router.get.path} = value)` is never migrated.
    let target: TSESTree.Node = metadata;
    while (
      target.parent.type === AST_NODE_TYPES.Property ||
      target.parent.type === AST_NODE_TYPES.ObjectPattern ||
      target.parent.type === AST_NODE_TYPES.ArrayPattern ||
      target.parent.type === AST_NODE_TYPES.AssignmentPattern ||
      target.parent.type === AST_NODE_TYPES.RestElement ||
      target.parent.type === AST_NODE_TYPES.TSAsExpression ||
      target.parent.type === AST_NODE_TYPES.TSTypeAssertion ||
      target.parent.type === AST_NODE_TYPES.TSSatisfiesExpression ||
      target.parent.type === AST_NODE_TYPES.TSNonNullExpression ||
      target.parent.type === AST_NODE_TYPES.TSInstantiationExpression ||
      target.parent.type === AST_NODE_TYPES.ChainExpression
    ) {
      target = target.parent;
    }
    const parent = target.parent;
    return !(
      (parent.type === AST_NODE_TYPES.AssignmentExpression &&
        parent.left === target) ||
      parent.type === AST_NODE_TYPES.UpdateExpression ||
      (parent.type === AST_NODE_TYPES.UnaryExpression &&
        parent.operator === "delete") ||
      ((parent.type === AST_NODE_TYPES.ForInStatement ||
        parent.type === AST_NODE_TYPES.ForOfStatement) &&
        parent.left === target) ||
      (parent.type === AST_NODE_TYPES.CallExpression &&
        parent.callee === target) ||
      (parent.type === AST_NODE_TYPES.NewExpression &&
        parent.callee === target) ||
      parent.type === AST_NODE_TYPES.TaggedTemplateExpression
    );
  }

  function safeRouter(
    variable: TSESLint.Scope.Variable,
    seen: ReadonlySet<TSESLint.Scope.Variable> = new Set(),
  ): boolean {
    if (
      seen.has(variable) ||
      !readOnly(variable) ||
      !variable.references.some((reference) => {
        return reference.isRead();
      })
    ) {
      return false;
    }
    const next = new Set(seen).add(variable);
    return variable.references.every((reference) => {
      // The original source type can expose validators or full schema fields.
      if (isTypePosition(reference)) {
        return false;
      }
      if (reference.init === true && reference.isWriteOnly()) {
        return true;
      }
      const node = reference.identifier;
      if (node.type !== AST_NODE_TYPES.Identifier) {
        return false;
      }
      const parent = node.parent;
      if (
        parent.type === AST_NODE_TYPES.CallExpression &&
        parent.arguments[0] === node
      ) {
        return safeCall(parent);
      }
      if (
        parent.type === AST_NODE_TYPES.VariableDeclarator &&
        parent.init === node &&
        parent.id.type === AST_NODE_TYPES.Identifier
      ) {
        const alias = variableInScope(sourceCode, parent.id);
        return (
          alias !== null &&
          constInitializer(alias) === node &&
          safeRouter(alias, next)
        );
      }
      return metadataRead(node);
    });
  }

  return { safeRouter };
}
