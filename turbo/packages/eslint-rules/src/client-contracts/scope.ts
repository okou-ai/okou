import {
  AST_NODE_TYPES,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";

export function variableInScope(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Identifier,
): TSESLint.Scope.Variable | null {
  let scope: TSESLint.Scope.Scope | null = sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(node.name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
}

export function readOnly(variable: TSESLint.Scope.Variable): boolean {
  return variable.references.every((reference) => {
    return !reference.isWrite() || reference.init === true;
  });
}

export function constInitializer(
  variable: TSESLint.Scope.Variable,
): TSESTree.Expression | null {
  if (variable.defs.length !== 1 || !readOnly(variable)) {
    return null;
  }
  const definition = variable.defs[0];
  if (
    definition?.type !== "Variable" ||
    definition.parent.kind !== "const" ||
    definition.node.id.type !== AST_NODE_TYPES.Identifier ||
    definition.node.id.typeAnnotation !== undefined
  ) {
    return null;
  }
  return definition.node.init;
}

export function importedBinding(
  variable: TSESLint.Scope.Variable,
): { readonly name: string; readonly source: string } | null {
  if (variable.defs.length !== 1 || !readOnly(variable)) {
    return null;
  }
  const definition = variable.defs[0];
  if (
    definition?.type !== "ImportBinding" ||
    definition.node.type !== AST_NODE_TYPES.ImportSpecifier ||
    definition.parent.type !== AST_NODE_TYPES.ImportDeclaration ||
    definition.node.importKind === "type" ||
    definition.parent.importKind === "type"
  ) {
    return null;
  }
  const { imported } = definition.node;
  return {
    name:
      imported.type === AST_NODE_TYPES.Identifier
        ? imported.name
        : imported.value,
    source: definition.parent.source.value,
  };
}

/** `typeof value` references a value symbol, but emits no runtime use. */
export function isTypePosition(reference: TSESLint.Scope.Reference): boolean {
  if (reference.isTypeReference && !reference.isValueReference) {
    return true;
  }
  let node: TSESTree.Node = reference.identifier;
  while (node.parent.type === AST_NODE_TYPES.TSQualifiedName) {
    node = node.parent;
  }
  return node.parent.type === AST_NODE_TYPES.TSTypeQuery;
}

export function onlyTypeReferences(variable: TSESLint.Scope.Variable): boolean {
  return (
    variable.references.length > 0 && variable.references.every(isTypePosition)
  );
}
