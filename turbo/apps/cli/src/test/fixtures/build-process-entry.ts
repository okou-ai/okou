import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

/** Run real CLI processes from compiled source, as the shipped executable does. */
export async function buildProcessEntry(source: string) {
  const nodeModules = fileURLToPath(
    new URL("../../../node_modules/", import.meta.url),
  );
  const directory = await mkdtemp(join(nodeModules, ".process-entry-"));
  const dispose = () => {
    return rm(directory, { recursive: true, force: true });
  };
  try {
    const manifest = JSON.parse(
      await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as {
      devDependencies: Record<string, string>;
    };
    await build({
      config: false,
      entry: { okou: source },
      outDir: directory,
      platform: "node",
      target: "node22",
      format: ["esm"],
      outExtension: () => {
        return { js: ".js" };
      },
      splitting: source.endsWith("/okou.ts"),
      dts: false,
      sourcemap: false,
      silent: true,
      shims: true,
      removeNodeProtocol: false,
      noExternal: [/^@okouai\//u],
      external: Object.keys(manifest.devDependencies).filter((dependency) => {
        return !dependency.startsWith("@okouai/");
      }),
      define: {
        __CLI_VERSION__: JSON.stringify("0.0.0-test"),
        __DEFAULT_SENTRY_DSN__: JSON.stringify(""),
      },
      banner: {
        js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
      },
      esbuildOptions(options) {
        options.nodePaths = [nodeModules];
      },
    });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    return { entry: join(directory, "okou.js"), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** A timed-out setup may still be building when the suite starts teardown. */
export async function disposePreparedProcessEntry(
  preparation: ReturnType<typeof buildProcessEntry> | undefined,
): Promise<void> {
  if (!preparation) {
    return;
  }
  const [prepared] = await Promise.allSettled([preparation]);
  // Failed builds clean their directory and are already reported by beforeAll.
  if (prepared.status === "fulfilled") {
    await prepared.value.dispose();
  }
}
