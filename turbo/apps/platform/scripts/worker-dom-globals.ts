import { parse } from "acorn";
import type { Plugin } from "vite";

// A Web Worker script is evaluated in a scope that has no DOM. Referencing a
// window-only global there throws ReferenceError while the worker script is
// still being evaluated, and the page can only observe that as an opaque
// "worker failed to load" error event. Keep the first-party modules that reach
// a worker bundle free of these globals so the failure is impossible to
// introduce rather than something we rediscover from production telemetry.
const FORBIDDEN_WORKER_GLOBALS = [
  "document",
  "history",
  "localStorage",
  "sessionStorage",
  "window",
] as const;

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface IdentifierNode extends AstNode {
  readonly name: string;
  readonly type: "Identifier";
}

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function isIgnoredPosition(
  parent: AstNode,
  key: string,
  child: AstNode,
): boolean {
  const computed = parent["computed"] === true;
  // `foo.document` and `{ document: ... }` name a property, not the global.
  if (parent.type === "MemberExpression" && key === "property" && !computed) {
    return true;
  }
  if (
    (parent.type === "Property" ||
      parent.type === "PropertyDefinition" ||
      parent.type === "MethodDefinition") &&
    key === "key" &&
    !computed
  ) {
    return true;
  }
  // `typeof window` is the one safe way to mention a window-only global from a
  // module shared between the page and the worker: it never throws. Reading a
  // value out of it still has to go through globalThis.
  return (
    parent.type === "UnaryExpression" &&
    parent["operator"] === "typeof" &&
    key === "argument" &&
    child.type === "Identifier"
  );
}

/**
 * Count every use of a window-only global name in `code`.
 *
 * Local bindings that shadow one of the names count too. Scope tracking would
 * be needed to tell a shadowed read from a global one, and a module that
 * reaches the worker has no reason to reuse these names anyway, so the rule is
 * simply that the names are unavailable there.
 *
 * `code` must already be plain JavaScript; the plugin below runs after the
 * TypeScript transform, so module sources arrive here as parseable ESM.
 */
export function domGlobalUsageCounts(code: string): Map<string, number> {
  const program = parse(code, {
    allowHashBang: true,
    ecmaVersion: "latest",
    locations: false,
    sourceType: "module",
  }) as unknown as AstNode;
  const counts = new Map<string, number>();

  const visit = (node: AstNode): void => {
    if (node.type === "Identifier") {
      const { name } = node as IdentifierNode;
      if ((FORBIDDEN_WORKER_GLOBALS as readonly string[]).includes(name)) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (!isAstNode(child) || isIgnoredPosition(node, key, child)) {
          continue;
        }
        visit(child);
      }
    }
  };

  visit(program);
  return counts;
}

export function workerDomGlobalsMessage(
  moduleId: string,
  counts: ReadonlyMap<string, number>,
): string {
  const names = [...counts.entries()]
    .map(([name, count]) => {
      return `${name} (${count}x)`;
    })
    .sort()
    .join(", ");
  return [
    `${moduleId} reaches a Web Worker bundle but uses window-only globals: ${names}.`,
    "A Web Worker has no DOM, so reading one of these throws while the worker script is still evaluating and the page only sees an opaque load failure.",
    "Read the value through globalThis, move the DOM-dependent code into a module the worker does not import, or rename the local binding that shadows the global.",
  ].join("\n");
}

function isFirstPartyModule(moduleId: string): boolean {
  const [filePath = ""] = moduleId.split("?");
  const normalized = filePath.replaceAll("\\", "/");
  if (normalized.startsWith("\0") || normalized.includes("/node_modules/")) {
    return false;
  }
  return /\.(?:js|jsx|mjs|ts|tsx)$/u.test(normalized);
}

/**
 * Fail the worker build when a first-party module in the worker graph uses a
 * window-only global.
 *
 * The check runs per module rather than over the emitted bundle so the error
 * names the offending source file, and so third-party feature detection (which
 * legitimately probes `window` before using it) stays out of scope.
 */
export function workerDomGlobalsPlugin(): Plugin {
  return {
    apply: "build",
    enforce: "post",
    name: "platform-worker-dom-globals",
    transform(code, id) {
      if (!isFirstPartyModule(id)) {
        return null;
      }
      const counts = domGlobalUsageCounts(code);
      if (counts.size > 0) {
        this.error(workerDomGlobalsMessage(id, counts));
      }
      return null;
    },
  };
}
