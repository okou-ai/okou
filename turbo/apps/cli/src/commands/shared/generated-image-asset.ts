import { execFile } from "node:child_process";
import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { getPlatformOrigin } from "../../lib/platform-url";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { downloadWebFile, webFileReferenceId } from "../../lib/api/domains/web";

const executeFile = promisify(execFile);

/** Private images must travel with the authored bundle, never as signed HTML URLs. */
export async function generatedImageAsset(
  result: { readonly url: string; readonly embedUrl?: string },
  assetId: string,
  directory: string,
): Promise<string> {
  const artifact = parseArtifactReference(
    result.url,
    await getPlatformOrigin(),
  );
  if (!artifact && !(await webFileReferenceId(result.url))) {
    return result.embedUrl ?? result.url;
  }
  const assetsDirectory = join(directory, "assets");
  await mkdir(assetsDirectory, { recursive: true });
  const relativePath = `assets/image-${assetId}.webp`;
  const sourcePath = join(assetsDirectory, `image-${assetId}.source`);
  try {
    await downloadWebFile(result.url, sourcePath);
    // Preserve pixel dimensions and transparency while replacing public CDN
    // image resizing with a bundled, optimized WebP. No network input to ffmpeg.
    await executeFile("ffmpeg", [
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      sourcePath,
      "-frames:v",
      "1",
      "-c:v",
      "libwebp",
      "-quality",
      "85",
      "-compression_level",
      "6",
      join(directory, relativePath),
    ]);
    return relativePath;
  } finally {
    await rm(sourcePath, { force: true });
  }
}
