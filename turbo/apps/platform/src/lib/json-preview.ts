import {
  createScanner,
  parseTree,
  type Node,
  type ParseError,
} from "jsonc-parser";
import { jsonParseOr } from "../signals/utils.ts";

export interface JsonPreviewSource {
  readonly text: string;
  readonly truncated: boolean;
}

export interface JsonPreviewNode {
  readonly offset: number;
  readonly length: number;
  readonly label: string;
  readonly type: Node["type"];
  readonly children: readonly JsonPreviewNode[];
}

export type JsonPreviewModel =
  | { readonly status: "ready"; readonly root: JsonPreviewNode }
  | {
      readonly status: "source";
      readonly reason: "incomplete" | "invalid" | "complexity";
    };

/** Check token budgets before entering the parser's recursive descent. */
function sourceLimit(text: string): "invalid" | "complexity" | null {
  const scanner = createScanner(text, true);
  const containers: string[] = [];
  let tokens = 0;
  // EOF is the scanner's only zero-length token. Inspect token spans rather
  // than importing the library's ambient const enum into browser code.
  for (scanner.scan(); scanner.getTokenLength() > 0; scanner.scan()) {
    tokens++;
    if (tokens > 16_384) {
      return "complexity";
    }
    const offset = scanner.getTokenOffset();
    const token = text.slice(offset, offset + scanner.getTokenLength());
    if (token === "{" || token === "[") {
      containers.push(token);
      if (containers.length > 64) {
        return "complexity";
      }
    } else if (token === "}" || token === "]") {
      if (containers.pop() !== (token === "}" ? "{" : "[")) {
        return "invalid";
      }
    }
  }
  return containers.length === 0 ? null : "invalid";
}

function sourceNode(
  source: string,
  node: Node,
  label: string,
): JsonPreviewNode {
  const children: JsonPreviewNode[] = [];
  for (const [index, child] of (node.children ?? []).entries()) {
    if (node.type === "object") {
      const key = child.children?.[0];
      const value = child.children?.[1];
      if (!key || !value) {
        throw new Error("A valid JSON property must contain a key and value");
      }
      children.push(
        sourceNode(
          source,
          value,
          source.slice(key.offset, key.offset + key.length),
        ),
      );
    } else if (node.type === "array") {
      children.push(sourceNode(source, child, `[${String(index)}]`));
    }
  }
  return {
    offset: node.offset,
    length: node.length,
    label,
    type: node.type,
    children,
  };
}

export function parseJsonPreview(source: JsonPreviewSource): JsonPreviewModel {
  if (source.truncated) {
    return { status: "source", reason: "incomplete" };
  }
  const reason = sourceLimit(source.text);
  if (reason) {
    return { status: "source", reason };
  }
  const errors: ParseError[] = [];
  const root = parseTree(source.text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  if (!root || errors.length > 0) {
    return { status: "source", reason: "invalid" };
  }
  return { status: "ready", root: sourceNode(source.text, root, "$") };
}

/** Legacy text display may change whitespace, never values or property order. */
export function formatJsonPreviewText(source: JsonPreviewSource): string {
  if (source.truncated || sourceLimit(source.text)) {
    return source.text;
  }
  const parsed = jsonParseOr<unknown>(source.text, null);
  if (parsed === null) {
    return source.text;
  }
  const compact = source.text.replace(/"(?:\\.|[^"\\])*"|\s+/g, (token) => {
    return token.startsWith('"') ? token : "";
  });
  if (JSON.stringify(parsed) !== compact) {
    return source.text;
  }
  const formatted = JSON.stringify(parsed, null, 2);
  return formatted.length <= 65_536 ? formatted : source.text;
}
