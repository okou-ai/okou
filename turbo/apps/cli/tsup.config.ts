import { execSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as {
  version: string;
};

const isWatchMode = process.argv.includes("--watch");
const banner = [
  "#!/usr/bin/env node",
  // Provide CJS require() for bundled CommonJS packages that call
  // require("events"), require("fs"), etc. at runtime.
  'import { createRequire as __createRequire } from "node:module";',
  "const require = __createRequire(import.meta.url);",
].join("\n");

async function buildImageResizeWorker(): Promise<void> {
  const piEntry = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const photonEntry = createRequire(piEntry).resolve(
    "@silvia-odwyer/photon-node",
  );

  await build({
    config: false,
    entry: {
      "image-resize-worker": resolve(
        dirname(piEntry),
        "utils/image-resize-worker.js",
      ),
    },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    splitting: false,
    dts: false,
    sourcemap: true,
    clean: false,
    shims: true,
    removeNodeProtocol: false,
    banner: { js: banner },
    esbuildOptions(options) {
      options.nodePaths = [resolve("node_modules")];
    },
  });

  copyFileSync(
    resolve(dirname(photonEntry), "photon_rs_bg.wasm"),
    resolve("dist/photon_rs_bg.wasm"),
  );
}

export default defineConfig({
  entry: ["src/okou.ts"],
  format: ["esm"],
  // This executable ships no declarations; check-types owns type validation.
  dts: false,
  sourcemap: true,
  clean: true,
  shims: true,
  removeNodeProtocol: false,
  banner: { js: banner },
  // Resolve packages from the CLI's node_modules when bundling workspace deps
  // (e.g. @okouai/core imports zod, which lives in apps/cli/node_modules)
  esbuildOptions(options) {
    options.nodePaths = [resolve("node_modules")];
  },
  // Inject version and default Sentry DSN from package.json/env at build time
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
    __DEFAULT_SENTRY_DSN__: JSON.stringify(
      process.env.DEFAULT_SENTRY_DSN ?? "",
    ),
  },
  onSuccess: async () => {
    await buildImageResizeWorker();

    if (!isWatchMode) {
      return;
    }
    console.log("Uploading Okou CLI for local runners...");
    execSync("pnpm --workspace-root deploy-cli:local", {
      stdio: "inherit",
    });
    console.log("Okou CLI uploaded for local runners");
    console.log("Installing Okou CLI globally...");
    execSync("sudo npm link --local", { cwd: "dist", stdio: "inherit" });
    console.log("Okou CLI installed globally");
  },
});
