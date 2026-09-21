import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { getPlatformOrigin } from "./platform-url";

export async function assertPrivateArtifactUrl(url: string): Promise<void> {
  if (!parseArtifactReference(url, await getPlatformOrigin())) {
    throw new Error(
      "The API did not return a private artifact. --visibility requires privateArtifacts and an API that supports private creation.",
    );
  }
}

/** Qualify hostless references stored by earlier CLI batch files; complete URLs pass through. */
export async function absoluteArtifactUrl(url: string): Promise<string> {
  if (!parseArtifactReference(url)) {
    return url;
  }
  return new URL(url, await getPlatformOrigin()).href;
}
