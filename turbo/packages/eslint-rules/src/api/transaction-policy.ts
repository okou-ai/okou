import {
  AST_NODE_TYPES,
  ASTUtils,
  type TSESTree,
  type TSESLint,
} from "@typescript-eslint/utils";

import { transactionStatementOffsets } from "./sql-analysis/transaction-statements.ts";

export const transactionRuleId = "api/no-db-transaction";
export const legacyTransactionDate = "2026-10-09";
export const transactionBaselinePath = "turbo/db-transaction-baseline.json";
export const transactionSourceRoots = ["turbo/apps/api", "turbo/packages/db"];

export interface TransactionSite {
  readonly file: string;
  readonly owner: string;
  readonly line: number;
  readonly column: number;
}

export interface LegacyTransaction {
  readonly id: string;
  readonly file: string;
  readonly owner: string;
}

export interface TransactionBaseline {
  readonly version: 1;
  readonly sites: readonly LegacyTransaction[];
}

export type TransactionExemption =
  | { readonly kind: "legacy"; readonly id: string }
  | { readonly kind: "billing" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function opensSqlTransaction(source: string): boolean {
  return transactionStatementOffsets(source).length > 0;
}

function methodName(
  node: TSESTree.MemberExpression,
  source: TSESLint.SourceCode,
): string | undefined {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier)
    return node.property.name;
  const value = ASTUtils.getStaticValue(
    node.property,
    source.getScope(node.property),
  )?.value;
  return typeof value === "string" ? value : undefined;
}

function calledReference(
  node: TSESTree.Identifier,
  source: TSESLint.SourceCode,
  visited = new Set<string>(),
): boolean {
  if (visited.has(node.name)) return false;
  visited.add(node.name);
  const variable = ASTUtils.findVariable(source.getScope(node), node.name);
  return (
    variable?.references.some(({ identifier }) => {
      const parent = identifier.parent;
      if (
        parent?.type === AST_NODE_TYPES.CallExpression &&
        parent.callee === identifier
      )
        return true;
      if (
        parent?.type === AST_NODE_TYPES.MemberExpression &&
        parent.object === identifier &&
        ["bind", "call", "apply"].includes(methodName(parent, source) ?? "")
      )
        return true;
      return (
        parent?.type === AST_NODE_TYPES.VariableDeclarator &&
        parent.init === identifier &&
        parent.id.type === AST_NODE_TYPES.Identifier &&
        calledReference(parent.id, source, visited)
      );
    }) ?? false
  );
}

function isMethodUse(
  node: TSESTree.MemberExpression,
  source: TSESLint.SourceCode,
): boolean {
  const parent = node.parent;
  if (parent?.type === AST_NODE_TYPES.CallExpression && parent.callee === node)
    return true;
  if (
    parent?.type === AST_NODE_TYPES.MemberExpression &&
    parent.object === node &&
    ["bind", "call", "apply"].includes(methodName(parent, source) ?? "")
  )
    return true;
  if (
    parent?.type === AST_NODE_TYPES.VariableDeclarator &&
    parent.id.type === AST_NODE_TYPES.Identifier &&
    calledReference(parent.id, source)
  )
    return true;
  // Reject escaping method references from recognizable DB handles as well,
  // including the API's get/set(db$) accessors.
  function databaseHandle(identifier: TSESTree.Identifier): boolean {
    return /(?:^db\$?$|database|(?:read|write|rawSqlRead)Db\$?$|^sql$)/u.test(
      identifier.name,
    );
  }
  if (node.object.type === AST_NODE_TYPES.Identifier)
    return databaseHandle(node.object);
  return (
    node.object.type === AST_NODE_TYPES.CallExpression &&
    node.object.arguments.some((argument) => {
      return (
        argument.type === AST_NODE_TYPES.Identifier && databaseHandle(argument)
      );
    })
  );
}

export function transactionVisitors(
  source: TSESLint.SourceCode,
  file: string,
  report: (node: TSESTree.Node) => void,
): TSESLint.RuleListener {
  if (file.endsWith(".sql")) {
    return {
      Program(node): void {
        for (const offset of transactionStatementOffsets(source.text)) {
          report({
            ...node,
            loc: {
              start: source.getLocFromIndex(offset),
              end: source.getLocFromIndex(offset + 1),
            },
          });
        }
      },
    };
  }
  function checkSql(node: TSESTree.Node): void {
    const parent = node.parent;
    if (
      (parent?.type === AST_NODE_TYPES.MemberExpression &&
        parent.property === node) ||
      (parent?.type === AST_NODE_TYPES.Property && parent.key === node)
    )
      return;
    if (
      ((parent?.type === AST_NODE_TYPES.BinaryExpression &&
        parent.operator === "+") ||
        parent?.type === AST_NODE_TYPES.TemplateLiteral) &&
      typeof ASTUtils.getStaticValue(parent, source.getScope(parent))?.value ===
        "string"
    )
      return;
    const value = ASTUtils.getStaticValue(node, source.getScope(node))?.value;
    const sql =
      typeof value === "string"
        ? value
        : node.type === AST_NODE_TYPES.TemplateLiteral
          ? node.quasis
              .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
              .join(" __interpolation__ ")
          : "";
    if (sql && opensSqlTransaction(sql)) report(node);
  }
  return {
    MemberExpression(node): void {
      if (
        !["transaction", "begin", "savepoint"].includes(
          methodName(node, source) ?? "",
        ) ||
        !isMethodUse(node, source)
      )
        return;
      report(node.property);
    },
    Property(node): void {
      if (node.parent.type !== AST_NODE_TYPES.ObjectPattern) return;
      const name = node.computed
        ? ASTUtils.getStaticValue(node.key, source.getScope(node))?.value
        : node.key.type === AST_NODE_TYPES.Identifier
          ? node.key.name
          : node.key.type === AST_NODE_TYPES.Literal
            ? node.key.value
            : undefined;
      const binding =
        node.value.type === AST_NODE_TYPES.AssignmentPattern
          ? node.value.left
          : node.value;
      if (
        ["transaction", "begin", "savepoint"].includes(String(name)) &&
        binding.type === AST_NODE_TYPES.Identifier &&
        calledReference(binding, source)
      )
        report(node);
    },
    Literal: checkSql,
    TemplateLiteral: checkSql,
    BinaryExpression: checkSql,
  };
}

export function describeTransactionSite(
  file: string,
  node: TSESTree.Node,
): TransactionSite {
  const owners: string[] = [];
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.type === AST_NODE_TYPES.FunctionDeclaration && ancestor.id)
      owners.unshift(ancestor.id.name);
    else if (
      ancestor.type === AST_NODE_TYPES.ArrowFunctionExpression ||
      ancestor.type === AST_NODE_TYPES.FunctionExpression
    ) {
      if (ancestor.type === AST_NODE_TYPES.FunctionExpression && ancestor.id)
        owners.unshift(ancestor.id.name);
      else {
        let binding: TSESTree.Node | undefined = ancestor.parent;
        while (
          binding &&
          ![
            AST_NODE_TYPES.VariableDeclarator,
            AST_NODE_TYPES.FunctionDeclaration,
            AST_NODE_TYPES.ArrowFunctionExpression,
            AST_NODE_TYPES.FunctionExpression,
            AST_NODE_TYPES.Program,
          ].includes(binding.type)
        )
          binding = binding.parent;
        if (
          binding?.type === AST_NODE_TYPES.VariableDeclarator &&
          binding.id.type === AST_NODE_TYPES.Identifier
        )
          owners.unshift(binding.id.name);
      }
    }
  }
  return {
    file,
    owner: owners.join("/") || "<module>",
    line: node.loc.start.line,
    column: node.loc.start.column + 1,
  };
}

export function parseTransactionDirective(
  comment: TSESTree.Comment,
): TransactionExemption | undefined {
  const directive =
    /^\s*eslint-disable(?:-next-line|-line)?\b(?<rules>.*?)(?:\s+--\s+(?<reason>.*))?\s*$/u.exec(
      comment.value,
    );
  if (!directive) return undefined;
  const rules =
    directive.groups?.rules
      .trim()
      .split(/[\s,]+/u)
      .filter(Boolean) ?? [];
  if (rules.length && !rules.includes(transactionRuleId)) return undefined;
  if (
    comment.type !== "Line" ||
    !/^\s*eslint-disable-next-line\s/u.test(comment.value) ||
    rules.length !== 1 ||
    rules[0] !== transactionRuleId
  ) {
    throw new Error(
      `Transaction exemptions must be line comments disabling only ${transactionRuleId} on the next line.`,
    );
  }
  const reason = directive.groups?.reason ?? "";
  const legacy =
    /^Legacy transaction existing on 2026-10-09; id=(TX-\d{4}); new non-billing transactions are prohibited\.$/u.exec(
      reason,
    );
  if (legacy) return { kind: "legacy", id: legacy[1] };
  if (
    /^Billing atomicity: .+; single-statement alternative: .+\.$/u.test(reason)
  )
    return { kind: "billing" };
  throw new Error(
    "Use a registered legacy transaction ID, or describe Billing atomicity and the single-statement alternative.",
  );
}

export function legacyTransactionComment(id: string, sql = false): string {
  return `${sql ? "--" : "//"} eslint-disable-next-line ${transactionRuleId} -- Legacy transaction existing on ${legacyTransactionDate}; id=${id}; new non-billing transactions are prohibited.`;
}

export function createTransactionBaseline(
  sites: readonly TransactionSite[],
): TransactionBaseline {
  return {
    version: 1,
    sites: sites.map((site, index) => ({
      id: `TX-${String(index + 1).padStart(4, "0")}`,
      file: site.file,
      owner: site.owner,
    })),
  };
}

export function parseTransactionBaseline(value: unknown): TransactionBaseline {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sites))
    throw new Error("Invalid database transaction baseline metadata.");
  const sites: LegacyTransaction[] = [];
  const ids = new Set<string>();
  for (const site of value.sites) {
    if (
      !isRecord(site) ||
      typeof site.id !== "string" ||
      !/^TX-\d{4}$/u.test(site.id) ||
      typeof site.file !== "string" ||
      typeof site.owner !== "string" ||
      ids.has(site.id)
    )
      throw new Error(
        "Invalid or duplicate legacy transaction baseline entry.",
      );
    const file = site.file;
    if (!transactionSourceRoots.some((root) => file.startsWith(`${root}/`))) {
      throw new Error(
        "Legacy transaction is outside the enforced source roots.",
      );
    }
    ids.add(site.id);
    sites.push({
      id: site.id,
      file: site.file,
      owner: site.owner,
    });
  }
  return { version: 1, sites };
}

export function validateTransactionBaseline(
  current: TransactionBaseline,
  base: TransactionBaseline,
): void {
  const allowed = new Map(base.sites.map((site) => [site.id, site]));
  for (const site of current.sites) {
    const original = allowed.get(site.id);
    if (
      !original ||
      original.file !== site.file ||
      original.owner !== site.owner
    ) {
      throw new Error(
        `${site.id}: the base/main legacy inventory is deletion-only; additions and edits are prohibited.`,
      );
    }
  }
}

export function validateTransactionSites(
  sites: readonly { site: TransactionSite; exemption?: TransactionExemption }[],
  baseline: TransactionBaseline,
): void {
  const registered = new Map(baseline.sites.map((site) => [site.id, site]));
  const used = new Set<string>();
  for (const { site, exemption } of sites) {
    const location = `${site.file}:${site.line}`;
    if (!exemption)
      throw new Error(
        `${location}: a new database transaction requires a necessary billing exception.`,
      );
    if (exemption.kind === "billing") continue;
    const original = registered.get(exemption.id);
    if (
      !original ||
      used.has(exemption.id) ||
      original.file !== site.file ||
      original.owner !== site.owner
    ) {
      throw new Error(
        `${location}: ${exemption.id} is unregistered, duplicated, or moved. Do not copy or expand a legacy exemption.`,
      );
    }
    used.add(exemption.id);
  }
  for (const id of registered.keys())
    if (!used.has(id))
      throw new Error(
        `${id}: remove the unused legacy inventory entry when removing or converting its transaction.`,
      );
}
