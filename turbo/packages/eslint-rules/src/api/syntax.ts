import {
  AST_NODE_TYPES,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";

// These helpers intentionally model conventional, type-correct repository
// syntax. They use only the current file's imports, const bindings, and scope
// graph; unusual metaprogramming and cross-file type inference are out of scope.

const DRIZZLE_MODULE_PREFIX = "drizzle-orm";
const SCHEMA_MODULE_PREFIX = "@okouai/db/schema/";

function isSchemaModule(source: string | undefined): boolean {
  return (
    source?.startsWith(SCHEMA_MODULE_PREFIX) === true ||
    source === "@okouai/db/runtime/agent-run" ||
    source === "@okouai/db/runtime/chat-thread"
  );
}
const DATABASE_NAMES = new Set([
  "database",
  "db",
  "executor",
  "readonlyDb",
  "transaction",
  "tx",
  "writeDb",
]);
const DATABASE_TYPE_NAMES = new Set([
  "Db",
  "DrizzleDatabase",
  "NodePgDatabase",
  "ReadonlyDb",
]);
const DATABASE_TYPE_WRAPPERS = new Set([
  "NonNullable",
  "Omit",
  "Pick",
  "Readonly",
  "Required",
]);
const SQL_WRAPPER_HELPERS = new Set([
  "and",
  "arrayContained",
  "arrayContains",
  "arrayOverlaps",
  "asc",
  "avg",
  "avgDistinct",
  "between",
  "count",
  "countDistinct",
  "desc",
  "empty",
  "eq",
  "exists",
  "fromList",
  "gt",
  "gte",
  "ilike",
  "identifier",
  "inArray",
  "isNotNull",
  "isNull",
  "join",
  "like",
  "lt",
  "lte",
  "max",
  "min",
  "ne",
  "not",
  "notBetween",
  "notExists",
  "notIlike",
  "notInArray",
  "notLike",
  "or",
  "param",
  "placeholder",
  "sql",
  "sum",
  "sumDistinct",
]);
const QUERY_BUILDER_ROOT_METHODS = new Set([
  "select",
  "selectDistinct",
  "selectDistinctOn",
]);
const QUERY_BUILDER_CHAIN_METHODS = new Set([
  "$dynamic",
  "as",
  "crossJoin",
  "crossJoinLateral",
  "except",
  "exceptAll",
  "for",
  "from",
  "fullJoin",
  "groupBy",
  "having",
  "innerJoin",
  "innerJoinLateral",
  "intersect",
  "intersectAll",
  "leftJoin",
  "leftJoinLateral",
  "limit",
  "offset",
  "orderBy",
  "rightJoin",
  "rightJoinLateral",
  "union",
  "unionAll",
  "where",
]);

interface ImportReference {
  readonly importedName: string;
  readonly isTypeOnly: boolean;
  readonly source: string;
}

function isDrizzleModule(source: string): boolean {
  return (
    source === DRIZZLE_MODULE_PREFIX ||
    source.startsWith(`${DRIZZLE_MODULE_PREFIX}/`)
  );
}

function isLocalDatabaseModule(source: string): boolean {
  return (
    source === "./db" ||
    (source.startsWith(".") &&
      /(?:^|\/)(?:external|lib|signals\/external)\/db(?:\.[cm]?[jt]s)?$/u.test(
        source,
      ))
  );
}

export function memberName(node: TSESTree.MemberExpression): string | null {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === AST_NODE_TYPES.Literal &&
    typeof node.property.value === "string"
  ) {
    return node.property.value;
  }
  return null;
}

export function propertyName(node: TSESTree.Property): string | null {
  if (!node.computed && node.key.type === AST_NODE_TYPES.Identifier) {
    return node.key.name;
  }
  if (
    node.key.type === AST_NODE_TYPES.Literal &&
    typeof node.key.value === "string"
  ) {
    return node.key.value;
  }
  return null;
}

export function unwrapExpression(
  node: TSESTree.Expression,
): TSESTree.Expression {
  let current = node;
  while (
    current.type === AST_NODE_TYPES.ChainExpression ||
    current.type === AST_NODE_TYPES.TSAsExpression ||
    current.type === AST_NODE_TYPES.TSInstantiationExpression ||
    current.type === AST_NODE_TYPES.TSNonNullExpression ||
    current.type === AST_NODE_TYPES.TSSatisfiesExpression ||
    current.type === AST_NODE_TYPES.TSTypeAssertion
  ) {
    current = current.expression;
  }
  return current;
}

export function variableInScope(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Identifier,
): TSESLint.Scope.Variable | null {
  let scope: TSESLint.Scope.Scope | null = sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.variables.find((candidate) => {
      return candidate.name === node.name;
    });
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
}

export function importReference(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Identifier,
): ImportReference | null {
  const definition = variableInScope(sourceCode, node)?.defs.find(
    (candidate) => {
      return candidate.type === "ImportBinding";
    },
  );
  const specifier = definition?.node;
  if (
    specifier === undefined ||
    (specifier.type !== AST_NODE_TYPES.ImportDefaultSpecifier &&
      specifier.type !== AST_NODE_TYPES.ImportNamespaceSpecifier &&
      specifier.type !== AST_NODE_TYPES.ImportSpecifier) ||
    specifier.parent.type !== AST_NODE_TYPES.ImportDeclaration ||
    typeof specifier.parent.source.value !== "string"
  ) {
    return null;
  }

  let importedName: string;
  if (specifier.type === AST_NODE_TYPES.ImportDefaultSpecifier) {
    importedName = "default";
  } else if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
    importedName = "*";
  } else {
    importedName =
      specifier.imported.type === AST_NODE_TYPES.Identifier
        ? specifier.imported.name
        : String(specifier.imported.value);
  }

  return {
    importedName,
    isTypeOnly:
      specifier.parent.importKind === "type" ||
      (specifier.type === AST_NODE_TYPES.ImportSpecifier &&
        specifier.importKind === "type"),
    source: specifier.parent.source.value,
  };
}

function constInitializer(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Identifier,
): TSESTree.Expression | null {
  const variable = variableInScope(sourceCode, node);
  const definition = variable?.defs.find((candidate) => {
    return candidate.type === "Variable";
  });
  if (
    variable === null ||
    variable === undefined ||
    definition?.node.type !== AST_NODE_TYPES.VariableDeclarator ||
    definition.node.id.type !== AST_NODE_TYPES.Identifier ||
    definition.node.parent.type !== AST_NODE_TYPES.VariableDeclaration ||
    definition.node.parent.kind !== "const" ||
    definition.node.init === null ||
    variable.references.some((reference) => {
      return reference.isWrite() && reference.identifier !== definition.name;
    })
  ) {
    return null;
  }
  return definition.node.init;
}

export function resolveLocalExpression(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Expression,
): TSESTree.Expression {
  let current = unwrapExpression(node);
  const visited = new Set<TSESLint.Scope.Variable>();
  for (let step = 0; step < 16; step += 1) {
    if (current.type !== AST_NODE_TYPES.Identifier) {
      return current;
    }
    const variable = variableInScope(sourceCode, current);
    if (variable === null || visited.has(variable)) {
      return current;
    }
    const initializer = constInitializer(sourceCode, current);
    if (initializer === null) {
      return current;
    }
    visited.add(variable);
    current = unwrapExpression(initializer);
  }
  return current;
}

function parameterIndex(definition: TSESLint.Scope.Definition): number | null {
  if (definition.type !== "Parameter") {
    return null;
  }
  const functionNode = definition.node;
  if (
    functionNode.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
    functionNode.type !== AST_NODE_TYPES.FunctionDeclaration &&
    functionNode.type !== AST_NODE_TYPES.FunctionExpression
  ) {
    return null;
  }
  const index = functionNode.params.findIndex((parameter) => {
    return parameter === definition.name;
  });
  return index === -1 ? null : index;
}

function callbackPropertyName(
  definition: TSESLint.Scope.Definition,
): string | null {
  if (definition.type !== "Parameter") {
    return null;
  }
  const functionNode = definition.node;
  const parent = functionNode.parent;
  return parent.type === AST_NODE_TYPES.Property &&
    parent.value === functionNode
    ? propertyName(parent)
    : null;
}

function isRelationalQueryCall(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.CallExpression,
): boolean {
  if (
    node.callee.type !== AST_NODE_TYPES.MemberExpression ||
    (memberName(node.callee) !== "findFirst" &&
      memberName(node.callee) !== "findMany")
  ) {
    return false;
  }
  const table = resolveLocalExpression(sourceCode, node.callee.object);
  if (table.type !== AST_NODE_TYPES.MemberExpression) {
    return false;
  }
  const query = resolveLocalExpression(sourceCode, table.object);
  return (
    query.type === AST_NODE_TYPES.MemberExpression &&
    memberName(query) === "query" &&
    isDatabaseExpression(sourceCode, query.object)
  );
}

function nestedRelationUsesConfig(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Property,
  visited: Set<TSESTree.Node>,
): boolean {
  const relations = node.parent;
  const withProperty = relations.parent;
  return (
    withProperty.type === AST_NODE_TYPES.Property &&
    withProperty.value === relations &&
    propertyName(withProperty) === "with" &&
    withProperty.parent.type === AST_NODE_TYPES.ObjectExpression &&
    isRelationalConfigObject(sourceCode, withProperty.parent, visited)
  );
}

function relationalConfigReference(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Identifier,
  visited: Set<TSESTree.Node>,
): boolean {
  const parent = node.parent;
  if (
    parent.type === AST_NODE_TYPES.CallExpression &&
    parent.arguments.includes(node)
  ) {
    return isRelationalQueryCall(sourceCode, parent);
  }
  return (
    parent.type === AST_NODE_TYPES.Property &&
    parent.value === node &&
    nestedRelationUsesConfig(sourceCode, parent, visited)
  );
}

function isRelationalConfigObject(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.ObjectExpression,
  visited: Set<TSESTree.Node>,
): boolean {
  if (visited.has(node)) {
    return false;
  }
  visited.add(node);
  const parent = node.parent;
  if (
    parent.type === AST_NODE_TYPES.CallExpression &&
    parent.arguments.includes(node)
  ) {
    return isRelationalQueryCall(sourceCode, parent);
  }
  if (
    parent.type === AST_NODE_TYPES.Property &&
    parent.value === node &&
    nestedRelationUsesConfig(sourceCode, parent, visited)
  ) {
    return true;
  }
  if (
    parent.type !== AST_NODE_TYPES.VariableDeclarator ||
    parent.init !== node ||
    parent.id.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }
  const variable = variableInScope(sourceCode, parent.id);
  return (
    variable?.references.some((reference) => {
      return (
        reference.identifier.type === AST_NODE_TYPES.Identifier &&
        relationalConfigReference(sourceCode, reference.identifier, visited)
      );
    }) === true
  );
}

function relationalParameterRole(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Identifier,
): "fields" | "operators" | null {
  const definition = variableInScope(sourceCode, node)?.defs.find(
    (candidate) => {
      return candidate.type === "Parameter";
    },
  );
  if (definition === undefined) {
    return null;
  }
  const functionNode = definition.node;
  const property = functionNode.parent;
  if (
    property.type !== AST_NODE_TYPES.Property ||
    property.value !== functionNode ||
    property.parent.type !== AST_NODE_TYPES.ObjectExpression ||
    !isRelationalConfigObject(
      sourceCode,
      property.parent,
      new Set<TSESTree.Node>(),
    )
  ) {
    return null;
  }
  const name = callbackPropertyName(definition);
  if (name !== "extras" && name !== "orderBy" && name !== "where") {
    return null;
  }
  const index = parameterIndex(definition);
  return index === 0 ? "fields" : index === 1 ? "operators" : null;
}

function namespaceMemberName(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.MemberExpression,
): string | null {
  const name = memberName(node);
  const object = resolveLocalExpression(sourceCode, node.object);
  if (
    name === null ||
    object.type !== AST_NODE_TYPES.Identifier ||
    importReference(sourceCode, object)?.importedName !== "*"
  ) {
    return null;
  }
  const source = importReference(sourceCode, object)?.source;
  return source !== undefined && isDrizzleModule(source) ? name : null;
}

function drizzleReferenceName(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Expression,
): string | null {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (resolved.type === AST_NODE_TYPES.Identifier) {
    const imported = importReference(sourceCode, resolved);
    if (
      imported !== null &&
      !imported.isTypeOnly &&
      isDrizzleModule(imported.source) &&
      imported.importedName !== "*" &&
      imported.importedName !== "default"
    ) {
      return imported.importedName;
    }
    return null;
  }
  if (resolved.type !== AST_NODE_TYPES.MemberExpression) {
    return null;
  }
  const namespaceName = namespaceMemberName(sourceCode, resolved);
  if (namespaceName !== null) {
    return namespaceName;
  }
  const object = resolveLocalExpression(sourceCode, resolved.object);
  if (
    object.type === AST_NODE_TYPES.Identifier &&
    relationalParameterRole(sourceCode, object) === "operators"
  ) {
    return memberName(resolved);
  }
  return null;
}

export function isDrizzleSqlTag(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Expression,
): boolean {
  return drizzleReferenceName(sourceCode, node) === "sql";
}

export function drizzleCallName(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.CallExpression,
): string | null {
  const direct = drizzleReferenceName(sourceCode, node.callee);
  if (direct !== null) {
    return direct;
  }
  if (node.callee.type !== AST_NODE_TYPES.MemberExpression) {
    return null;
  }
  const object = resolveLocalExpression(sourceCode, node.callee.object);
  return isDrizzleSqlTag(sourceCode, object) ? memberName(node.callee) : null;
}

export function isSchemaTableExpression(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Expression,
): boolean {
  const direct = unwrapExpression(node);
  const resolved = resolveLocalExpression(sourceCode, direct);
  if (resolved.type === AST_NODE_TYPES.Identifier) {
    const imported = importReference(sourceCode, resolved);
    if (
      imported !== null &&
      isSchemaModule(imported.source) &&
      !imported.isTypeOnly
    ) {
      return true;
    }
  }
  if (resolved.type === AST_NODE_TYPES.CallExpression) {
    const name = drizzleCallName(sourceCode, resolved);
    return (
      name === "alias" ||
      name === "pgTable" ||
      name === "pgView" ||
      isCteExpression(sourceCode, resolved) ||
      isQueryBuilderExpression(sourceCode, resolved)
    );
  }
  if (resolved.type !== AST_NODE_TYPES.MemberExpression) {
    return false;
  }
  const object = resolveLocalExpression(sourceCode, resolved.object);
  if (object.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }
  const imported = importReference(sourceCode, object);
  return (
    imported?.importedName === "*" &&
    (imported.source === "@okouai/db" || isSchemaModule(imported.source))
  );
}

function isCteExpression(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Expression,
): boolean {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (
    resolved.type !== AST_NODE_TYPES.CallExpression ||
    resolved.callee.type !== AST_NODE_TYPES.MemberExpression ||
    memberName(resolved.callee) !== "as"
  ) {
    return false;
  }
  const withCall = resolveLocalExpression(sourceCode, resolved.callee.object);
  return (
    withCall.type === AST_NODE_TYPES.CallExpression &&
    withCall.callee.type === AST_NODE_TYPES.MemberExpression &&
    memberName(withCall.callee) === "$with" &&
    isDatabaseExpression(sourceCode, withCall.callee.object)
  );
}

function isQueryBuilderExpression(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Expression,
  visited = new Set<TSESTree.Expression>(),
): boolean {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (visited.has(resolved)) {
    return false;
  }
  visited.add(resolved);
  if (
    resolved.type !== AST_NODE_TYPES.CallExpression ||
    resolved.callee.type !== AST_NODE_TYPES.MemberExpression
  ) {
    return false;
  }
  const name = memberName(resolved.callee);
  if (name !== null && QUERY_BUILDER_ROOT_METHODS.has(name)) {
    return isDatabaseExpression(sourceCode, resolved.callee.object);
  }
  return (
    name !== null &&
    QUERY_BUILDER_CHAIN_METHODS.has(name) &&
    isQueryBuilderExpression(sourceCode, resolved.callee.object, visited)
  );
}

export function isColumnExpression(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Expression,
): boolean {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (resolved.type !== AST_NODE_TYPES.MemberExpression) {
    return false;
  }
  const object = unwrapExpression(resolved.object);
  return (
    isSchemaTableExpression(sourceCode, object) ||
    (object.type === AST_NODE_TYPES.Identifier &&
      relationalParameterRole(sourceCode, object) === "fields")
  );
}

export function isSqlWrapperExpression(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Expression,
): boolean {
  const resolved = resolveLocalExpression(sourceCode, node);
  if (resolved.type === AST_NODE_TYPES.TaggedTemplateExpression) {
    return isDrizzleSqlTag(sourceCode, resolved.tag);
  }
  if (
    isColumnExpression(sourceCode, resolved) ||
    isSchemaTableExpression(sourceCode, resolved)
  ) {
    return true;
  }
  if (resolved.type === AST_NODE_TYPES.CallExpression) {
    const name = drizzleCallName(sourceCode, resolved);
    if (name !== null && SQL_WRAPPER_HELPERS.has(name)) {
      return true;
    }
    if (
      resolved.callee.type === AST_NODE_TYPES.MemberExpression &&
      (memberName(resolved.callee) === "append" ||
        memberName(resolved.callee) === "as" ||
        memberName(resolved.callee) === "mapWith")
    ) {
      return isSqlWrapperExpression(sourceCode, resolved.callee.object);
    }
  }
  if (resolved.type === AST_NODE_TYPES.ConditionalExpression) {
    return (
      isSqlWrapperExpression(sourceCode, resolved.consequent) &&
      isSqlWrapperExpression(sourceCode, resolved.alternate)
    );
  }
  return false;
}

function typeName(node: TSESTree.TypeNode): string | null {
  if (node.type !== AST_NODE_TYPES.TSTypeReference) {
    return null;
  }
  if (node.typeName.type === AST_NODE_TYPES.Identifier) {
    return node.typeName.name;
  }
  return node.typeName.type === AST_NODE_TYPES.TSQualifiedName
    ? node.typeName.right.name
    : null;
}

function databaseTypeAnnotation(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.TypeNode,
  visited = new Set<TSESLint.Scope.Variable>(),
): boolean {
  if (
    node.type === AST_NODE_TYPES.TSUnionType ||
    node.type === AST_NODE_TYPES.TSIntersectionType
  ) {
    return node.types.some((member) => {
      return databaseTypeAnnotation(sourceCode, member, visited);
    });
  }
  if (node.type === AST_NODE_TYPES.TSImportType) {
    const qualifier = node.qualifier;
    const name =
      qualifier?.type === AST_NODE_TYPES.Identifier
        ? qualifier.name
        : qualifier?.type === AST_NODE_TYPES.TSQualifiedName
          ? qualifier.right.name
          : null;
    return (
      typeof node.source.value === "string" &&
      isDrizzleModule(node.source.value) &&
      name !== null &&
      DATABASE_TYPE_NAMES.has(name)
    );
  }
  if (node.type !== AST_NODE_TYPES.TSTypeReference) {
    return false;
  }

  const name = typeName(node);
  if (node.typeName.type === AST_NODE_TYPES.Identifier) {
    const imported = importReference(sourceCode, node.typeName);
    if (
      imported !== null &&
      DATABASE_TYPE_NAMES.has(imported.importedName) &&
      (isDrizzleModule(imported.source) ||
        isLocalDatabaseModule(imported.source))
    ) {
      return true;
    }
    const variable = variableInScope(sourceCode, node.typeName);
    const definition = variable?.defs.find((candidate) => {
      return candidate.type === "Type";
    });
    if (
      variable !== null &&
      variable !== undefined &&
      !visited.has(variable) &&
      definition?.node.type === AST_NODE_TYPES.TSTypeAliasDeclaration
    ) {
      visited.add(variable);
      const result = databaseTypeAnnotation(
        sourceCode,
        definition.node.typeAnnotation,
        visited,
      );
      visited.delete(variable);
      if (result) {
        return true;
      }
    }
  } else if (
    node.typeName.type === AST_NODE_TYPES.TSQualifiedName &&
    name !== null &&
    DATABASE_TYPE_NAMES.has(name)
  ) {
    const left = node.typeName.left;
    if (left.type === AST_NODE_TYPES.Identifier) {
      const imported = importReference(sourceCode, left);
      if (imported?.importedName === "*" && isDrizzleModule(imported.source)) {
        return true;
      }
    }
  }
  if (
    name !== null &&
    DATABASE_TYPE_WRAPPERS.has(name) &&
    node.typeArguments?.params[0] !== undefined
  ) {
    return databaseTypeAnnotation(
      sourceCode,
      node.typeArguments.params[0],
      visited,
    );
  }
  if (
    name !== "ReturnType" ||
    node.typeArguments?.params.length !== 1 ||
    node.typeArguments.params[0]?.type !== AST_NODE_TYPES.TSTypeQuery ||
    node.typeArguments.params[0].exprName.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }
  const imported = importReference(
    sourceCode,
    node.typeArguments.params[0].exprName,
  );
  return (
    imported !== null &&
    !imported.isTypeOnly &&
    imported.importedName === "db" &&
    isLocalDatabaseModule(imported.source)
  );
}

function identifierHasDatabaseType(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Identifier,
): boolean {
  const annotation = directTypeAnnotation(sourceCode, node);
  return annotation !== null && databaseTypeAnnotation(sourceCode, annotation);
}

function destructuredIdentifierHasDatabaseType(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Identifier,
): boolean {
  const binding = variableInScope(sourceCode, node)?.identifiers[0];
  if (binding === undefined) {
    return false;
  }
  const value =
    binding.parent.type === AST_NODE_TYPES.AssignmentPattern &&
    binding.parent.left === binding
      ? binding.parent
      : binding;
  const property = value.parent;
  if (
    property.type !== AST_NODE_TYPES.Property ||
    property.value !== value ||
    property.parent.type !== AST_NODE_TYPES.ObjectPattern
  ) {
    return false;
  }
  const name = propertyName(property);
  const annotation = property.parent.typeAnnotation?.typeAnnotation;
  if (name === null || annotation === undefined) {
    return false;
  }
  const propertyType = propertyTypeAnnotation(sourceCode, annotation, name);
  return (
    propertyType !== null && databaseTypeAnnotation(sourceCode, propertyType)
  );
}

function propertyTypeAnnotation(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.TypeNode,
  name: string,
  visited = new Set<TSESLint.Scope.Variable>(),
): TSESTree.TypeNode | null {
  if (
    node.type === AST_NODE_TYPES.TSUnionType ||
    node.type === AST_NODE_TYPES.TSIntersectionType
  ) {
    for (const member of node.types) {
      const annotation = propertyTypeAnnotation(
        sourceCode,
        member,
        name,
        visited,
      );
      if (annotation !== null) {
        return annotation;
      }
    }
    return null;
  }
  if (node.type === AST_NODE_TYPES.TSTypeLiteral) {
    return propertyTypeFromMembers(node.members, name);
  }
  if (
    node.type !== AST_NODE_TYPES.TSTypeReference ||
    node.typeName.type !== AST_NODE_TYPES.Identifier
  ) {
    return null;
  }
  const variable = variableInScope(sourceCode, node.typeName);
  const definition = variable?.defs.find((candidate) => {
    return candidate.type === "Type";
  });
  if (
    variable === null ||
    variable === undefined ||
    visited.has(variable) ||
    definition === undefined
  ) {
    return null;
  }
  if (definition.node.type === AST_NODE_TYPES.TSInterfaceDeclaration) {
    return propertyTypeFromMembers(definition.node.body.body, name);
  }
  if (definition.node.type !== AST_NODE_TYPES.TSTypeAliasDeclaration) {
    return null;
  }
  visited.add(variable);
  const annotation = propertyTypeAnnotation(
    sourceCode,
    definition.node.typeAnnotation,
    name,
    visited,
  );
  visited.delete(variable);
  return annotation;
}

function propertyTypeFromMembers(
  members: readonly TSESTree.TypeElement[],
  name: string,
): TSESTree.TypeNode | null {
  for (const member of members) {
    if (
      member.type === AST_NODE_TYPES.TSPropertySignature &&
      member.typeAnnotation !== undefined &&
      ((member.computed === false &&
        member.key.type === AST_NODE_TYPES.Identifier &&
        member.key.name === name) ||
        (member.key.type === AST_NODE_TYPES.Literal &&
          member.key.value === name))
    ) {
      return member.typeAnnotation.typeAnnotation;
    }
  }
  return null;
}

function memberHasDatabaseType(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.MemberExpression,
): boolean {
  const name = memberName(node);
  const object = unwrapExpression(node.object);
  if (
    name === null ||
    !DATABASE_NAMES.has(name) ||
    object.type !== AST_NODE_TYPES.Identifier
  ) {
    return false;
  }
  const objectType = object.typeAnnotation?.typeAnnotation;
  if (objectType === undefined) {
    const definition = variableInScope(sourceCode, object)?.defs[0];
    if (definition?.name.type !== AST_NODE_TYPES.Identifier) {
      return false;
    }
    const annotation = definition.name.typeAnnotation?.typeAnnotation;
    if (annotation === undefined) {
      return false;
    }
    const property = propertyTypeAnnotation(sourceCode, annotation, name);
    return property !== null && databaseTypeAnnotation(sourceCode, property);
  }
  const property = propertyTypeAnnotation(sourceCode, objectType, name);
  return property !== null && databaseTypeAnnotation(sourceCode, property);
}

function isTransactionParameter(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Identifier,
): boolean {
  const definition = variableInScope(sourceCode, node)?.defs.find(
    (candidate) => {
      return candidate.type === "Parameter";
    },
  );
  if (definition?.type !== "Parameter") {
    return false;
  }
  const functionNode = definition.node;
  if (
    functionNode.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
    functionNode.type !== AST_NODE_TYPES.FunctionExpression
  ) {
    return false;
  }
  const parent = functionNode.parent;
  return (
    parent.type === AST_NODE_TYPES.CallExpression &&
    parent.arguments.includes(functionNode) &&
    parent.callee.type === AST_NODE_TYPES.MemberExpression &&
    memberName(parent.callee) === "transaction" &&
    isDatabaseExpression(sourceCode, parent.callee.object)
  );
}

export function isDatabaseExpression(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Expression,
): boolean {
  const directAnnotation = directTypeAnnotation(sourceCode, node);
  if (
    directAnnotation !== null &&
    databaseTypeAnnotation(sourceCode, directAnnotation)
  ) {
    return true;
  }
  const resolved = resolveLocalExpression(sourceCode, node);
  if (resolved.type === AST_NODE_TYPES.Identifier) {
    const imported = importReference(sourceCode, resolved);
    return (
      identifierHasDatabaseType(sourceCode, resolved) ||
      destructuredIdentifierHasDatabaseType(sourceCode, resolved) ||
      isTransactionParameter(sourceCode, resolved) ||
      (imported !== null &&
        !imported.isTypeOnly &&
        imported.importedName === "db" &&
        isLocalDatabaseModule(imported.source))
    );
  }
  if (resolved.type === AST_NODE_TYPES.CallExpression) {
    if (
      resolved.callee.type === AST_NODE_TYPES.MemberExpression &&
      memberName(resolved.callee) === "with" &&
      isDatabaseExpression(sourceCode, resolved.callee.object)
    ) {
      return true;
    }
    const accessorName =
      resolved.callee.type === AST_NODE_TYPES.Identifier
        ? resolved.callee.name
        : resolved.callee.type === AST_NODE_TYPES.MemberExpression
          ? memberName(resolved.callee)
          : null;
    const signal = resolved.arguments[0];
    if (
      (accessorName === "get" || accessorName === "set") &&
      resolved.arguments.length === 1 &&
      signal !== undefined &&
      signal.type !== AST_NODE_TYPES.SpreadElement
    ) {
      const signalExpression = resolveLocalExpression(sourceCode, signal);
      if (signalExpression.type === AST_NODE_TYPES.Identifier) {
        const imported = importReference(sourceCode, signalExpression);
        if (
          imported !== null &&
          !imported.isTypeOnly &&
          imported.importedName.endsWith("$") &&
          DATABASE_NAMES.has(imported.importedName.slice(0, -1)) &&
          isLocalDatabaseModule(imported.source)
        ) {
          return true;
        }
      }
    }
    const callee = resolveLocalExpression(sourceCode, resolved.callee);
    if (callee.type !== AST_NODE_TYPES.Identifier) {
      return false;
    }
    const imported = importReference(sourceCode, callee);
    return (
      imported !== null &&
      !imported.isTypeOnly &&
      imported.importedName === "db" &&
      isLocalDatabaseModule(imported.source)
    );
  }
  return (
    resolved.type === AST_NODE_TYPES.MemberExpression &&
    memberHasDatabaseType(sourceCode, resolved)
  );
}

export function isDrizzleExecuteCall(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.CallExpression,
): boolean {
  if (
    node.callee.type !== AST_NODE_TYPES.MemberExpression ||
    memberName(node.callee) !== "execute"
  ) {
    return false;
  }
  const argument = node.arguments[0];
  const expression =
    argument === undefined || argument.type === AST_NODE_TYPES.SpreadElement
      ? null
      : unwrapExpression(argument);
  return (
    isDatabaseExpression(sourceCode, node.callee.object) &&
    (argument === undefined ||
      argument.type === AST_NODE_TYPES.SpreadElement ||
      (expression !== null &&
        (isSqlWrapperExpression(sourceCode, expression) ||
          expression.type === AST_NODE_TYPES.Identifier ||
          expression.type === AST_NODE_TYPES.CallExpression ||
          expression.type === AST_NODE_TYPES.MemberExpression)))
  );
}

export function localFunctionReturn(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.CallExpression,
): TSESTree.Expression | null {
  if (
    node.callee.type !== AST_NODE_TYPES.Identifier ||
    node.arguments.some((argument) => {
      return argument.type === AST_NODE_TYPES.SpreadElement;
    })
  ) {
    return null;
  }
  const variable = variableInScope(sourceCode, node.callee);
  const functionDefinition = variable?.defs.find((definition) => {
    return definition.type === "FunctionName";
  });
  let functionNode:
    | TSESTree.ArrowFunctionExpression
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | null = null;
  if (
    functionDefinition?.node.type === AST_NODE_TYPES.FunctionDeclaration ||
    functionDefinition?.node.type === AST_NODE_TYPES.FunctionExpression
  ) {
    functionNode = functionDefinition.node;
  } else {
    const initializer = constInitializer(sourceCode, node.callee);
    if (
      initializer?.type === AST_NODE_TYPES.ArrowFunctionExpression ||
      initializer?.type === AST_NODE_TYPES.FunctionExpression
    ) {
      functionNode = initializer;
    }
  }
  if (
    functionNode === null ||
    functionNode.params.length !== node.arguments.length
  ) {
    return null;
  }
  if (functionNode.body.type !== AST_NODE_TYPES.BlockStatement) {
    return functionNode.body;
  }
  const statement = functionNode.body.body.at(-1);
  return statement?.type === AST_NODE_TYPES.ReturnStatement &&
    statement.argument !== null
    ? statement.argument
    : null;
}

export function directTypeAnnotation(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.Expression,
): TSESTree.TypeNode | null {
  let resolved = node;
  while (
    resolved.type === AST_NODE_TYPES.ChainExpression ||
    resolved.type === AST_NODE_TYPES.TSNonNullExpression
  ) {
    resolved = resolved.expression;
  }
  if (
    resolved.type === AST_NODE_TYPES.TSAsExpression ||
    resolved.type === AST_NODE_TYPES.TSSatisfiesExpression ||
    resolved.type === AST_NODE_TYPES.TSTypeAssertion
  ) {
    return resolved.typeAnnotation;
  }
  if (resolved.type !== AST_NODE_TYPES.Identifier) {
    return null;
  }
  const definition = variableInScope(sourceCode, resolved)?.defs[0];
  if (definition === undefined) {
    return null;
  }
  if (definition.name.type === AST_NODE_TYPES.Identifier) {
    return definition.name.typeAnnotation?.typeAnnotation ?? null;
  }
  return null;
}

export function isDrizzleTypeReference(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.TypeNode,
  names: ReadonlySet<string>,
): boolean {
  if (node.type !== AST_NODE_TYPES.TSTypeReference) {
    return false;
  }
  if (node.typeName.type === AST_NODE_TYPES.Identifier) {
    const imported = importReference(sourceCode, node.typeName);
    return (
      imported !== null &&
      isDrizzleModule(imported.source) &&
      names.has(imported.importedName)
    );
  }
  if (node.typeName.type !== AST_NODE_TYPES.TSQualifiedName) {
    return false;
  }
  const object = node.typeName.left;
  if (object.type !== AST_NODE_TYPES.Identifier) {
    return false;
  }
  const imported = importReference(sourceCode, object);
  return (
    imported !== null &&
    isDrizzleModule(imported.source) &&
    ((imported.importedName === "*" && names.has(node.typeName.right.name)) ||
      (imported.importedName === "SQL" &&
        node.typeName.right.name === "Aliased" &&
        names.has("Aliased")))
  );
}
