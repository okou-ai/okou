import {
  AST_NODE_TYPES,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";

export interface ImportTarget {
  readonly specifier: TSESTree.ImportClause;
  readonly source: string;
  readonly imported: string | null;
  readonly typeOnly: boolean;
}

type Fix = (fixer: TSESLint.RuleFixer) => TSESLint.RuleFix;

export function importedName(specifier: TSESTree.ImportSpecifier): string {
  return specifier.imported.type === AST_NODE_TYPES.Identifier
    ? specifier.imported.name
    : specifier.imported.value;
}

function quoted(source: string, original: string): string {
  if (original.startsWith("'")) {
    return `'${source.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`;
  }
  return JSON.stringify(source);
}

function exportName(name: string): string {
  return /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u.test(name)
    ? name
    : JSON.stringify(name);
}

/** Keep comments verbatim when changing only a source; otherwise fail closed. */
export function importFix(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.ImportDeclaration,
  targets: readonly ImportTarget[],
): Fix | undefined {
  if (node.attributes.length > 0 || node.phase !== null) {
    return undefined;
  }
  const first = targets[0];
  if (first === undefined) {
    return undefined;
  }
  const originalQuote = sourceCode.getText(node.source);
  const onlySourceChanged = targets.every((target) => {
    const originallyTypeOnly =
      node.importKind === "type" ||
      (target.specifier.type === AST_NODE_TYPES.ImportSpecifier &&
        target.specifier.importKind === "type");
    return (
      target.source === first.source &&
      target.typeOnly === originallyTypeOnly &&
      (target.specifier.type !== AST_NODE_TYPES.ImportSpecifier ||
        target.imported === importedName(target.specifier))
    );
  });
  // All-inline type imports must become outer `import type`: with
  // verbatimModuleSyntax an inline-only declaration can still load the module.
  if (onlySourceChanged && !targets.every((target) => target.typeOnly)) {
    return (fixer) => {
      return fixer.replaceText(
        node.source,
        quoted(first.source, originalQuote),
      );
    };
  }
  if (sourceCode.getCommentsInside(node).length > 0) {
    return undefined;
  }
  const groups = new Map<string, ImportTarget[]>();
  for (const target of targets) {
    const key = JSON.stringify([target.source, target.typeOnly]);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [target]);
    } else {
      group.push(target);
    }
  }
  const semicolon = sourceCode.getText(node).endsWith(";") ? ";" : "";
  const statements: string[] = [];
  for (const group of groups.values()) {
    // Type-only default-plus-named imports require multiple declarations;
    // do not introduce duplicate-source imports to express that combination.
    if (
      group.length > 1 &&
      group.some((target) => {
        return target.specifier.type !== AST_NODE_TYPES.ImportSpecifier;
      })
    ) {
      return undefined;
    }
    const head = group[0];
    if (head === undefined) {
      continue;
    }
    const prefix = head.typeOnly ? "import type" : "import";
    const from = ` from ${quoted(head.source, originalQuote)}${semicolon}`;
    const named: string[] = [];
    for (const target of group) {
      const { specifier } = target;
      if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
        const original = importedName(specifier);
        if (target.imported === null || target.imported === original) {
          const text = sourceCode.getText(specifier);
          named.push(
            specifier.importKind === "type"
              ? text.replace(/^type\s+/u, "")
              : text,
          );
        } else {
          const imported = exportName(target.imported);
          named.push(
            target.imported === specifier.local.name
              ? imported
              : `${imported} as ${sourceCode.getText(specifier.local)}`,
          );
        }
      } else if (specifier.type === AST_NODE_TYPES.ImportNamespaceSpecifier) {
        statements.push(`${prefix} * as ${specifier.local.name}${from}`);
      } else {
        statements.push(`${prefix} ${specifier.local.name}${from}`);
      }
    }
    if (named.length > 0) {
      statements.push(`${prefix} { ${named.join(", ")} }${from}`);
    }
  }
  return (fixer) => {
    return fixer.replaceText(node, statements.join("\n"));
  };
}

export function typeExportFix(
  sourceCode: TSESLint.SourceCode,
  node: TSESTree.ExportNamedDeclaration,
): Fix | undefined {
  if (
    node.source === null ||
    node.attributes.length > 0 ||
    sourceCode.getCommentsInside(node).length > 0
  ) {
    return undefined;
  }
  const specifiers = node.specifiers.map((specifier) => {
    return sourceCode.getText(specifier).replace(/^type\s+/u, "");
  });
  const semicolon = sourceCode.getText(node).endsWith(";") ? ";" : "";
  const originalSource = sourceCode.getText(node.source);
  return (fixer) => {
    return fixer.replaceText(
      node,
      `export type { ${specifiers.join(", ")} } from ${originalSource}${semicolon}`,
    );
  };
}
