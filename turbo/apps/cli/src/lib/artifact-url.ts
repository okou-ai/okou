import { parseArtifactReference } from "@okouai/api-contracts/contracts/artifact-references";
import { getPlatformOrigin } from "./platform-url";

/** Keep durable references usable outside an app page, including CI output. */
export async function absoluteArtifactUrl(url: string): Promise<string> {
  if (!parseArtifactReference(url)) {
    return url;
  }
  return new URL(url, await getPlatformOrigin()).href;
}

export async function withAbsoluteArtifactUrl<
  T extends { readonly url?: string },
>(result: T): Promise<T> {
  return result.url === undefined
    ? result
    : { ...result, url: await absoluteArtifactUrl(result.url) };
}
