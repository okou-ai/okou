import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { build, loadConfigFromFile } from "vite";

import { applicationResourcePriorityHtmlPlugin } from "./app-resource-priority-html.ts";
import {
  APPLICATION_LAZY_CHUNK,
  RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES,
  applicationBundleViolations as validateApplicationBundle,
  applicationJavaScriptBundlePlugin,
  isVendorModule,
  singleWorkerBundleViolations,
  singleWorkerJavaScriptBundlePlugin,
} from "./single-bundle.ts";
import { clerkUiAssetPlugin } from "./clerk-ui.ts";
import { dependencyVendorChunks } from "./vendor-chunks.ts";
import {
  domGlobalUsageCounts,
  workerDomGlobalsMessage,
} from "./worker-dom-globals.ts";

const productionConfigPromise = loadConfigFromFile(
  { command: "build", mode: "production" },
  new URL("../vite.config.ts", import.meta.url).pathname,
);

await test("production build isolates the configured lazy dependency", async () => {
  const loaded = await productionConfigPromise;

  assert.ok(loaded);
  const rolldownOptions = loaded.config.build?.rolldownOptions;
  assert.ok(rolldownOptions);
  const output = rolldownOptions.output;
  assert.ok(output && !Array.isArray(output));
  const codeSplitting = output.codeSplitting;
  assert.equal(typeof codeSplitting, "object");
  assert.ok(codeSplitting && typeof codeSplitting === "object");
  const groups = codeSplitting.groups;
  assert.ok(groups);
  assert.equal(groups.length, 6);
  assert.equal(codeSplitting.includeDependenciesRecursively, false);
  assert.equal(output.strictExecutionOrder, true);
  assert.equal(rolldownOptions.preserveEntrySignatures, false);
  const lazyGroup = groups[0];
  const vendorGroup = groups[2];
  const mermaidGroup = groups[5];
  assert.equal(lazyGroup?.name, APPLICATION_LAZY_CHUNK.name);
  assert.ok(lazyGroup?.test instanceof RegExp);
  assert.equal(
    lazyGroup.test.source,
    APPLICATION_LAZY_CHUNK.modulePattern.source,
  );
  assert.equal(vendorGroup?.name, "vendor-2");
  assert.equal(mermaidGroup?.name, "vendor-5");
  assert.equal(typeof vendorGroup?.test, "function");
  if (typeof vendorGroup?.test !== "function") {
    assert.fail("Expected a vendor module filter");
  }
  assert.equal(vendorGroup.test("/repo/node_modules/react/index.js"), true);
  assert.equal(
    typeof mermaidGroup.test === "function" &&
      mermaidGroup.test("/repo/packages/mermaid-lite/dist/mermaid.esm.min.mjs"),
    true,
  );
  assert.equal(
    vendorGroup.test("/repo/packages/mermaid-lite/src/index.ts"),
    false,
  );
  assert.equal(
    vendorGroup.test("/repo/packages/core/src/resource-registry.ts"),
    false,
  );
  assert.equal(
    vendorGroup.test("/repo/node_modules/katex/dist/katex.mjs"),
    false,
  );
  assert.equal(vendorGroup.test("/repo/src/main.ts"), false);
  assert.equal(loaded.config.define?.__OKOU_APP_GIT_COMMIT_SHA__, undefined);
  assert.equal(
    typeof JSON.parse(loaded.config.define?.__OKOU_APP_VERSION__ ?? "null"),
    "string",
  );
  assert.ok(
    loaded.config.plugins?.some((plugin) => {
      return (
        typeof plugin === "object" &&
        plugin !== null &&
        "name" in plugin &&
        plugin.name === "platform-runtime-build-info-html"
      );
    }),
  );
});

await test("production shared worker stays on the app origin", async () => {
  const loaded = await productionConfigPromise;

  assert.ok(loaded);
  const renderBuiltUrl = loaded.config.experimental?.renderBuiltUrl;
  assert.equal(typeof renderBuiltUrl, "function");
  assert.ok(renderBuiltUrl);
  const context = {
    hostId: "assets/index-AbCd1234.js",
    hostType: "js",
    ssr: false,
    type: "asset",
  } satisfies Parameters<typeof renderBuiltUrl>[1];
  assert.deepEqual(
    renderBuiltUrl("assets/shared-database-worker-AbCd1234.js", context),
    {
      runtime:
        'location.origin + "/okou-app/assets/shared-database-worker-AbCd1234.js"',
    },
  );
  assert.equal(renderBuiltUrl("assets/index-AbCd1234.js", context), undefined);
});

const APP_FILE = "assets/index-AppHash1.js";
const LAZY_FILE = "assets/katex-KatexHash1.js";
const VENDOR_FILE = "assets/vendor-Vendor01.js";
const RUNTIME_FILE = "assets/rolldown-runtime-Runtime1.js";

function applicationBundleViolations(
  outputs: Parameters<typeof validateApplicationBundle>[0],
) {
  return validateApplicationBundle([
    ...outputs,
    {
      type: "asset",
      fileName: "assets/clerk-ui-UiHash01.js",
      source: "ui",
    },
  ]);
}

function applicationChunk() {
  return {
    code: "entry",
    dynamicImports: [LAZY_FILE],
    fileName: APP_FILE,
    imports: [RUNTIME_FILE, VENDOR_FILE],
    isEntry: true,
    moduleIds: ["/repo/apps/platform/src/main.ts"],
    type: "chunk" as const,
  };
}

function lazyChunk() {
  return {
    code: "katex",
    fileName: LAZY_FILE,
    imports: [RUNTIME_FILE],
    moduleIds: ["/repo/node_modules/katex/dist/katex.mjs"],
    type: "chunk" as const,
  };
}

function vendorChunk() {
  return {
    code: "vendor",
    fileName: VENDOR_FILE,
    imports: [RUNTIME_FILE],
    moduleIds: [
      "/repo/node_modules/react/index.js",
      "/repo/node_modules/rehype-prism-plus/dist/common.es.js",
      "/repo/node_modules/refractor/lib/common.js",
      "/repo/packages/mermaid-lite/dist/mermaid.esm.min.mjs",
    ],
    type: "chunk" as const,
  };
}

function runtimeChunk() {
  return {
    code: "runtime",
    fileName: RUNTIME_FILE,
    moduleIds: ["\0rolldown:runtime"],
    type: "chunk" as const,
  };
}

function workerAsset() {
  return {
    fileName: "assets/shared-database-worker-Worker01.js",
    source: "worker",
    type: "asset" as const,
  };
}

function validApplicationOutputs() {
  return [
    applicationChunk(),
    lazyChunk(),
    vendorChunk(),
    runtimeChunk(),
    workerAsset(),
  ];
}

await test("requires the fixed app, lazy, vendor, runtime, and worker layout", () => {
  assert.deepEqual(applicationBundleViolations(validApplicationOutputs()), []);
  assert.deepEqual(
    applicationBundleViolations(validApplicationOutputs().slice(0, 4)),
    [
      `Expected exactly one app entry, one lazy chunk, 1 vendor chunk(s), one Rolldown runtime chunk, and one shared database worker asset, but generated: ${APP_FILE} (chunk), ${LAZY_FILE} (chunk), ${VENDOR_FILE} (chunk), ${RUNTIME_FILE} (chunk)`,
    ],
  );
  assert.deepEqual(
    applicationBundleViolations([
      ...validApplicationOutputs(),
      { code: "lazy", fileName: "assets/lazy-Extra001.js", type: "chunk" },
    ]),
    [
      `Expected exactly one app entry, one lazy chunk, 1 vendor chunk(s), one Rolldown runtime chunk, and one shared database worker asset, but generated: ${APP_FILE} (chunk), ${LAZY_FILE} (chunk), ${VENDOR_FILE} (chunk), ${RUNTIME_FILE} (chunk), assets/shared-database-worker-Worker01.js (asset), assets/lazy-Extra001.js (chunk)`,
    ],
  );
});

await test("keeps the configured dependency behind the only dynamic import", () => {
  const violations = applicationBundleViolations([
    { ...applicationChunk(), dynamicImports: [] },
    {
      ...lazyChunk(),
      moduleIds: [
        ...lazyChunk().moduleIds,
        "/repo/node_modules/react/index.js",
      ],
    },
    vendorChunk(),
    runtimeChunk(),
    workerAsset(),
  ]);
  assert.deepEqual(violations, [
    `${APP_FILE}: expected exactly one dynamic import (${LAZY_FILE})`,
    `${LAZY_FILE}: unexpected modules in the configured lazy chunk: /repo/node_modules/react/index.js`,
  ]);
});

await test("rejects raw-size regressions", () => {
  const violations = applicationBundleViolations([
    {
      ...applicationChunk(),
      code: "x".repeat(RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES),
    },
    vendorChunk(),
    lazyChunk(),
    runtimeChunk(),
    workerAsset(),
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /raw bytes exceeds/u);
});

await test("keeps third-party modules only in vendor and rejects extra edges", () => {
  const violations = applicationBundleViolations([
    {
      ...applicationChunk(),
      dynamicImports: [LAZY_FILE, "assets/lazy-Extra001.js"],
      moduleIds: [
        "/repo/apps/platform/src/main.ts",
        "/repo/node_modules/react/index.js",
      ],
    },
    {
      ...vendorChunk(),
      moduleIds: [
        "/repo/node_modules/react/index.js",
        "/repo/node_modules/@clerk/clerk-js/dist/clerk.mjs",
      ],
    },
    lazyChunk(),
    runtimeChunk(),
    workerAsset(),
  ]);
  assert.ok(
    violations.some((violation) => {
      return violation.includes("unexpected dynamic JavaScript imports");
    }),
  );
  assert.ok(
    violations.some((violation) => {
      return violation.includes("third-party modules must be emitted only");
    }),
  );
  assert.ok(
    violations.some((violation) => {
      return violation.includes(
        "forbidden packages reached the bundle: @clerk/clerk-js",
      );
    }),
  );
});

await test("keeps only the generated Mermaid workspace module in vendor", () => {
  const missingMermaid = applicationBundleViolations([
    applicationChunk(),
    {
      ...vendorChunk(),
      moduleIds: vendorChunk().moduleIds.filter((moduleId) => {
        return !moduleId.includes("/packages/mermaid-lite/");
      }),
    },
    lazyChunk(),
    runtimeChunk(),
    workerAsset(),
  ]);
  assert.ok(
    missingMermaid.some((violation) => {
      return violation.includes("expected exactly one /packages/mermaid-lite/");
    }),
  );

  const unrelatedWorkspaceModule =
    "/repo/packages/core/src/presentation-template-items.ts";
  assert.deepEqual(
    applicationBundleViolations([
      applicationChunk(),
      {
        ...vendorChunk(),
        moduleIds: [...vendorChunk().moduleIds, unrelatedWorkspaceModule],
      },
      lazyChunk(),
      runtimeChunk(),
      workerAsset(),
    ]),
    [
      `${VENDOR_FILE}: only node_modules and /packages/mermaid-lite/dist/mermaid.esm.min.mjs may be emitted in the vendor chunk: ${unrelatedWorkspaceModule}`,
    ],
  );
});

await test("allows Prism common and rejects non-common entries", () => {
  assert.deepEqual(applicationBundleViolations(validApplicationOutputs()), []);

  assert.deepEqual(
    applicationBundleViolations([
      applicationChunk(),
      {
        ...vendorChunk(),
        moduleIds: [
          ...vendorChunk().moduleIds,
          "/repo/node_modules/rehype-prism-plus/dist/index.es.js",
          "/repo/node_modules/rehype-prism-plus/dist/all.es.js",
          "/repo/node_modules/rehype-prism-plus/dist/generator.es.js",
          "/repo/node_modules/refractor/lib/all.js",
        ],
      },
      lazyChunk(),
      runtimeChunk(),
      workerAsset(),
    ]),
    [
      `${VENDOR_FILE}: forbidden non-common Prism modules reached the bundle: rehype-prism-plus (root entry), rehype-prism-plus/all, rehype-prism-plus/generator, refractor/all`,
    ],
  );
});

await test("rejects server-only contracts from the eager platform graph", () => {
  assert.deepEqual(
    applicationBundleViolations([
      {
        ...applicationChunk(),
        moduleIds: [
          "/repo/apps/platform/src/main.ts",
          "/repo/packages/api-contracts/src/contracts/runners.ts",
          "/repo/packages/api-contracts/src/contracts/webhooks.ts",
        ],
      },
      vendorChunk(),
      lazyChunk(),
      runtimeChunk(),
      workerAsset(),
    ]),
    [
      `${APP_FILE}: server-only API contract modules reached the eager platform graph: /packages/api-contracts/src/contracts/runners.ts, /packages/api-contracts/src/contracts/webhooks.ts`,
    ],
  );

  assert.deepEqual(
    singleWorkerBundleViolations([
      {
        code: "worker",
        fileName: "assets/shared-database-worker.js",
        moduleIds: ["/repo/packages/api-contracts/src/contracts/runners.ts"],
        type: "chunk",
      },
    ]),
    [
      "assets/shared-database-worker.js: server-only API contract modules reached the eager platform graph: /packages/api-contracts/src/contracts/runners.ts",
    ],
  );
});

await test("rejects worker chunks with imports or forbidden packages", () => {
  assert.deepEqual(
    singleWorkerBundleViolations([
      {
        code: "worker",
        fileName: "assets/shared-database-worker.js",
        type: "chunk",
      },
      {
        code: "dependency",
        fileName: "assets/worker-dependency.js",
        type: "chunk",
      },
    ]),
    [
      "Expected exactly one worker JavaScript bundle, but generated 2: assets/shared-database-worker.js, assets/worker-dependency.js",
    ],
  );
  assert.deepEqual(
    singleWorkerBundleViolations([
      {
        code: "worker",
        fileName: "assets/shared-database-worker.js",
        imports: ["assets/worker-dependency.js"],
        moduleIds: ["/repo/node_modules/katex/dist/katex.mjs"],
        type: "chunk",
      },
    ]),
    [
      "assets/shared-database-worker.js: unexpected JavaScript imports: assets/worker-dependency.js",
      "assets/shared-database-worker.js: forbidden packages reached the bundle: katex",
    ],
  );
  assert.deepEqual(
    singleWorkerBundleViolations([
      {
        code: "worker",
        fileName: "assets/shared-database-worker.js",
        moduleIds: ["/repo/node_modules/@clerk/clerk-js/dist/clerk.no-rhc.mjs"],
        type: "chunk",
      },
    ]),
    [],
  );
});

function clerkDiscoveryFixture(): string {
  return [
    "<!doctype html><html><head>",
    '<style id="app-bootstrap-critical-styles">body { color: black; }</style>',
    '<meta name="okou-clerk-ui-script" content="__OKOU_CLERK_UI_SCRIPT_URL__">',
    '<script id="okou-clerk-core-script" src="https://cdn.example.test/clerk.js" defer></script>',
    '<script data-okou-clerk-bootstrap="">window.__clerkConfigured = true;</script>',
    '<script type="module" src="/src/main.js"></script>',
    "</head><body>",
    '<div id="app-bootstrap-skeleton"></div>',
    "</body></html>",
  ].join("");
}

function assertClerkDiscoveryOrder(htmlSource: string): void {
  const clerkCoreIndex = htmlSource.indexOf('id="okou-clerk-core-script"');
  const clerkBootstrapIndex = htmlSource.indexOf(
    'data-okou-clerk-bootstrap=""',
  );
  const appModuleIndex = htmlSource.indexOf('<script type="module"');
  assert.notEqual(clerkCoreIndex, -1);
  assert.ok(clerkBootstrapIndex > clerkCoreIndex);
  assert.ok(appModuleIndex > clerkBootstrapIndex);
}

function assertApplicationStylesheetPreload(htmlSource: string): void {
  const criticalStyleIndex = htmlSource.indexOf(
    '<style id="app-bootstrap-critical-styles">',
  );
  const stylesheetIndex = htmlSource.indexOf('id="okou-main-stylesheet"');
  const stylesheetLoaderIndex = htmlSource.indexOf(
    'id="okou-main-stylesheet-loader"',
  );
  const clerkCoreIndex = htmlSource.indexOf('id="okou-clerk-core-script"');
  const clerkBootstrapIndex = htmlSource.indexOf(
    'data-okou-clerk-bootstrap=""',
  );
  const headEndIndex = htmlSource.indexOf("</head>");
  const skeletonIndex = htmlSource.indexOf('id="app-bootstrap-skeleton"');
  const appModuleIndex = htmlSource.indexOf('<script type="module"');

  assert.ok(criticalStyleIndex !== -1);
  assert.ok(clerkCoreIndex > criticalStyleIndex);
  assert.ok(clerkBootstrapIndex > clerkCoreIndex);
  assert.ok(appModuleIndex > clerkBootstrapIndex);
  assert.ok(stylesheetIndex > appModuleIndex);
  assert.ok(stylesheetLoaderIndex > stylesheetIndex);
  assert.ok(headEndIndex > stylesheetLoaderIndex);
  assert.ok(skeletonIndex > headEndIndex);
  assert.match(
    htmlSource,
    /<link id="okou-main-stylesheet" rel="preload" as="style"[^>]*>/u,
  );
  assert.equal((htmlSource.match(/<link rel="stylesheet"/gu) ?? []).length, 0);
  assert.doesNotMatch(htmlSource, /\sfetchpriority=/u);
  assert.match(
    htmlSource,
    /window\.__mainStylesheetLoaded = new Promise\(function \(resolve\)/u,
  );
  assert.match(htmlSource, /stylesheet\.rel = "stylesheet"/u);
  assert.match(
    htmlSource,
    /requestAnimationFrame\(function \(\) \{\s*requestAnimationFrame\(function \(\) \{\s*resolve\("loaded"\);/u,
  );
  assert.match(
    htmlSource,
    /"error",\s*function \(\) \{\s*resolve\("failed"\);/u,
  );
}

function assertBuiltPageDiscovery(
  htmlSource: string,
  outputs: readonly { fileName: string }[],
) {
  const uiAsset = outputs.find((item) => {
    return /^assets\/clerk-ui-[^/]+\.js$/u.test(item.fileName);
  });
  assert.ok(uiAsset);
  assert.ok(
    htmlSource.includes(`content="/${uiAsset.fileName}"`),
    "the optional UI asset URL must be available to route-scoped loading",
  );
  assert.ok(!htmlSource.includes("__OKOU_CLERK_UI_SCRIPT_URL__"));
  assert.ok(
    !/<(?:script|link)[^>]*(?:src|href)="[^"]*clerk-ui-/u.test(htmlSource),
    "default routes must not eagerly download Clerk UI",
  );
  assertClerkDiscoveryOrder(htmlSource);
  assert.equal((htmlSource.match(/<script type="module"/gu) ?? []).length, 1);
  assert.equal((htmlSource.match(/rel="modulepreload"/gu) ?? []).length, 2);
  assertApplicationStylesheetPreload(htmlSource);
}

function testCodeSplittingGroups() {
  return [
    {
      name: APPLICATION_LAZY_CHUNK.name,
      test: APPLICATION_LAZY_CHUNK.modulePattern,
    },
    { name: "vendor", test: isVendorModule },
  ];
}

async function writeLazyPackageFixture(root: string): Promise<void> {
  const directory = path.join(
    root,
    "node_modules",
    APPLICATION_LAZY_CHUNK.name,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      exports: "./index.mjs",
      name: APPLICATION_LAZY_CHUNK.name,
    }),
  );
  await writeFile(
    path.join(directory, "index.mjs"),
    'export default { renderToString: () => "math" };',
  );
}

await test("emits the fixed page topology and one external worker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okou-app-bundles-"));
  const sourceDirectory = path.join(root, "src");
  const vendorDirectory = path.join(root, "node_modules", "fixture-vendor");
  const mermaidDirectory = path.join(root, "packages", "mermaid-lite", "dist");

  try {
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(vendorDirectory, { recursive: true });
    await mkdir(mermaidDirectory, { recursive: true });
    await writeLazyPackageFixture(root);
    await writeFile(path.join(root, "index.html"), clerkDiscoveryFixture());
    await writeFile(
      path.join(sourceDirectory, "main.js"),
      'import "./main.css"; import SharedDatabaseWorker from "./shared-database-worker.js?sharedworker"; import localeUrl from "./locale.json?url"; import mermaid from "../packages/mermaid-lite/dist/mermaid.esm.min.mjs"; import vendor from "fixture-vendor"; globalThis.loadKatex = () => import("katex"); new SharedDatabaseWorker({ name: "test" }); console.log(localeUrl, mermaid.value, vendor.value);',
    );
    await writeFile(
      path.join(sourceDirectory, "main.css"),
      "body { color: red; }",
    );
    await writeFile(
      path.join(sourceDirectory, "shared-database-worker.js"),
      'self.addEventListener("connect", () => undefined);',
    );
    await writeFile(
      path.join(sourceDirectory, "locale.json"),
      JSON.stringify({ greeting: "hello" }),
    );
    await writeFile(
      path.join(vendorDirectory, "package.json"),
      JSON.stringify({ exports: "./index.cjs", name: "fixture-vendor" }),
    );
    await writeFile(
      path.join(vendorDirectory, "index.cjs"),
      'module.exports = { value: "vendor-static" };',
    );
    await writeFile(
      path.join(mermaidDirectory, "mermaid.esm.min.mjs"),
      'export default { value: "mermaid-static" };',
    );

    const result = await build({
      configFile: false,
      logLevel: "silent",
      root,
      build: {
        assetsInlineLimit: 0,
        minify: false,
        write: false,
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: testCodeSplittingGroups(),
            },
          },
        },
      },
      plugins: [
        clerkUiAssetPlugin(),
        applicationJavaScriptBundlePlugin(),
        applicationResourcePriorityHtmlPlugin(),
      ],
      worker: {
        plugins: () => {
          return [singleWorkerJavaScriptBundlePlugin()];
        },
      },
    });
    if (Array.isArray(result) || !("output" in result)) {
      assert.fail("Expected one completed Vite build output");
    }
    const javaScriptOutputs = result.output.filter((item) => {
      return item.fileName.endsWith(".js");
    });
    // App entry, vendor, Rolldown runtime, SharedWorker, the lazy chunk group,
    // and the separately built optional Clerk UI asset.
    assert.equal(javaScriptOutputs.length, 6);
    assert.equal(
      javaScriptOutputs.filter((item) => {
        return item.type === "chunk" && item.isEntry;
      }).length,
      1,
    );
    const emittedVendorChunk = javaScriptOutputs.find((item) => {
      return (
        item.type === "chunk" &&
        /^assets\/vendor-[^/]+\.js$/u.test(item.fileName)
      );
    });
    assert.ok(emittedVendorChunk?.type === "chunk");
    assert.ok(
      emittedVendorChunk.moduleIds.some((moduleId) => {
        return moduleId.endsWith(
          "/packages/mermaid-lite/dist/mermaid.esm.min.mjs",
        );
      }),
    );
    assert.ok(
      emittedVendorChunk.moduleIds.every((moduleId) => {
        return !moduleId.endsWith("/src/main.js");
      }),
    );
    for (const pattern of [
      /^assets\/vendor-[^/]+\.js$/u,
      /^assets\/rolldown-runtime-[^/]+\.js$/u,
      /^assets\/shared-database-worker-[^/]+\.js$/u,
      /^assets\/clerk-ui-[^/]+\.js$/u,
    ]) {
      assert.ok(
        javaScriptOutputs.some((item) => {
          return pattern.test(item.fileName);
        }),
        `expected JavaScript output matching ${pattern}`,
      );
    }
    const html = result.output.find((item) => {
      return item.type === "asset" && item.fileName === "index.html";
    });
    assert.ok(html?.type === "asset");
    const htmlSource = String(html.source);
    assertBuiltPageDiscovery(htmlSource, javaScriptOutputs);
    assert.ok(
      result.output.some((item) => {
        return item.type === "asset" && item.fileName.endsWith(".json");
      }),
      "expected locale JSON to remain a separate asset",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("dependency chunks keep lower layers cached and reject graph drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "okou-vendor-graph-"));
  const assignments = Object.fromEntries(
    [1, 2, 3, 4, 5].map((group) => {
      return [`fixture-${group}`, group];
    }),
  );
  async function writePackage(group: number, code: string) {
    const directory = path.join(root, "node_modules", `fixture-${group}`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name: `fixture-${group}`, exports: "./index.mjs" }),
    );
    await writeFile(path.join(directory, "index.mjs"), code);
  }
  async function buildFixture() {
    const vendor = dependencyVendorChunks(assignments);
    const result = await build({
      configFile: false,
      logLevel: "silent",
      root,
      plugins: [vendor.plugin],
      build: {
        write: false,
        rolldownOptions: {
          preserveEntrySignatures: false,
          output: {
            strictExecutionOrder: true,
            codeSplitting: {
              includeDependenciesRecursively: false,
              groups: vendor.groups,
            },
          },
        },
      },
    });
    if (Array.isArray(result) || !("output" in result)) {
      assert.fail("Expected one completed build");
    }
    return new Map(
      result.output
        .filter((output) => {
          return output.type === "chunk";
        })
        .map((chunk) => {
          return [chunk.name, chunk.fileName];
        }),
    );
  }
  try {
    await writeFile(
      path.join(root, "index.html"),
      '<script type="module" src="/main.js"></script>',
    );
    const entry = [1, 2, 3, 4, 5]
      .map((group) => {
        return `import { value as v${group} } from "fixture-${group}"; console.log(v${group}());`;
      })
      .join("\n");
    await writeFile(path.join(root, "main.js"), entry);
    await writePackage(1, "export const value = () => Date.now();");
    await writePackage(
      2,
      'import { value as dep } from "fixture-1"; export const value = () => dep() + 2;',
    );
    await writePackage(
      3,
      'import { value as dep } from "fixture-2"; export const value = () => dep() + 3;',
    );
    await writePackage(
      4,
      'import { value as dep } from "fixture-1"; export const value = () => dep() + 4;',
    );
    await writePackage(5, "export const value = () => Math.random();");
    const before = await buildFixture();
    await writePackage(
      3,
      'import { value as dep } from "fixture-2"; export const value = () => dep() + 30;',
    );
    const after = await buildFixture();
    for (const group of [1, 2, 4, 5]) {
      assert.equal(after.get(`vendor-${group}`), before.get(`vendor-${group}`));
    }
    assert.notEqual(after.get("vendor-3"), before.get("vendor-3"));

    await writePackage(
      1,
      'import { value as dep } from "fixture-3"; export const value = () => dep() + 1;',
    );
    await assert.rejects(buildFixture, /Vendor dependency reverses layers/u);
    await writePackage(1, "export const value = () => Date.now();");
    await writePackage(6, "export const value = () => Math.random();");
    await writeFile(
      path.join(root, "main.js"),
      `${entry}\nimport { value } from "fixture-6"; console.log(value());`,
    );
    await assert.rejects(buildFixture, /Unassigned vendor package: fixture-6/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("counts window-only globals but ignores properties and typeof", () => {
  assert.deepEqual(
    [...domGlobalUsageCounts("export const a = document.title;").entries()],
    [["document", 1]],
  );
  assert.deepEqual(
    [
      ...domGlobalUsageCounts(
        "export const a = globalThis.document ?? scope.window;",
      ).entries(),
    ],
    [],
  );
  assert.deepEqual(
    [
      ...domGlobalUsageCounts(
        'export const a = typeof window === "undefined";',
      ).entries(),
    ],
    [],
  );
  // A local shadow is reported too: the check has no scope analysis, and a
  // module the worker imports has no reason to reuse the name.
  assert.deepEqual(
    [
      ...domGlobalUsageCounts(
        "export function f(x) { const document = x; return document.a; }",
      ).entries(),
    ],
    [["document", 2]],
  );
});

await test("names the offending module and globals", () => {
  const message = workerDomGlobalsMessage(
    "/repo/apps/platform/src/lib/platform-host.ts",
    new Map([["document", 2]]),
  );
  assert.match(message, /platform-host\.ts/u);
  assert.match(message, /document \(2x\)/u);
});
