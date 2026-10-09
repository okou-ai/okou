import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import {
  hostedSitePreviewSchema,
  MAX_HOSTED_PREVIEW_BYTES,
} from "@okouai/api-contracts/contracts/host";

export function bundleFingerprint(
  files: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly absolutePath?: string;
  }[],
): string {
  // Synthetic robots.txt is a publisher default, not authored bundle content.
  const entries = files
    .filter((file) => {
      return file.absolutePath !== undefined;
    })
    .map((file) => {
      return [file.path, file.sha256] as const;
    })
    .sort(([left], [right]) => {
      return left.localeCompare(right);
    });
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

async function resolvePreviewPath(path: string): Promise<string> {
  try {
    // A dangling symlink exists: realpath below must reject it, not treat it as new output.
    await lstat(path);
  } catch (error) {
    const parent = dirname(path);
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT") ||
      parent === path
    ) {
      throw error;
    }
    // Capture may create the output file and several parent directories later.
    return join(await resolvePreviewPath(parent), basename(path));
  }
  return realpath(path);
}

export async function assertPreviewOutsideSite(
  root: string,
  imagePath: string,
): Promise<void> {
  const [realRoot, realImage] = await Promise.all([
    realpath(resolve(root)),
    resolvePreviewPath(imagePath),
  ]);
  for (const path of [
    relative(resolve(root), resolve(imagePath)),
    relative(realRoot, realImage),
  ]) {
    if (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) {
      throw new Error(
        "Keep the preview outside the hosted directory so its image and receipt are not published as public site assets",
      );
    }
  }
}

export async function readHostedPreview(
  path: string,
  fingerprint: string,
  siteRoot: string,
) {
  await assertPreviewOutsideSite(siteRoot, path);
  const size = (await stat(path)).size;
  if (size <= 0 || size > MAX_HOSTED_PREVIEW_BYTES) {
    throw new Error("Preview must be a PNG or JPEG of at most 5 MiB");
  }
  const extension = extname(path).toLowerCase();
  if (![".png", ".jpg", ".jpeg"].includes(extension)) {
    throw new Error("Preview must be a PNG or JPEG file");
  }
  const bytes = await readFile(path);
  const metadata = hostedSitePreviewSchema.parse({
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType: extension === ".png" ? "image/png" : "image/jpeg",
  });
  let receipt: string | undefined;
  try {
    receipt = await readFile(`${path}.okou-preview.json`, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    // User-selected cover images have no screenshot receipt.
  }
  if (receipt !== undefined) {
    const recorded = z
      .object({
        version: z.literal(1),
        bundleSha256: z.string(),
        imageSha256: z.string(),
      })
      .parse(JSON.parse(receipt));
    if (
      recorded.bundleSha256 !== fingerprint ||
      recorded.imageSha256 !== metadata.sha256
    ) {
      throw new Error(
        "The site or preview changed after capture. Run okou host screenshot again before publishing",
      );
    }
  }
  return { bytes, metadata };
}
