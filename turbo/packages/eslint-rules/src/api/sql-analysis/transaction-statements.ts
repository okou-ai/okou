import { AST_TOKEN_TYPES, type TSESTree } from "@typescript-eslint/utils";

import { parsePostgres } from "./postgres-parser.ts";
import { sqlSourceParser } from "./sql-source-parser.ts";

function maskSql(
  source: string,
  onComment?: (start: number, end: number) => void,
): string {
  const parts: string[] = [];
  let index = 0;
  while (index < source.length) {
    const start = index;
    if (source.startsWith("--", index)) {
      const newline = source.slice(index).search(/[\r\n]/u);
      index = newline < 0 ? source.length : index + newline;
      onComment?.(start, index);
    } else if (source.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth) {
        if (source.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else index++;
      }
    } else {
      const quote = source[index];
      const dollar =
        quote === "$"
          ? /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u.exec(source.slice(index))?.[0]
          : undefined;
      if (dollar) {
        const end = source.indexOf(dollar, index + dollar.length);
        index = end < 0 ? source.length : end + dollar.length;
      } else if (quote === "'" || quote === '"') {
        const escaped = quote === "'" && /\bE$/iu.test(source.slice(0, index));
        index++;
        while (index < source.length) {
          if (escaped && source[index] === "\\") index += 2;
          else if (source[index++] === quote) {
            if (source[index] !== quote) break;
            index++;
          }
        }
      } else {
        parts.push(source[index++]);
        continue;
      }
    }
    parts.push(" ".repeat(index - start));
  }
  return parts.join("");
}

function hasOpeningStatement(source: string): boolean {
  return (
    parsePostgres(source)?.statements.some((statement) => {
      if (
        typeof statement !== "object" ||
        statement === null ||
        !("stmt" in statement)
      )
        return false;
      const stmt = statement.stmt;
      if (
        typeof stmt !== "object" ||
        stmt === null ||
        !("TransactionStmt" in stmt)
      )
        return false;
      const transaction = stmt.TransactionStmt;
      return (
        typeof transaction === "object" &&
        transaction !== null &&
        "kind" in transaction &&
        [
          "TRANS_STMT_BEGIN",
          "TRANS_STMT_START",
          "TRANS_STMT_SAVEPOINT",
        ].includes(String(transaction.kind))
      );
    }) ?? false
  );
}

export function transactionStatementOffsets(source: string): number[] {
  if (!/\b(?:BEGIN|START|SAVEPOINT)\b/iu.test(source)) return [];
  // Split only outside comments, quoted data/identifiers and dollar bodies.
  // Parsing each statement also detects BEGIN before invalid or dynamic SQL,
  // without mistaking PL/pgSQL BEGIN blocks for transaction boundaries.
  const masked = maskSql(source);
  const offsets: number[] = [];
  let start = 0;
  for (const end of [
    ...Array.from(masked.matchAll(/;/gu), (match) => match.index),
    source.length,
  ]) {
    const candidate = /^(?<prefix>\s*)(?:BEGIN|START|SAVEPOINT)\b/iu.exec(
      masked.slice(start, end),
    );
    if (candidate && hasOpeningStatement(source.slice(start, end)))
      offsets.push(start + (candidate.groups?.prefix.length ?? 0));
    start = end + 1;
  }
  return offsets;
}

export const transactionSqlParser = {
  ...sqlSourceParser,
  parseForESLint(source: string) {
    const parsed = sqlSourceParser.parseForESLint(source);
    const comments: TSESTree.Comment[] = [];
    function loc(index: number): TSESTree.Position {
      const lines = source.slice(0, index).split(/\r\n|\r|\n/u);
      return { line: lines.length, column: lines[lines.length - 1].length };
    }
    maskSql(source, (start, end) => {
      const value = source.slice(start + 2, end);
      if (/^\s*eslint-/u.test(value))
        comments.push({
          type: AST_TOKEN_TYPES.Line,
          value,
          range: [start, end],
          loc: { start: loc(start), end: loc(end) },
        });
    });
    return { ast: { ...parsed.ast, comments } };
  },
};
