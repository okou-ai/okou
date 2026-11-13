import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isNoBody } from "../contracts/trpc-contract";
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
} from "./syntax";
import { renderKotlinModels } from "./models";
import { pathBinding, queryBinding } from "./routes";
import {
  kotlinHistoryFixtureJson,
  kotlinHistoryFixtureRoutes,
  kotlinHistoryFixtureTypes,
} from "./history-fixtures";
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
  const queries = routes.map(({ name, route }) => {
    return queryBinding(name, route);
  });
  const helpers: string[] = [];
  const modelTypes = [
    ...types,
    ...queries.flatMap((query) => {
      return query.type ? [query.type] : [];
    }),
  ];
  const names = routes.flatMap(({ name }, index) => {
    return queries[index]!.type ? [name, `${name}Wire`] : [name];
  });
  if (new Set(names).size !== names.length)
    throw new Error("Duplicate Retrofit method");
  const methods = routes.map(({ name, response, request, route }, index) => {
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/u.test(route.method)) {
      throw new Error(`${name}: unsupported Retrofit route`);
    }
    if (
      Boolean(request) !==
        (route.body !== undefined && !isNoBody(route.body)) ||
      !route.responses[200]
    )
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
    const path = pathBinding(route);
    const query = queries[index]!;
    const parameters = [
      '@Header("Authorization") token: String',
      ...path.parameters,
      ...(request ? [`@Body body: ${typeName(request)}`] : []),
      ...query.parameters,
    ];
    if (query.type) {
      helpers.push(`internal suspend fun CanonicalApi.${identifier(name)}(${[
        "token: String",
        ...path.arguments.map((argument) => {
          return `${argument}: String`;
        }),
        ...(request ? [`body: ${typeName(request)}`] : []),
        `query: ${typeName(query.type.name)}`,
      ].join(", ")}): Response<${typeName(response)}> =
    ${identifier(`${name}Wire`)}(${["token", ...path.arguments, ...(request ? ["body"] : []), "query.toQueryParameters()"].join(", ")})`);
      helpers.push(query.helper!);
    }
    return `    @${route.method}(${quote(path.path)})\n    suspend fun ${identifier(query.type ? `${name}Wire` : name)}(${parameters.join(", ")}): Response<${typeName(response)}>`;
  });
  const constants = {
    CLIENT_TYPE: CLIENT_TYPE_ANDROID,
    TYPE_HEADER: CLIENT_TYPE_HEADER,
    VERSION_HEADER: CLIENT_VERSION_HEADER,
    SESSION_HEADER: CLIENT_SESSION_ID_HEADER,
    REQUEST_HEADER: CLIENT_REQUEST_ID_HEADER,
  };
  const imports = new Set(["retrofit2.Response", "retrofit2.http.Header"]);
  for (const [index, { route, request }] of routes.entries()) {
    imports.add(`retrofit2.http.${route.method}`);
    if (request) imports.add("retrofit2.http.Body");
    if (route.pathParams) imports.add("retrofit2.http.Path");
    if (route.query)
      imports.add(
        queries[index]!.type
          ? "retrofit2.http.QueryMap"
          : "retrofit2.http.Query",
      );
  }
  if (helpers.length > 0) {
    for (const item of ["Json", "JsonObject", "JsonPrimitive"])
      imports.add(`kotlinx.serialization.json.${item}`);
    for (const extension of ["doubleOrNull", "booleanOrNull"]) {
      if (
        helpers.some((helper) => {
          return helper.includes(`.${extension}`);
        })
      )
        imports.add(`kotlinx.serialization.json.${extension}`);
    }
  }
  const routeImports = [...imports]
    .sort()
    .map((value) => {
      return `import ${value}`;
    })
    .join("\n");
  return new Map([
    ["ApiModels.kt", renderKotlinTypes(modelTypes, packageName)],
    [
      "CanonicalApi.kt",
      `${header}\n${routeImports}\n\ninternal interface CanonicalApi {\n${methods.join("\n\n")}\n}\n${helpers.length ? `\n${helpers.join("\n\n")}\n` : ""}`,
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
  for (const [file, source] of renderKotlinFiles({
    routes: kotlinHistoryFixtureRoutes,
    types: kotlinHistoryFixtureTypes,
    packageName: "ai.okou.android.api.historyfixtures",
  })) {
    if (file !== "ApiHeaders.kt")
      files.set(
        join(
          "android/app/src/test/kotlin/ai/okou/android/api/historyfixtures",
          file,
        ),
        source,
      );
  }
  files.set(
    "android/app/src/test/resources/api-bindings/chat-history.json",
    kotlinHistoryFixtureJson(),
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
