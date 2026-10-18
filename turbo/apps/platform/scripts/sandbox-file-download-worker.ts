import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Plugin } from "vite";

export const DOWNLOAD_WORKER_ASSET_PATTERN =
  /^assets\/sandbox-file-download-[a-f0-9]{64}\.js$/u;

/** Keep the browser-resident script immutable and available to old App pages. */
export async function sandboxFileDownloadWorkerAsset() {
  const root = await mkdtemp(path.join(tmpdir(), "okou-download-worker-"));
  let source: Buffer;
  try {
    const script = path.join(root, "worker.js");
    await writeFile(
      script,
      await readFile(
        new URL("../public/sandbox-file-download-sw.js", import.meta.url),
      ),
    );
    // Finalize the same debug-ID transformation used by publication before
    // hashing. The canonical whole-App injection leaves tagged bytes intact.
    await promisify(execFile)(
      "pnpm",
      ["exec", "sentry-cli", "sourcemaps", "inject", script],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        timeout: 10_000,
      },
    );
    source = await readFile(script);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const digest = createHash("sha256").update(source).digest("hex");
  const fileName = `assets/sandbox-file-download-${digest}.js`;
  return {
    path: `/okou-app/${fileName}`,
    plugin: {
      apply: "build",
      name: "platform-sandbox-file-download-worker",
      generateBundle() {
        this.emitFile({ type: "asset", fileName, source });
      },
    } satisfies Plugin,
  };
}
