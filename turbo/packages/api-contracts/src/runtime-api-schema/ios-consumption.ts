import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { iosRouteBindings } from "./ios-routes";

interface Token {
  readonly kind: "word" | "string" | "symbol";
  readonly value: string;
  readonly offset: number;
}

interface IosConsumptionFinding {
  readonly file: string;
  readonly line: number;
  readonly problem: string;
}

const parameter = "\0";

/** Every first-party Swift call must name an inventoried method/path explicitly. */
export async function checkIosConsumption(
  root: string,
): Promise<readonly IosConsumptionFinding[]> {
  const files = await swiftFiles(join(root, "ios"));
  if (files.length === 0)
    return [{ file: "ios", line: 1, problem: "No iOS Swift sources found." }];
  const findings: IosConsumptionFinding[] = [];
  for (const file of files) {
    findings.push(
      ...checkSource(relative(root, file), await readFile(file, "utf8")),
    );
  }
  return findings;
}

async function swiftFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        ![".build", ".swiftpm"].includes(entry.name) &&
        !entry.name.endsWith("Tests") &&
        !entry.name.endsWith("TestSupport")
      ) {
        files.push(...(await swiftFiles(path)));
      }
    } else if (entry.name.endsWith(".swift")) files.push(path);
  }
  return files.sort();
}

type Call =
  | { readonly token: Token; readonly path: Token; readonly method: string }
  | {
      readonly token: Token;
      readonly path: Token | undefined;
      readonly problem: string;
    };

function checkSource(file: string, source: string): IosConsumptionFinding[] {
  const tokens = tokenize(source);
  const findings: IosConsumptionFinding[] = [];
  const consumed = new Set<Token>();
  const report = (token: Token, problem: string) => {
    findings.push({
      file,
      line: source.slice(0, token.offset).split("\n").length,
      problem,
    });
  };
  for (let index = 0; index < tokens.length; index++) {
    const call = readCall(file, tokens, index);
    if (!call) continue;
    if (call.path) consumed.add(call.path);
    if ("problem" in call) {
      report(call.token, call.problem);
      continue;
    }
    if (call.path.value.includes("\uFFFD")) {
      report(call.path, "Use unescaped API path text.");
    } else if (
      !iosRouteBindings.some(({ route }) => {
        return (
          route.method === call.method &&
          matchesPath(route.path, call.path.value)
        );
      })
    ) {
      report(
        call.path,
        call.method +
          " " +
          call.path.value.replaceAll(parameter, "{parameter}") +
          " is not in runtime-api-schema/ios-routes.ts.",
      );
    }
  }
  for (const [index, token] of tokens.entries()) {
    if (isUnboundPath(file, tokens, index, consumed)) {
      report(
        token,
        "Pass API paths directly to APIClient.request/data so their method and path are checked.",
      );
    }
  }
  return findings;
}

function readCall(
  file: string,
  tokens: readonly Token[],
  index: number,
): Call | undefined {
  if (!isCallStart(tokens, index)) return undefined;
  const token = tokens[index]!;
  const args = argumentsAt(tokens, index + 1);
  const first = args[0] ?? [];
  // Foundation/URLSession and application methods have a labeled first argument.
  if (first.length === 0 || first[1]?.value === ":") return undefined;
  const methodArg = args.find((arg) => {
    return arg[0]?.value === "method" && arg[1]?.value === ":";
  });
  if (isTransportForwarder(file, first, methodArg)) return undefined;
  const path = first[0];
  if (first.length !== 1 || path?.kind !== "string") {
    return {
      token,
      path: undefined,
      problem:
        "Use an explicit API path literal; enumerate dynamic endpoint choices.",
    };
  }
  if (
    methodArg &&
    (methodArg.length !== 3 ||
      methodArg[2]?.kind !== "string" ||
      methodArg[2].value.includes(parameter))
  ) {
    return { token, path, problem: "Use an explicit HTTP method literal." };
  }
  return { token, path, method: methodArg ? methodArg[2]!.value : "GET" };
}

function isCallStart(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index]!;
  return (
    token.kind === "word" &&
    ["request", "data"].includes(token.value) &&
    tokens[index + 1]?.value === "(" &&
    tokens[index - 1]?.value !== "func"
  );
}

function isTransportForwarder(
  file: string,
  first: readonly Token[],
  method: readonly Token[] | undefined,
): boolean {
  // APIClient's generic request-to-data transport forwards both arguments.
  return (
    file === "ios/Packages/ChatData/Sources/ChatData/APIClient.swift" &&
    first.length === 1 &&
    first[0]?.value === "path" &&
    method?.length === 3 &&
    method[2]?.value === "method"
  );
}

function isUnboundPath(
  file: string,
  tokens: readonly Token[],
  index: number,
  consumed: ReadonlySet<Token>,
): boolean {
  const token = tokens[index]!;
  if (
    token.kind !== "string" ||
    !token.value.startsWith("/api/") ||
    consumed.has(token)
  )
    return false;
  // URL recognition compares paths; it does not send a request.
  if (tokens[index - 1]?.value === "=" && tokens[index - 2]?.value === "=")
    return false;
  return !(
    token.value === "/api/" &&
    file === "ios/Packages/ChatData/Sources/ChatData/APIClient.swift"
  );
}

function matchesPath(declared: unknown, consumed: string): boolean {
  if (typeof declared !== "string") return false;
  const expected = declared.split("/");
  const actual = consumed.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) => {
      const value = actual[index]!;
      return segment.startsWith(":")
        ? value.length > 0 && !value.includes("?") && !value.includes("#")
        : segment === value;
    })
  );
}

function argumentsAt(tokens: readonly Token[], open: number): Token[][] {
  const args: Token[][] = [[]];
  let depth = 0;
  for (const token of tokens.slice(open + 1)) {
    if (token.kind === "symbol") {
      if (token.value === ")" && depth === 0) return args;
      if (token.value === "," && depth === 0) {
        args.push([]);
        continue;
      }
      if (["(", "[", "{"].includes(token.value)) depth++;
      if ([")", "]", "}"].includes(token.value)) depth--;
    }
    args[args.length - 1]!.push(token);
  }
  return args;
}

/** Skip comments and quoted strings, including nested Swift interpolations. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < source.length) {
    const char = source[offset]!;
    if (/\s/u.test(char)) offset++;
    else if (source.startsWith("//", offset)) {
      const end = source.indexOf("\n", offset);
      offset = end < 0 ? source.length : end;
    } else if (source.startsWith("/*", offset))
      offset = commentEnd(source, offset);
    else {
      const quote = /^(#*)("{3}|")/u.exec(source.slice(offset));
      if (quote) {
        const literal = quoted(source, offset, quote[1]!, quote[2]!);
        tokens.push({ kind: "string", value: literal.value, offset });
        offset = literal.end;
      } else {
        const word = /^[A-Za-z_][A-Za-z_0-9]*/u.exec(source.slice(offset))?.[0];
        tokens.push({
          kind: word ? "word" : "symbol",
          value: word ?? char,
          offset,
        });
        offset += word?.length ?? 1;
      }
    }
  }
  return tokens;
}

function commentEnd(source: string, start: number): number {
  let depth = 1;
  let offset = start + 2;
  while (offset < source.length && depth > 0) {
    if (source.startsWith("/*", offset)) {
      depth++;
      offset += 2;
    } else if (source.startsWith("*/", offset)) {
      depth--;
      offset += 2;
    } else offset++;
  }
  return offset;
}

function quoted(
  source: string,
  start: number,
  hashes: string,
  delimiter: string,
): { value: string; end: number } {
  const escape = "\\" + hashes;
  const close = delimiter + hashes;
  let offset = start + hashes.length + delimiter.length;
  let value = "";
  while (offset < source.length) {
    if (source.startsWith(close, offset))
      return { value, end: offset + close.length };
    if (source.startsWith(escape + "(", offset)) {
      let depth = 1;
      offset += escape.length + 1;
      while (offset < source.length && depth > 0) {
        const nested = /^(#*)("{3}|")/u.exec(source.slice(offset));
        if (nested) offset = quoted(source, offset, nested[1]!, nested[2]!).end;
        else if (source.startsWith("/*", offset))
          offset = commentEnd(source, offset);
        else {
          if (source[offset] === "(") depth++;
          if (source[offset] === ")") depth--;
          offset++;
        }
      }
      value += parameter;
    } else if (source.startsWith(escape, offset)) {
      // Paths must not hide separators or endpoint names in escape sequences.
      value += "\uFFFD";
      offset += escape.length + 1;
    } else {
      value += source[offset];
      offset++;
    }
  }
  return { value, end: offset };
}
