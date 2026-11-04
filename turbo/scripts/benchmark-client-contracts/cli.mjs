#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { cpus, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import ts from "typescript";
import { evaluate, verifyRetained } from "./evaluate.mjs";
import { baselineExpressionRoots } from "./baseline-roots.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const turboRoot = path.resolve(toolDirectory, "../..");
const repositoryRoot = path.resolve(turboRoot, "..");
const currentPackage = path.join(turboRoot, "packages/api-contracts");
const appSource = path.join(turboRoot, "apps/platform/src");
const require = createRequire(import.meta.url);
const defaultBaseline = "4e343a03c9a5068dc18f4f36c7e66a479124a9d3";
const prefix = "@okouai/api-contracts";
const excluded =
  /(^|\/)(?:__tests__|__mocks__|tests?|mocks?|benchmarks?|bench)(?:\/|$)|(?:^|\/)(?:tests?|mocks?|benchmarks?|bench)[-.]|[.](?:tests?|spec|mocks?|bench|benchmark)[.]|[.]d[.][cm]?ts$/;
const hash = (value) => {
  return createHash("sha256").update(value).digest("hex");
};
const git = (...args) => {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
};

function optionsFrom(args) {
  const options = {
    baseline: defaultBaseline,
    output: path.join(tmpdir(), "okou-client-contracts-benchmark"),
    iterations: 100,
    rounds: 3,
    prepareOnly: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--prepare-only") {
      options.prepareOnly = true;
      continue;
    }
    const key = {
      "--baseline": "baseline",
      "--output": "output",
      "--iterations": "iterations",
      "--rounds": "rounds",
    }[arg];
    if (!key || !args[index + 1])
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    options[key] = ["iterations", "rounds"].includes(key)
      ? Number(args[++index])
      : args[++index];
  }
  if (
    !Number.isInteger(options.iterations) ||
    options.iterations < 10 ||
    !Number.isInteger(options.rounds) ||
    options.rounds < 1
  )
    throw new Error("Use at least 10 iterations and one round.");
  options.output = path.resolve(options.output);
  return options;
}

async function sourceFiles(directory, root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (excluded.test(relative)) continue;
    if (entry.isDirectory()) files.push(...(await sourceFiles(absolute, root)));
    else if (/\.[cm]?tsx?$/.test(entry.name)) files.push(absolute);
  }
  return files.sort();
}

function baselineBinding(source, imported) {
  const expression = baselineExpressionRoots[`${source}#${imported}`];
  if (expression) return expression;
  if (source === `${prefix}/client/transport`)
    return { source: `${prefix}/contracts/trpc-contract`, imported };
  if (
    source === `${prefix}/client/response-validation` &&
    imported === "validateClientResponse"
  )
    return {
      source: `${prefix}/contracts/trpc-contract`,
      imported: "validateResponse",
    };
  if (source.startsWith(`${prefix}/client/`))
    return { source: source.replace("/client/", "/contracts/"), imported };
  if (source.startsWith(`${prefix}/validators/`))
    return { source: source.replace("/validators/", "/contracts/"), imported };
  return { source, imported };
}

async function resolveSourceFile(filename) {
  const candidates = path.extname(filename)
    ? [filename]
    : [filename + ".ts", filename + ".tsx", path.join(filename, "index.ts")];
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
    }
  }
  throw new Error(`Workspace source import did not resolve: ${filename}`);
}

export async function scanAppImports(
  sourceRoot = appSource,
  repository = repositoryRoot,
) {
  const bindings = new Map();
  const files = [];
  const initialFiles = await sourceFiles(sourceRoot, sourceRoot);
  const queue = [...initialFiles];
  const visited = new Set();
  const coreRoot = path.join(repository, "turbo/packages/core");
  let coreExports;
  async function followCore(source, importer) {
    let next;
    if (source === "@okouai/core" || source.startsWith("@okouai/core/")) {
      coreExports ??= JSON.parse(
        await readFile(path.join(coreRoot, "package.json"), "utf8"),
      ).exports;
      next = packagePath(source, coreExports, coreRoot, "@okouai/core");
    } else if (
      importer.startsWith(coreRoot + path.sep) &&
      source.startsWith(".")
    )
      next = path.resolve(path.dirname(importer), source);
    if (!next || /\.(?:json|css)$/.test(next)) return;
    next = await resolveSourceFile(next);
    if (!excluded.test(path.relative(coreRoot, next).split(path.sep).join("/")))
      queue.push(next);
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const filename = queue[cursor];
    if (visited.has(filename)) continue;
    visited.add(filename);
    const contents = await readFile(filename, "utf8");
    // TypeScript erases explicit type imports and bindings used only in type positions.
    // Parse the emitted module AST, rather than matching import text with a regexp.
    const transpiled = ts.transpileModule(contents, {
      fileName: filename,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.Preserve,
        verbatimModuleSyntax: false,
      },
    });
    const errors = (transpiled.diagnostics ?? []).filter((diagnostic) => {
      return diagnostic.category === ts.DiagnosticCategory.Error;
    });
    if (errors.length)
      throw new Error(
        ts.formatDiagnosticsWithColorAndContext(errors, {
          getCurrentDirectory() {
            return repository;
          },
          getCanonicalFileName(file) {
            return file;
          },
          getNewLine() {
            return "\n";
          },
        }),
      );
    const emitted = transpiled.outputText;
    const ast = ts.createSourceFile(
      filename,
      emitted,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of ast.statements) {
      if (
        !ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement)
      )
        continue;
      if (
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const source = statement.moduleSpecifier.text;
      await followCore(source, filename);
      if (source !== prefix && !source.startsWith(`${prefix}/`)) continue;
      const relative = path
        .relative(repository, filename)
        .split(path.sep)
        .join("/");
      function add(imported) {
        const id = `${source}#${imported}`;
        const binding = bindings.get(id) ?? {
          source,
          imported,
          baseline: baselineBinding(source, imported),
          files: [],
        };
        if (!binding.files.includes(relative)) binding.files.push(relative);
        bindings.set(id, binding);
      }
      if (ts.isImportDeclaration(statement)) {
        if (!statement.importClause) {
          add("<side-effect>");
          continue;
        }
        if (statement.importClause.name) add("default");
        const named = statement.importClause.namedBindings;
        if (named && ts.isNamespaceImport(named)) add("*");
        else if (named)
          for (const item of named.elements)
            add((item.propertyName ?? item.name).text);
      } else {
        if (
          !statement.exportClause ||
          !ts.isNamedExports(statement.exportClause)
        )
          throw new Error(
            `Unsupported contract export-star in ${relative}; enumerate its live symbols first.`,
          );
        for (const item of statement.exportClause.elements)
          add((item.propertyName ?? item.name).text);
      }
    }
    const dynamicCore = [];
    function inspectDynamic(node) {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const source = node.arguments[0].text;
        if (source.startsWith(prefix))
          throw new Error(
            `Dynamic API-contracts import requires explicit runtime-root review: ${filename}`,
          );
        dynamicCore.push(source);
      }
      ts.forEachChild(node, inspectDynamic);
    }
    inspectDynamic(ast);
    for (const source of dynamicCore) await followCore(source, filename);
    files.push({
      file: path.relative(repository, filename).split(path.sep).join("/"),
      sha256: hash(contents),
    });
  }
  files.sort((a, b) => {
    return a.file.localeCompare(b.file);
  });
  return {
    bindings: [...bindings.values()].sort((a, b) => {
      return `${a.source}#${a.imported}`.localeCompare(
        `${b.source}#${b.imported}`,
      );
    }),
    scannedFileCount: files.length,
    scannedAppFileCount: initialFiles.length,
    scannedReachableCoreFileCount: files.length - initialFiles.length,
    reachableCoreSources: files.filter((item) => {
      return item.file.startsWith("turbo/packages/core/");
    }),
    sourceDigest: hash(JSON.stringify(files)),
    exclusions: excluded.source,
  };
}

function entryFor(bindings, variant) {
  const imports = [];
  const retained = [];
  bindings.forEach((binding, index) => {
    const { source, imported, access } =
      variant === "baseline" ? binding.baseline : binding;
    if (imported === "<side-effect>") {
      imports.push(`import ${JSON.stringify(source)};`);
      return;
    }
    const local = `retained_${index}`;
    imports.push(
      imported === "*"
        ? `import * as ${local} from ${JSON.stringify(source)};`
        : `import { ${imported} as ${local} } from ${JSON.stringify(source)};`,
    );
    retained.push(
      local +
        (access ?? [])
          .map((key) => {
            return `[${JSON.stringify(key)}]`;
          })
          .join(""),
    );
  });
  return `${imports.join("\n")}\nglobalThis.__contractsBenchmarkRetained = [${retained.join(",")}];\n`;
}

function packagePath(specifier, exports, packageRoot, packageName = prefix) {
  const suffix = specifier.slice(packageName.length);
  const key = suffix ? `.${suffix}` : ".";
  let entry = exports[key];
  let wildcard;
  if (!entry)
    for (const [pattern, value] of Object.entries(exports)) {
      const star = pattern.indexOf("*");
      if (
        star >= 0 &&
        key.startsWith(pattern.slice(0, star)) &&
        key.endsWith(pattern.slice(star + 1))
      ) {
        wildcard = key.slice(star, key.length - (pattern.length - star - 1));
        entry = value;
        break;
      }
    }
  const target =
    typeof entry === "string" ? entry : (entry?.import ?? entry?.default);
  if (!target)
    throw new Error(`Package export not found: ${specifier} in ${packageRoot}`);
  return path.resolve(
    packageRoot,
    wildcard === undefined ? target : target.replaceAll("*", wildcard),
  );
}

async function compile(bindings, variant, packageRoot, instrumented) {
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  let instrumentedFiles = 0;
  const result = await esbuild.build({
    absWorkingDir: turboRoot,
    stdin: {
      contents: entryFor(bindings, variant),
      resolveDir: currentPackage,
      sourcefile: `${variant}-app-contract-imports.ts`,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    treeShaking: true,
    minify: true,
    metafile: true,
    legalComments: "none",
    logLevel: "silent",
    nodePaths: [
      path.join(currentPackage, "node_modules"),
      path.join(turboRoot, "node_modules"),
    ],
    plugins: [
      {
        name: "pinned-contracts-source",
        setup(build) {
          build.onResolve(
            { filter: /^@okouai\/api-contracts(?:\/|$)/ },
            (args) => {
              return {
                path: packagePath(args.path, packageJson.exports, packageRoot),
              };
            },
          );
          build.onResolve({ filter: /^[^./]|^@/ }, async (args) => {
            if (
              args.pluginData?.sharedDependency ||
              !args.importer.startsWith(packageRoot) ||
              args.path.startsWith(prefix)
            )
              return;
            return build.resolve(args.path, {
              kind: args.kind,
              resolveDir: currentPackage,
              pluginData: { sharedDependency: true },
            });
          });
          if (instrumented)
            build.onLoad(
              { filter: /[/\\]zod[/\\]v4[/\\]core[/\\]core\.js$/ },
              async (args) => {
                const text = await readFile(args.path, "utf8");
                const marker = "if (!inst._zod) {";
                const initMarker = "function init(inst, def) {";
                if (
                  text.split(marker).length !== 2 ||
                  text.split(initMarker).length !== 2
                )
                  throw new Error(
                    "Zod constructor instrumentation point changed; review core.js before counting.",
                  );
                instrumentedFiles++;
                return {
                  contents: text
                    .replace(
                      initMarker,
                      `${initMarker}\n globalThis.__contractsBenchmarkInitInvocations++;`,
                    )
                    .replace(
                      marker,
                      `${marker}\n const kind = def.type ? "schema" : def.check ? "check" : "other";\n const seen = globalThis.__contractsBenchmarkSeen;\n if (!seen.has(inst)) { seen.add(inst); globalThis.__contractsBenchmarkConstruction.push({ kind, name, type: def.type ?? def.check ?? "unknown" }); }`,
                    ),
                  loader: "js",
                };
              },
            );
        },
      },
    ],
  });
  if (
    instrumented &&
    !instrumentedFiles &&
    Object.keys(result.metafile.inputs).some((input) => {
      return input.includes("/zod/");
    })
  )
    throw new Error(
      "Zod was bundled but its constructor instrumentation did not run.",
    );
  for (const output of Object.values(result.metafile.outputs)) {
    if (output.imports.length)
      throw new Error(
        `Timed IIFE is not self-contained: ${JSON.stringify(output.imports)}`,
      );
  }
  const javascript = result.outputFiles[0].text;
  const contributing = new Map();
  for (const output of Object.values(result.metafile.outputs))
    for (const [input, data] of Object.entries(output.inputs))
      if (data.bytesInOutput > 0) contributing.set(input, data.bytesInOutput);
  const modules = [];
  for (const [input, bytesInOutput] of contributing) {
    const absolute = path.resolve(turboRoot, input);
    const isEntry = input.endsWith("-app-contract-imports.ts");
    const sourceContents = isEntry
      ? entryFor(bindings, variant)
      : await readFile(absolute, "utf8");
    const relative = isEntry
      ? "benchmark-entry.ts"
      : absolute.startsWith(packageRoot + path.sep)
        ? `api-contracts/${path.relative(packageRoot, absolute).split(path.sep).join("/")}`
        : input.includes("node_modules/")
          ? input.slice(input.indexOf("node_modules/"))
          : input;
    const category = isEntry
      ? "benchmark-entry"
      : relative.startsWith("api-contracts/src/client/")
        ? sourceContents.startsWith("// Generated by src/client/generate.ts")
          ? "generated-client-descriptor"
          : "client-support"
        : relative.startsWith("api-contracts/src/validators/")
          ? "validator"
          : relative.startsWith("api-contracts/src/contracts/")
            ? "contract-module"
            : "external";
    modules.push({
      path: relative,
      category,
      bytesInOutput,
      sha256: hash(sourceContents),
    });
  }
  modules.sort((a, b) => {
    return a.path.localeCompare(b.path);
  });
  return {
    javascript,
    metafile: result.metafile,
    summary: {
      bytes: Buffer.byteLength(javascript),
      sha256: hash(javascript),
      retainedInputCount: modules.length,
      retainedModuleCount: modules.filter((item) => {
        return item.category !== "benchmark-entry";
      }).length,
      retainedApiContractsModuleCount: modules.filter((item) => {
        return item.path.startsWith("api-contracts/");
      }).length,
      retainedContractModuleCount: modules.filter((item) => {
        return item.path.startsWith("api-contracts/src/contracts/");
      }).length,
      retainedClientModuleCount: modules.filter((item) => {
        return item.path.startsWith("api-contracts/src/client/");
      }).length,
      retainedDescriptorModuleCount: modules.filter((item) => {
        return item.category === "generated-client-descriptor";
      }).length,
      retainedClientSupportModuleCount: modules.filter((item) => {
        return item.category === "client-support";
      }).length,
      retainedValidatorModuleCount: modules.filter((item) => {
        return item.category === "validator";
      }).length,
      retainedZodModuleCount: modules.filter((item) => {
        return item.path.includes("/zod/");
      }).length,
      modules,
    },
  };
}

async function packageSourceFingerprint() {
  const root = path.join(currentPackage, "src");
  const sources = await Promise.all(
    (await sourceFiles(root, root)).map(async (filename) => {
      return {
        file: path.relative(currentPackage, filename),
        sha256: hash(await readFile(filename)),
      };
    }),
  );
  return hash(JSON.stringify(sources));
}

export async function prepare(options) {
  const baselineSha = git("rev-parse", `${options.baseline}^{commit}`);
  const temporary = await mkdtemp(path.join(tmpdir(), "okou-contracts-bench-"));
  const baselinePackage = path.join(temporary, "turbo/packages/api-contracts");
  await mkdir(options.output, { recursive: true });
  try {
    const archive = execFileSync(
      "git",
      [
        "archive",
        baselineSha,
        "turbo/packages/api-contracts",
        "turbo/apps/platform/src",
        "turbo/packages/core",
      ],
      { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024 },
    );
    execFileSync("tar", ["-xf", "-", "-C", temporary], { input: archive });
    const manifest = await scanAppImports();
    const candidateSourceFingerprint = await packageSourceFingerprint();
    const baselineManifest = await scanAppImports(
      path.join(temporary, "turbo/apps/platform/src"),
      temporary,
    );
    const identity = (binding) => {
      return `${binding.baseline.source}#${binding.baseline.imported}`;
    };
    const baselineIdentities = new Set(baselineManifest.bindings.map(identity));
    const candidateIdentities = new Set(manifest.bindings.map(identity));
    const reconciliation = {
      baselineBindingCount: baselineManifest.bindings.length,
      candidateBindingCount: manifest.bindings.length,
      baselineCanonicalRootCount: baselineIdentities.size,
      candidateCanonicalRootCount: candidateIdentities.size,
      expressionMappings: manifest.bindings
        .filter((binding) => {
          return binding.baseline.access;
        })
        .map((binding) => {
          return {
            candidate: { source: binding.source, imported: binding.imported },
            baseline: binding.baseline,
          };
        }),
      sourceAliasMappings: manifest.bindings
        .filter((binding) => {
          return (
            !binding.baseline.access &&
            baselineExpressionRoots[`${binding.source}#${binding.imported}`]
          );
        })
        .map((binding) => {
          return {
            candidate: { source: binding.source, imported: binding.imported },
            baseline: binding.baseline,
          };
        }),
      baselineOnly: [...baselineIdentities]
        .filter((item) => {
          return !candidateIdentities.has(item);
        })
        .sort(),
      candidateOnly: [...candidateIdentities]
        .filter((item) => {
          return !baselineIdentities.has(item);
        })
        .sort(),
    };
    if (
      reconciliation.baselineOnly.length ||
      reconciliation.candidateOnly.length
    )
      throw new Error(
        `Production runtime symbol identities differ after path mapping; review the migration before benchmarking: ${JSON.stringify(reconciliation)}`,
      );
    if (!manifest.bindings.length)
      throw new Error("No production App runtime contract imports found.");
    const expectedRetained = manifest.bindings.filter((binding) => {
      return binding.imported !== "<side-effect>";
    }).length;
    const variants = {};
    for (const [variant, packageRoot] of [
      ["baseline", baselinePackage],
      ["candidate", currentPackage],
    ]) {
      const timed = await compile(
        manifest.bindings,
        variant,
        packageRoot,
        false,
      );
      const counted = await compile(
        manifest.bindings,
        variant,
        packageRoot,
        true,
      );
      const retained = evaluate(timed.javascript);
      verifyRetained(retained.values, expectedRetained);
      const instrumented = evaluate(counted.javascript, true);
      verifyRetained(instrumented.values, expectedRetained);
      const construction = {
        schema: 0,
        check: 0,
        other: 0,
        initInvocations: instrumented.initInvocations,
        byType: {},
      };
      for (const item of instrumented.construction) {
        construction[item.kind]++;
        const key = `${item.kind}:${item.type}`;
        construction.byType[key] = (construction.byType[key] ?? 0) + 1;
      }
      const timedPaths = timed.summary.modules.map((item) => {
        return item.path;
      });
      const instrumentedPaths = counted.summary.modules.map((item) => {
        return item.path;
      });
      const instrumentationPreservesModuleSet =
        JSON.stringify(timedPaths) === JSON.stringify(instrumentedPaths);
      variants[variant] = {
        ...timed.summary,
        construction,
        instrumentationPreservesModuleSet,
        instrumentedModuleCount: instrumentedPaths.length,
        retainedValueCount: retained.values.length,
      };
      await writeFile(
        path.join(options.output, `${variant}.js`),
        timed.javascript,
      );
      await writeFile(
        path.join(options.output, `${variant}.metafile.json`),
        JSON.stringify(timed.metafile, null, 2) + "\n",
      );
      await writeFile(
        path.join(options.output, `${variant}.entry.ts`),
        entryFor(manifest.bindings, variant),
      );
    }
    if (
      manifest.sourceDigest !== (await scanAppImports()).sourceDigest ||
      candidateSourceFingerprint !== (await packageSourceFingerprint())
    )
      throw new Error(
        "App or api-contracts sources changed during preparation. Wait for migration edits to finish, then rerun.",
      );
    const pilotAncestryStatus = spawnSync(
      "git",
      ["merge-base", "--is-ancestor", "cd2393ad15", baselineSha],
      { cwd: repositoryRoot },
    ).status;
    const metadata = {
      preparedAt: new Date().toISOString(),
      node: process.version,
      nodeFlags: process.execArgv,
      v8: process.versions.v8,
      host: {
        cpuModel: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
      },
      zod: createRequire(path.join(currentPackage, "package.json"))(
        "zod/package.json",
      ).version,
      platform: process.platform,
      arch: process.arch,
      vitest: require("vitest/package.json").version,
      esbuild: esbuild.version,
      typescript: ts.version,
      bundleOptions: {
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2022",
        treeShaking: true,
        minify: true,
        legalComments: "none",
        selfContained: true,
      },
      baseline: {
        ref: options.baseline,
        sha: baselineSha,
        agentsPilotIncluded:
          pilotAncestryStatus === 0
            ? true
            : pilotAncestryStatus === 1
              ? false
              : null,
        agentsPilotAncestryCheckStatus: pilotAncestryStatus,
      },
      candidate: {
        head: git("rev-parse", "HEAD"),
        sourceFingerprint: candidateSourceFingerprint,
        status: git("status", "--short"),
        trackedSourceDiffSha256: hash(
          git(
            "diff",
            "HEAD",
            "--",
            "turbo/packages/api-contracts/src",
            "turbo/apps/platform/src",
            "turbo/packages/core/src",
          ),
        ),
      },
      repetitions: {
        rounds: options.rounds,
        iterationsPerRound: options.iterations,
        warmupIterationsPerVariantPerRound: 5,
        order:
          "alternating baseline-first/candidate-first by round; sequential tasks",
      },
      method:
        "Precompiled self-contained browser-target IIFE evaluated with vm.Script.runInContext in a newly created VM context each iteration. Fresh context creation, evaluation, result retrieval and sink assignment are timed. Bundle compilation and instrumentation are outside timing.",
      limitations: [
        "Node VM cold module evaluation is not browser FCP, startup, rendering, networking, or request performance.",
        "The precompiled script may reuse V8 compilation/JIT state, but module bindings, globals, schemas and ESM-equivalent module state are newly evaluated in every fresh context; this is not cold process or cold parse/compile timing.",
        "The production App runtime import union includes API roots from all App source plus recursively App-reachable Core modules, including pi-execution and onboarding-industry. All runtime API imports in a reachable Core module are conservatively retained; its Core computation code is not timed. Other workspace indirections are not recursively scanned. The union includes lazy routes/workers/helpers, not a measured initial route/chunk loading graph. TypeScript erases type-only uses; tests/mocks/benchmarks are excluded by the recorded pattern.",
        "Imported runtime values are retained wholesale, an upper-bound surface rather than App property-level tree shaking; no contract functions, requests or parses are invoked.",
        "Both variants use current installed external/workspace dependencies, identical esbuild options and shared host globals. Only api-contracts sources are substituted from the pinned baseline.",
        "Fresh VM overhead and host GC/resource contention are included in both variants. Alternating order reduces, but cannot eliminate, drift. No statistical performance gate is imposed.",
        "Schema/check counts come from a separate instrumented bundle and a single WeakSet counts each object once at first _zod installation. Categories are disjoint: def.type => schema, otherwise def.check => check, otherwise other; schema/check inheritance cannot double-count. All Zod trait init invocations are separately reported and are not unique-instance counts or timings. Unique-object counts and trait initializer invocations measure different work and must not be equated. Instrumentation module-set equality is reported separately.",
        "client/transport maps to baseline contracts/trpc-contract; candidate validateClientResponse maps to baseline validateResponse for initialization-only comparison. Newly direct validator imports map explicitly to original baseline router property expressions in baseline-roots.mjs and must be covered by an actual baseline App router import. Other client and validators module paths map to their original contract module paths with identical exported symbols. Baseline and candidate App AST scans are identity-reconciled at original router/export root level before building; expression mappings and binding counts are reported.",
      ],
      expectedRetained,
      reconciliation,
      manifest,
      baselineManifest,
      variants,
    };
    await writeFile(
      path.join(options.output, "metadata.json"),
      JSON.stringify(metadata, null, 2) + "\n",
    );
    return metadata;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node scripts/benchmark-client-contracts/cli.mjs [--baseline <git-ref>] [--output <directory>] [--iterations 100] [--rounds 3] [--prepare-only]\nRun from turbo/. This starts only the dedicated Vitest benchmark, never full tests. --prepare-only bundles and counts without starting Vitest.",
    );
    return;
  }
  const metadata = await prepare(options);
  esbuild.stop();
  console.log(
    `Prepared ${metadata.expectedRetained} retained App runtime bindings; baseline ${metadata.baseline.sha}.`,
  );
  if (options.prepareOnly) {
    console.log(
      `Prepared metadata: ${path.join(options.output, "metadata.json")}`,
    );
    return;
  }
  const result = spawnSync(
    process.execPath,
    [
      path.join(
        path.dirname(require.resolve("vitest/package.json")),
        "vitest.mjs",
      ),
      "bench",
      "--run",
      "--config",
      path.join(toolDirectory, "vitest.config.ts"),
    ],
    {
      cwd: turboRoot,
      stdio: "inherit",
      env: { ...process.env, OKOU_CONTRACTS_BENCHMARK_DIR: options.output },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Vitest benchmark exited ${result.status ?? result.signal}`,
    );
  console.log(`Results: ${path.join(options.output, "results.json")}`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
