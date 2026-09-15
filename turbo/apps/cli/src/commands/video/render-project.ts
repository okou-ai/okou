import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ZipWriter,
  Uint8ArrayWriter,
  Uint8ArrayReader,
} from "@zip.js/zip.js/index-native.js";
import ignore from "ignore";
import {
  MAX_INTRO_VIDEO_PROJECT_BYTES,
  introVideoCompositionSchema,
} from "@okouai/api-contracts/contracts/intro-video-render";

/** Package source assets only; this path never resolves HeyGen credentials. */
export async function packageRenderProject(
  projectPath: string,
  composition: string,
) {
  const root = resolve(projectPath);
  const entry = introVideoCompositionSchema.parse(composition);
  if (!lstatSync(root).isDirectory())
    throw new Error("Use a HyperFrames project directory");
  const ignored = ignore().add([
    "**/.*",
    "**/node_modules/",
    "/renders/",
    "/snapshots/",
    "/dist/",
    "/coverage/",
  ]);
  const ignorePath = join(root, ".hyperframesignore");
  if (readdirSync(root).includes(".hyperframesignore"))
    ignored.add(readFileSync(ignorePath, "utf8"));
  const zip = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
    useCompressionStream: true,
  });
  const digest = createHash("sha256");
  let fileCount = 0;
  let sourceBytes = 0;
  let html: string | undefined;
  const largestFiles: { path: string; size: number }[] = [];
  async function visit(relative: string): Promise<void> {
    for (const name of readdirSync(join(root, relative)).sort()) {
      if (name === ".env" || name.startsWith(".env.")) continue;
      const path = relative ? `${relative}/${name}` : name;
      if (path.includes("\\") || path.includes(":"))
        throw new Error(`Unsupported project path: ${path}`);
      const stat = lstatSync(join(root, path));
      if (
        ignored.ignores(path) ||
        (stat.isDirectory() && ignored.ignores(`${path}/`))
      )
        continue;
      if (stat.isSymbolicLink())
        throw new Error(`Project symlinks are not supported: ${path}`);
      if (stat.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Unsupported project entry: ${path}`);
      fileCount += 1;
      sourceBytes += stat.size;
      if (fileCount > 10_000 || sourceBytes > 1024 * 1024 * 1024)
        throw new Error(
          "Project exceeds 10,000 files or 1 GiB of source assets",
        );
      const bytes = readFileSync(join(root, path));
      digest
        .update(path)
        .update("\0")
        .update(String(bytes.length))
        .update("\0")
        .update(bytes);
      await zip.add(path, new Uint8ArrayReader(bytes));
      if (path === entry) {
        if (bytes.length > 1024 * 1024)
          throw new Error("Project HTML entry exceeds 1 MiB");
        html = bytes.toString("utf8");
      }
      largestFiles.push({ path, size: bytes.length });
    }
  }
  await visit("");
  if (!html?.trim())
    throw new Error(
      `The packaged project is missing ${entry}; check .hyperframesignore`,
    );
  const bytes = Buffer.from(await zip.close());
  if (bytes.length > MAX_INTRO_VIDEO_PROJECT_BYTES)
    throw new Error(
      "Project ZIP exceeds 200 MiB. Remove unused generated outputs with .hyperframesignore.",
    );
  const width = Number(/data-width\s*=\s*["']([0-9]+)["']/i.exec(html)?.[1]);
  const height = Number(/data-height\s*=\s*["']([0-9]+)["']/i.exec(html)?.[1]);
  const ratio = width / height;
  const aspectRatio =
    Math.abs(ratio - 16 / 9) < 0.01
      ? ("16:9" as const)
      : Math.abs(ratio - 9 / 16) < 0.01
        ? ("9:16" as const)
        : null;
  if (!aspectRatio)
    throw new Error(
      "Declare a 16:9 or 9:16 composition with data-width and data-height; the renderer will not crop the presentation",
    );
  return {
    bytes,
    digest: digest.digest("hex"),
    fileCount,
    sourceBytes,
    aspectRatio,
    largestFiles: largestFiles
      .sort((a, b) => {
        return b.size - a.size;
      })
      .slice(0, 10),
  };
}
