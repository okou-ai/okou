import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

export const DOWNLOAD_WORKER_ASSET_PATTERN =
  /^assets\/sandbox-file-download-v1-[a-f0-9]{64}\.js$/u;

/** Keep the browser-resident script immutable and available to old App pages. */
export function sandboxFileDownloadWorkerAsset() {
  const source = readFileSync(
    new URL("../public/sandbox-file-download-v1-sw.js", import.meta.url),
  );
  const digest = createHash("sha256").update(source).digest("hex");
  const fileName = `assets/sandbox-file-download-v1-${digest}.js`;
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
