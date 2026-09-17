import type { Plugin } from "vite";
import { CLERK_UI_ASSET_PATTERN } from "./clerk-ui.ts";

export const RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES = 8_500_000;

const SHARED_DATABASE_WORKER_FILE_PATTERN =
  /^assets\/shared-database-worker-[^/]+\.js$/u;
const VENDOR_FILE_PATTERN = /^assets\/vendor-[^/]+\.js$/u;
const ROLLDOWN_RUNTIME_FILE_PATTERN = /^assets\/rolldown-runtime-[^/]+\.js$/u;

const MERMAID_LITE_MODULE_PATH =
  "/packages/mermaid-lite/dist/mermaid.esm.min.mjs";

export const APPLICATION_LAZY_CHUNK = {
  modulePattern: /[\\/]node_modules[\\/]katex[\\/]/u,
  name: "katex",
} as const;

const VENDOR_MODULE_PATTERN =
  /(?:[\\/]node_modules[\\/]|[\\/]packages[\\/]mermaid-lite[\\/]dist[\\/]mermaid\.esm\.min\.mjs$)/u;

export function isVendorModule(moduleId: string): boolean {
  return (
    VENDOR_MODULE_PATTERN.test(moduleId) &&
    !APPLICATION_LAZY_CHUNK.modulePattern.test(moduleId)
  );
}

const FORBIDDEN_BUNDLED_PACKAGES = [
  "@base-org",
  "@clerk/clerk-js",
  "@clerk/ui",
  "@coinbase",
  "@solana",
  "@wallet-standard",
  APPLICATION_LAZY_CHUNK.name,
  "rehype-katex",
  "remark-math",
  "tr46",
] as const;

const FORBIDDEN_PRISM_MODULES = [
  {
    modulePath: "/node_modules/rehype-prism-plus/dist/index.es.js",
    name: "rehype-prism-plus (root entry)",
  },
  {
    modulePath: "/node_modules/rehype-prism-plus/dist/all.es.js",
    name: "rehype-prism-plus/all",
  },
  {
    modulePath: "/node_modules/rehype-prism-plus/dist/generator.es.js",
    name: "rehype-prism-plus/generator",
  },
  {
    modulePath: "/node_modules/refractor/lib/all.js",
    name: "refractor/all",
  },
] as const;

const FORBIDDEN_SERVER_CONTRACT_MODULES = [
  "/packages/api-contracts/src/contracts/runners.ts",
  "/packages/api-contracts/src/contracts/webhooks.ts",
] as const;

interface GeneratedChunk {
  readonly code: string;
  readonly dynamicImports?: readonly string[];
  readonly fileName: string;
  readonly imports?: readonly string[];
  readonly isEntry?: boolean;
  readonly moduleIds?: readonly string[];
  readonly type: "chunk";
}

interface GeneratedAsset {
  readonly fileName: string;
  readonly source: string | Uint8Array;
  readonly type: "asset";
}

type GeneratedOutput = GeneratedAsset | GeneratedChunk;

function normalizeModuleId(moduleId: string): string {
  return moduleId.replaceAll("\\", "/");
}

function isNodeModule(moduleId: string): boolean {
  return normalizeModuleId(moduleId).includes("/node_modules/");
}

function isMermaidLiteModule(moduleId: string): boolean {
  return normalizeModuleId(moduleId).endsWith(MERMAID_LITE_MODULE_PATH);
}

function isVirtualModule(moduleId: string): boolean {
  return moduleId.startsWith("\0");
}

function bundledPackage(moduleId: string): string | undefined {
  const normalized = normalizeModuleId(moduleId);
  return FORBIDDEN_BUNDLED_PACKAGES.find((packageName) => {
    return normalized.includes(`/node_modules/${packageName}/`);
  });
}

function forbiddenPrismModule(moduleId: string): string | undefined {
  const normalized = normalizeModuleId(moduleId);
  return FORBIDDEN_PRISM_MODULES.find(({ modulePath }) => {
    return normalized.includes(modulePath);
  })?.name;
}

function forbiddenServerContractModule(moduleId: string): string | undefined {
  const normalized = normalizeModuleId(moduleId);
  return FORBIDDEN_SERVER_CONTRACT_MODULES.find((modulePath) => {
    return normalized.endsWith(modulePath);
  });
}

function generatedChunks(
  outputs: readonly GeneratedOutput[],
): GeneratedChunk[] {
  return outputs.filter((output): output is GeneratedChunk => {
    return output.type === "chunk";
  });
}

function rawJavaScriptBytes(outputs: readonly GeneratedOutput[]): number {
  const encoder = new TextEncoder();
  return outputs.reduce((total, output) => {
    const source = output.type === "chunk" ? output.code : output.source;
    return (
      total +
      (typeof source === "string"
        ? encoder.encode(source).byteLength
        : source.byteLength)
    );
  }, 0);
}

function isLazyApplicationChunk(chunk: GeneratedChunk): boolean {
  return (
    chunk.isEntry !== true &&
    !VENDOR_FILE_PATTERN.test(chunk.fileName) &&
    !ROLLDOWN_RUNTIME_FILE_PATTERN.test(chunk.fileName)
  );
}

function outputDescription(outputs: readonly GeneratedOutput[]): string {
  if (outputs.length === 0) {
    return "none";
  }
  return outputs
    .map((output) => {
      return `${output.fileName} (${output.type})`;
    })
    .join(", ");
}

function chunkViolations(
  chunk: GeneratedChunk,
  allowedStaticImports: ReadonlySet<string>,
  allowedBundledPackages: ReadonlySet<string> = new Set(),
  allowedDynamicImports: ReadonlySet<string> = new Set(),
): string[] {
  const violations: string[] = [];
  const unexpectedImports = (chunk.imports ?? []).filter((fileName) => {
    return !allowedStaticImports.has(fileName);
  });
  if (unexpectedImports.length > 0) {
    violations.push(
      `${chunk.fileName}: unexpected JavaScript imports: ${unexpectedImports.join(", ")}`,
    );
  }
  const unexpectedDynamicImports = (chunk.dynamicImports ?? []).filter(
    (fileName) => {
      return !allowedDynamicImports.has(fileName);
    },
  );
  if (unexpectedDynamicImports.length > 0) {
    violations.push(
      `${chunk.fileName}: unexpected dynamic JavaScript imports: ${unexpectedDynamicImports.join(", ")}`,
    );
  }

  const forbiddenPackages = new Set(
    (chunk.moduleIds ?? [])
      .map(bundledPackage)
      .filter((packageName): packageName is string => {
        return (
          packageName !== undefined && !allowedBundledPackages.has(packageName)
        );
      }),
  );
  if (forbiddenPackages.size > 0) {
    violations.push(
      `${chunk.fileName}: forbidden packages reached the bundle: ${[...forbiddenPackages].join(", ")}`,
    );
  }
  const forbiddenPrismModules = new Set(
    (chunk.moduleIds ?? [])
      .map(forbiddenPrismModule)
      .filter((moduleName): moduleName is string => {
        return moduleName !== undefined;
      }),
  );
  if (forbiddenPrismModules.size > 0) {
    violations.push(
      `${chunk.fileName}: forbidden non-common Prism modules reached the bundle: ${[...forbiddenPrismModules].join(", ")}`,
    );
  }
  const forbiddenServerContractModules = new Set(
    (chunk.moduleIds ?? [])
      .map(forbiddenServerContractModule)
      .filter((modulePath): modulePath is string => {
        return modulePath !== undefined;
      }),
  );
  if (forbiddenServerContractModules.size > 0) {
    violations.push(
      `${chunk.fileName}: server-only API contract modules reached the eager platform graph: ${[...forbiddenServerContractModules].join(", ")}`,
    );
  }
  return violations;
}

function mermaidLiteVendorViolations(
  appChunk: GeneratedChunk,
  vendorChunks: readonly GeneratedChunk[],
  runtimeChunk: GeneratedChunk,
): string[] {
  const violations: string[] = [];
  const mermaidLiteModules = vendorChunks.flatMap((chunk) => {
    return (chunk.moduleIds ?? []).filter(isMermaidLiteModule);
  });
  if (mermaidLiteModules.length !== 1) {
    violations.push(
      `Vendor chunks: expected exactly one ${MERMAID_LITE_MODULE_PATH} module, found ${mermaidLiteModules.length}`,
    );
  }
  for (const vendorChunk of vendorChunks) {
    if (!(vendorChunk.moduleIds ?? []).some(isVendorModule)) {
      violations.push(
        `${vendorChunk.fileName}: vendor chunk has no vendor modules`,
      );
    }
    const unrelatedVendorModules = (vendorChunk.moduleIds ?? []).filter(
      (moduleId) => {
        return (
          !isNodeModule(moduleId) &&
          !isMermaidLiteModule(moduleId) &&
          !isVirtualModule(moduleId)
        );
      },
    );
    if (unrelatedVendorModules.length > 0) {
      violations.push(
        `${vendorChunk.fileName}: only node_modules and ${MERMAID_LITE_MODULE_PATH} may be emitted in the vendor chunk: ${unrelatedVendorModules.join(", ")}`,
      );
    }
  }
  for (const chunk of [appChunk, runtimeChunk]) {
    const misplacedMermaidLiteModules = (chunk.moduleIds ?? []).filter(
      isMermaidLiteModule,
    );
    if (misplacedMermaidLiteModules.length > 0) {
      violations.push(
        `${chunk.fileName}: ${MERMAID_LITE_MODULE_PATH} must be emitted only in the vendor chunk: ${misplacedMermaidLiteModules.join(", ")}`,
      );
    }
  }
  return violations;
}

export function applicationBundleViolations(
  outputs: readonly GeneratedOutput[],
  vendorChunkCount = 1,
): string[] {
  const uiAssets = outputs.filter((output) => {
    return (
      output.type === "asset" && CLERK_UI_ASSET_PATTERN.test(output.fileName)
    );
  });
  if (uiAssets.length !== 1) {
    return ["Expected exactly one separately built Clerk UI asset"];
  }
  const javaScriptOutputs = outputs.filter((output) => {
    return output.fileName.endsWith(".js") && !uiAssets.includes(output);
  });
  return eagerApplicationBundleViolations(javaScriptOutputs, vendorChunkCount);
}

function eagerApplicationBundleViolations(
  javaScriptOutputs: readonly GeneratedOutput[],
  vendorChunkCount: number,
): string[] {
  const applicationChunks = generatedChunks(javaScriptOutputs);
  const workerAssets = javaScriptOutputs.filter(
    (output): output is GeneratedAsset => {
      return (
        output.type === "asset" &&
        SHARED_DATABASE_WORKER_FILE_PATTERN.test(output.fileName)
      );
    },
  );
  const vendorChunks = applicationChunks.filter((chunk) => {
    return chunk.isEntry !== true && VENDOR_FILE_PATTERN.test(chunk.fileName);
  });
  const runtimeChunks = applicationChunks.filter((chunk) => {
    return (
      chunk.isEntry !== true &&
      ROLLDOWN_RUNTIME_FILE_PATTERN.test(chunk.fileName)
    );
  });
  const appChunks = applicationChunks.filter((chunk) => {
    return chunk.isEntry === true;
  });
  const lazyChunks = applicationChunks.filter(isLazyApplicationChunk);
  const appChunk = appChunks[0];
  const vendorChunk = vendorChunks[0];
  const lazyChunk = lazyChunks[0];
  const runtimeChunk = runtimeChunks[0];
  const workerAsset = workerAssets[0];
  const invalidLayout = [
    javaScriptOutputs.length !== vendorChunkCount + 4,
    appChunks.length !== 1,
    vendorChunks.length !== vendorChunkCount,
    lazyChunks.length !== 1,
    runtimeChunks.length !== 1,
    workerAssets.length !== 1,
  ].some(Boolean);
  if (
    invalidLayout ||
    !appChunk ||
    !vendorChunk ||
    !lazyChunk ||
    !runtimeChunk ||
    !workerAsset
  ) {
    return [
      `Expected exactly one app entry, one lazy chunk, ${vendorChunkCount} vendor chunk(s), one Rolldown runtime chunk, and one shared database worker asset, but generated: ${outputDescription(javaScriptOutputs)}`,
    ];
  }

  const allowedEagerStaticImports = new Set(
    [appChunk, ...vendorChunks, runtimeChunk].map((chunk) => {
      return chunk.fileName;
    }),
  );
  const violations = [
    ...chunkViolations(
      appChunk,
      allowedEagerStaticImports,
      new Set(),
      new Set([lazyChunk.fileName]),
    ),
    ...vendorChunks.flatMap((chunk) => {
      return chunkViolations(
        chunk,
        new Set(
          [runtimeChunk, ...vendorChunks].map((item) => {
            return item.fileName;
          }),
        ),
      );
    }),
    ...chunkViolations(runtimeChunk, new Set()),
    ...chunkViolations(
      lazyChunk,
      allowedEagerStaticImports,
      new Set([APPLICATION_LAZY_CHUNK.name]),
    ),
  ];
  if (
    appChunk.dynamicImports?.length !== 1 ||
    appChunk.dynamicImports[0] !== lazyChunk.fileName
  ) {
    violations.push(
      `${appChunk.fileName}: expected exactly one dynamic import (${lazyChunk.fileName})`,
    );
  }
  const unrelatedLazyModules = (lazyChunk.moduleIds ?? []).filter(
    (moduleId) => {
      return (
        !APPLICATION_LAZY_CHUNK.modulePattern.test(moduleId) &&
        !isVirtualModule(moduleId)
      );
    },
  );
  if (unrelatedLazyModules.length > 0) {
    violations.push(
      `${lazyChunk.fileName}: unexpected modules in the configured lazy chunk: ${unrelatedLazyModules.join(", ")}`,
    );
  }
  for (const chunk of [appChunk, runtimeChunk]) {
    const misplacedNodeModules = (chunk.moduleIds ?? []).filter(isNodeModule);
    if (misplacedNodeModules.length > 0) {
      violations.push(
        `${chunk.fileName}: third-party modules must be emitted only in the vendor chunk: ${misplacedNodeModules.join(", ")}`,
      );
    }
  }
  violations.push(
    ...mermaidLiteVendorViolations(appChunk, vendorChunks, runtimeChunk),
  );

  const rawBytes = rawJavaScriptBytes(javaScriptOutputs);
  if (rawBytes > RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES) {
    violations.push(
      `JavaScript output: ${rawBytes} raw bytes exceeds ${RAW_JAVASCRIPT_OUTPUT_LIMIT_BYTES}`,
    );
  }
  return violations;
}

export function singleWorkerBundleViolations(
  chunks: readonly GeneratedChunk[],
): string[] {
  const chunk = chunks[0];
  if (chunks.length !== 1 || !chunk) {
    return [
      `Expected exactly one worker JavaScript bundle, but generated ${chunks.length}: ${chunks
        .map((chunk) => {
          return chunk.fileName;
        })
        .join(", ")}`,
    ];
  }
  return chunkViolations(chunk, new Set(), new Set(["@clerk/clerk-js"]));
}

export function applicationJavaScriptBundlePlugin(
  vendorChunkCount = 1,
): Plugin {
  return {
    apply: "build",
    enforce: "post",
    name: "platform-application-javascript-bundles",
    generateBundle(_options, bundle) {
      const violations = applicationBundleViolations(
        Object.values(bundle),
        vendorChunkCount,
      );
      if (violations.length > 0) {
        this.error(violations.join("\n"));
      }
    },
  };
}

export function singleWorkerJavaScriptBundlePlugin(): Plugin {
  return {
    apply: "build",
    enforce: "post",
    name: "platform-single-worker-javascript-bundle",
    generateBundle(_options, bundle) {
      const violations = singleWorkerBundleViolations(
        generatedChunks(Object.values(bundle)),
      );
      if (violations.length > 0) {
        this.error(violations.join("\n"));
      }
    },
  };
}
