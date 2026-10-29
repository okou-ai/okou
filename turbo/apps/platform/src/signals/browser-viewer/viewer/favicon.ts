import type { CdpClient } from "../cdp/client.ts";
import { isRecord } from "../cdp/errors.ts";
import { releaseRuntimeObjects } from "../cdp/runtime-objects.ts";

// Keep both the serialized reply and retained URL small, including inline icons.
const maxUrlLength = 8192;
const expression = `/* okou-browser favicon */ (() => {
  if (document.readyState === 'loading') return false;
  const link = document.querySelector('link[rel~="icon" i]');
  if (!link?.getAttribute('href')?.trim()) return null;
  const url = link.href;
  return typeof url === 'string' && url.length <= ${String(maxUrlLength)} ? url : null;
})()`;

/** undefined means the document is still parsing; wait for its existing Page event. */
export async function readFavicon(
  client: CdpClient,
  sessionId: string,
): Promise<string | null | undefined> {
  const release = (result: unknown) => {
    return releaseRuntimeObjects(client, sessionId, result);
  };
  const result = await client.request(
    "Runtime.evaluate",
    { expression, returnByValue: true, timeout: 1000 },
    sessionId,
    release,
  );
  release(result);
  const value: unknown = isRecord(result.result) ? result.result.value : null;
  if (value === false) {
    return undefined;
  }
  if (typeof value !== "string" || value.length > maxUrlLength) {
    return null;
  }
  if (!URL.canParse(value)) {
    return null;
  }
  const url = new URL(value);
  const href = url.href;
  if (href.length > maxUrlLength) {
    return null;
  }
  return url.protocol === "https:" ||
    url.protocol === "http:" ||
    (url.protocol === "data:" && value.startsWith("data:image/"))
    ? href
    : null;
}
