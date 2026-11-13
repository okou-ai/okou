import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toJSONSchema } from "zod";
import {
  CLIENT_TYPE_ANDROID,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_REQUEST_ID_HEADER,
} from "../contracts/client-headers";
import {
  kotlinRouteBindings,
  kotlinTypeBindings,
  type KotlinRouteBinding,
  type KotlinTypeBinding,
} from "./bindings";
import {
  defaultKotlinPackage,
  kotlinHeader,
  kotlinIdentifier as identifier,
  kotlinQuote as quote,
  kotlinTypeName as typeName,
  renderKotlinModels,
  schemaObject,
} from "./models";
import { kotlinTokens } from "./source-tokens";
import {
  kotlinFixtureJson,
  kotlinFixtureRoutes,
  kotlinFixtureTypes,
} from "./fixtures";

export const generatedKotlinRelativeDirectory =
  "android/app/src/main/kotlin/ai/okou/android/api/generated";
const repositoryRoot = fileURLToPath(
  new URL("../../../../../", import.meta.url),
);
export function renderKotlinTypes(
  bindings: readonly KotlinTypeBinding[] = kotlinTypeBindings,
  packageName = defaultKotlinPackage,
): string {
  return renderKotlinModels(bindings, packageName);
}

function queryParameters(route: KotlinRouteBinding["route"]): string[] {
  if (!route.query) return [];
  // Retrofit serializes typed scalars into query strings; Zod's output captures
  // the post-coercion scalar type rather than the unknown coercion input.
  // Server-defaulted fields remain explicit arguments rather than duplicating defaults.
  const schema = toJSONSchema(route.query, { io: "output" });
  if (
    !schemaObject(schema) ||
    schema.type !== "object" ||
    !schemaObject(schema.properties) ||
    (schema.additionalProperties !== undefined &&
      schema.additionalProperties !== false)
  )
    throw new Error("Unsupported Retrofit query schema");
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const names = new Set<string>();
  return Object.entries(schema.properties).map(([field, value]) => {
    identifier(field);
    if (
      !schemaObject(value) ||
      value.anyOf ||
      value.enum ||
      value.const !== undefined
    )
      throw new Error("Unsupported Retrofit query field");
    const scalar = (() => {
      switch (value.type) {
        case "string":
          return "String";
        case "integer":
          return "Long";
        case "number":
          return "Double";
        case "boolean":
          return "Boolean";
        default:
          return undefined;
      }
    })();
    if (!scalar) throw new Error("Unsupported Retrofit query field");
    const name = identifier(`query${field[0]!.toUpperCase()}${field.slice(1)}`);
    if (names.has(name)) throw new Error("Duplicate Retrofit query parameter");
    names.add(name);
    const optional = !required.has(field);
    return `@Query(${quote(field)}) ${name}: ${scalar}${optional ? "? = null" : ""}`;
  });
}

export function renderKotlinFiles(
  config: {
    readonly types?: readonly KotlinTypeBinding[];
    readonly routes?: readonly KotlinRouteBinding[];
    readonly packageName?: string;
  } = {},
): ReadonlyMap<string, string> {
  const {
    types = kotlinTypeBindings,
    routes = kotlinRouteBindings,
    packageName = defaultKotlinPackage,
  } = config;
  const header = kotlinHeader(packageName);
  const methods = routes.map(({ name, response, request, route }) => {
    if (
      !/^(GET|POST|PUT|PATCH|DELETE)$/u.test(route.method) ||
      !/^\/api\/[A-Za-z0-9/-]+$/u.test(route.path) ||
      route.pathParams
    ) {
      throw new Error(`${name}: unsupported Retrofit route`);
    }
    if (Boolean(request) !== Boolean(route.body) || !route.responses[200])
      throw new Error(`${name}: unsupported request/response binding`);
    const responseType = types.find((binding) => {
      return binding.name === response;
    });
    const requestType = types.find((binding) => {
      return binding.name === request;
    });
    if (
      !responseType ||
      responseType.schema !== route.responses[200] ||
      responseType.direction !== "output" ||
      (request &&
        (!requestType ||
          requestType.schema !== route.body ||
          requestType.direction !== "input"))
    ) {
      throw new Error(
        `${name}: DTO binding does not match the canonical route schema`,
      );
    }
    const parameters = [
      '@Header("Authorization") token: String',
      ...(request ? [`@Body body: ${typeName(request)}`] : []),
      ...queryParameters(route),
    ];
    return `    @${route.method}(${quote(route.path)})\n    suspend fun ${identifier(name)}(${parameters.join(", ")}): Response<${typeName(response)}>`;
  });
  const constants = {
    CLIENT_TYPE: CLIENT_TYPE_ANDROID,
    TYPE_HEADER: CLIENT_TYPE_HEADER,
    VERSION_HEADER: CLIENT_VERSION_HEADER,
    SESSION_HEADER: CLIENT_SESSION_ID_HEADER,
    REQUEST_HEADER: CLIENT_REQUEST_ID_HEADER,
  };
  const imports = new Set(["retrofit2.Response", "retrofit2.http.Header"]);
  for (const { route, request } of routes) {
    imports.add(`retrofit2.http.${route.method}`);
    if (request) imports.add("retrofit2.http.Body");
    if (route.query) imports.add("retrofit2.http.Query");
  }
  const routeImports = [...imports]
    .sort()
    .map((value) => {
      return `import ${value}`;
    })
    .join("\n");
  return new Map([
    ["ApiModels.kt", renderKotlinTypes(types, packageName)],
    [
      "CanonicalApi.kt",
      `${header}\n${routeImports}\n\ninternal interface CanonicalApi {\n${methods.join("\n\n")}\n}\n`,
    ],
    [
      "ApiHeaders.kt",
      `${header}\ninternal object ApiHeaders {\n${Object.entries(constants)
        .map(([name, value]) => {
          return `    const val ${name} = ${quote(value)}`;
        })
        .join("\n")}\n}\n`,
    ],
  ]);
}

export function renderKotlinTestFiles(): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  const directory = "android/app/src/test/kotlin/ai/okou/android/api/fixtures";
  for (const [file, source] of renderKotlinFiles({
    routes: kotlinFixtureRoutes,
    types: kotlinFixtureTypes,
    packageName: "ai.okou.android.api.fixtures",
  })) {
    if (file !== "ApiHeaders.kt") files.set(join(directory, file), source);
  }
  files.set(
    "android/app/src/test/resources/api-bindings/chat-list.json",
    kotlinFixtureJson(),
  );
  return files;
}

function outputFiles(testFixtures: boolean): ReadonlyMap<string, string> {
  return new Map([
    ...[...renderKotlinFiles()].map(([file, source]) => {
      return [join(generatedKotlinRelativeDirectory, file), source] as const;
    }),
    ...(testFixtures ? renderKotlinTestFiles() : []),
  ]);
}

export async function checkGeneratedKotlin(
  root = repositoryRoot,
  { testFixtures = false }: { readonly testFixtures?: boolean } = {},
): Promise<string[]> {
  const findings: string[] = [];
  for (const [path, expected] of outputFiles(testFixtures)) {
    let actual: string;
    try {
      actual = await readFile(join(root, path), "utf8");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      findings.push(`${path}: missing generated file`);
      continue;
    }
    const tokens = (source: string) => {
      const parts = kotlinTokens(source);
      return JSON.stringify(
        parts
          .filter((token, index) => {
            return (
              token.text !== "," ||
              ![")", "]", "}"].includes(parts[index + 1]?.text ?? "")
            );
          })
          .map((token) => {
            return token.text;
          }),
      );
    };
    if (
      path.endsWith(".kt")
        ? tokens(actual) !== tokens(expected)
        : actual !== expected
    )
      findings.push(
        `${path}: generated API drift; run generate:kotlin and Android spotlessApply`,
      );
  }
  return findings;
}

async function main() {
  if (
    process.argv.slice(2).some((arg) => {
      return arg !== "--check";
    })
  )
    throw new Error("Usage: generate.ts [--check]");
  if (process.argv.includes("--check")) {
    const findings = await checkGeneratedKotlin(repositoryRoot, {
      testFixtures: true,
    });
    if (findings.length > 0) throw new Error(findings.join("\n"));
    return;
  }
  for (const [file, content] of outputFiles(true)) {
    const path = join(repositoryRoot, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
