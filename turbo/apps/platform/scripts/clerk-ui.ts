import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build, type Plugin, type ResolvedConfig } from "vite";
import clerkUiPackage from "@clerk/ui/package.json";
import { CLERK_UI_VERSION } from "../src/lib/clerk-versions.ts";

export const CLERK_UI_ASSET_PATTERN = /^assets\/clerk-ui-[^/]+\.js$/u;
const UI_ENTRY = fileURLToPath(new URL("../src/clerk-ui.ts", import.meta.url));
const URL_MARKER = "__OKOU_CLERK_UI_SCRIPT_URL__";
const UI_RAW_SIZE_LIMIT = 5_000_000;

/** Build the optional SDK in its own graph, like the PDF worker. Never let
 * its dependency graph join the eagerly loaded application vendor bundle. */
export function clerkUiAssetPlugin(): Plugin {
  let config: ResolvedConfig;
  let assetFile: string;
  return {
    name: "platform-clerk-ui-asset",
    configResolved(resolved) {
      if (clerkUiPackage.version !== CLERK_UI_VERSION) {
        throw new Error(
          "Installed Clerk UI and browser runtime versions must match",
        );
      }
      config = resolved;
    },
    async buildStart() {
      if (config.command !== "build") {
        return;
      }
      const result = await build({
        configFile: false,
        envFile: false,
        root: config.root,
        publicDir: false,
        logLevel: "warn",
        // The standalone browser UI receives all configuration from core.
        // Do not embed the application's build-time environment in this asset.
        define: {
          "process.env.NODE_ENV": JSON.stringify("production"),
          "import.meta": "{}",
        },
        build: {
          write: false,
          minify: true,
          target: config.build.target,
          lib: { entry: UI_ENTRY, formats: ["iife"], name: "OkouClerkUI" },
          rolldownOptions: { output: { codeSplitting: false } },
        },
      });
      if ("on" in result) {
        throw new Error("Clerk UI build must not watch");
      }
      const outputs = (Array.isArray(result) ? result : [result]).flatMap(
        (output) => {
          return output.output;
        },
      );
      const chunk = outputs[0];
      if (
        outputs.length !== 1 ||
        chunk?.type !== "chunk" ||
        chunk.imports.length !== 0 ||
        // Rolldown retains self-edges for the SDK's inlined lazy modules.
        // No split chunk may escape this build. Clerk's remote security
        // challenge loading remains provider-owned and must not be stripped.
        chunk.dynamicImports.some((file) => {
          return file !== chunk.fileName;
        }) ||
        !chunk.moduleIds.some((id) => {
          return id.includes("/node_modules/@clerk/ui/");
        }) ||
        chunk.moduleIds.some((id) => {
          return id.includes("/node_modules/@clerk/clerk-js/");
        }) ||
        new TextEncoder().encode(chunk.code).byteLength > UI_RAW_SIZE_LIMIT
      ) {
        throw new Error(
          `Clerk UI must be one UI-only bundle without split chunks, under 5 MB: ${JSON.stringify(
            outputs.map((output) => {
              return output.type === "chunk"
                ? {
                    file: output.fileName,
                    bytes: output.code.length,
                    imports: output.imports,
                    dynamicImports: output.dynamicImports,
                  }
                : { file: output.fileName, type: output.type };
            }),
          )}`,
        );
      }
      const hash = createHash("sha256")
        .update(chunk.code)
        .digest("hex")
        .slice(0, 16);
      assetFile = `assets/clerk-ui-${hash}.js`;
      this.emitFile({
        type: "asset",
        fileName: assetFile,
        source: chunk.code,
      });
    },
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const url =
          config.command === "build"
            ? `${config.base}${assetFile}`
            : "/src/clerk-ui.ts";
        return html.replaceAll(URL_MARKER, url);
      },
    },
  };
}
