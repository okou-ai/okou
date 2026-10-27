import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build, type Plugin, type ResolvedConfig } from "vite";

export const WORD_PREVIEW_ASSET_PATTERN = /^assets\/word-preview-[^/]+\.js$/u;
// The renderer and ZIP reader are optional. Keep their own cap while the
// existing eager application byte limit remains unchanged.
export const WORD_PREVIEW_LIMIT_BYTES = 260_000;
const ENTRY = fileURLToPath(new URL("../src/word-preview.ts", import.meta.url));

export function wordPreviewAssetPlugin(): Plugin {
  let config: ResolvedConfig;
  let assetFile: string;
  return {
    name: "platform-word-preview-asset",
    configResolved(resolved) {
      config = resolved;
    },
    async buildStart() {
      if (config.command !== "build") {
        return;
      }
      const result = await build({
        configFile: false,
        envDir: false,
        root: config.root,
        publicDir: false,
        logLevel: "warn",
        build: {
          write: false,
          minify: true,
          target: config.build.target,
          lib: { entry: ENTRY, formats: ["iife"], name: "OkouWordPreview" },
          rolldownOptions: { output: { codeSplitting: false } },
        },
      });
      if ("on" in result) {
        throw new Error("Word preview build must not watch");
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
        chunk.dynamicImports.length !== 0 ||
        !chunk.moduleIds.some((id) => {
          return id.includes("/node_modules/docx-preview/");
        }) ||
        chunk.moduleIds.some((id) => {
          return /\/node_modules\/(?:react|@clerk|ccstate)\//u.test(id);
        }) ||
        new TextEncoder().encode(chunk.code).byteLength >
          WORD_PREVIEW_LIMIT_BYTES
      ) {
        throw new Error(
          "Word preview must be one self-contained optional renderer under 260 KB",
        );
      }
      const hash = createHash("sha256")
        .update(chunk.code)
        .digest("hex")
        .slice(0, 16);
      assetFile = `assets/word-preview-${hash}.js`;
      this.emitFile({ type: "asset", fileName: assetFile, source: chunk.code });
    },
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: {
            name: "okou-word-preview-script",
            content:
              config.command === "build"
                ? `${config.base}${assetFile}`
                : "/src/word-preview.ts",
          },
          injectTo: "head",
        },
      ];
    },
  };
}
