import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  fetchHostHasBlockedAddress,
  resolveFetchHostAddresses,
  type ResolvedFetchAddress,
} from "../../lib/blocked-fetch-host";
import { SLACK_PREVIEW_IMAGE_MAX_BYTES } from "../../lib/slack-preview-image";
import {
  awaitWithSignal,
  createDeferredPromise,
  settleIncludingAbort,
} from "../utils";

async function publicAddress(url: URL, signal: AbortSignal) {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  const family = isIP(hostname);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    (!family && !hostname.includes("."))
  ) {
    return null;
  }
  const addresses: ResolvedFetchAddress[] = family
    ? [{ address: hostname, family: family === 6 ? 6 : 4 }]
    : await awaitWithSignal(resolveFetchHostAddresses(hostname), signal);
  signal.throwIfAborted();
  return fetchHostHasBlockedAddress(addresses) ? null : (addresses[0] ?? null);
}

async function readImage(
  url: URL,
  signal: AbortSignal,
): Promise<Buffer | null> {
  const address = await publicAddress(url, signal);
  if (!address) {
    return null;
  }
  signal.throwIfAborted();
  const owner = new AbortController();
  const deferred = createDeferredPromise<Buffer | null>(owner.signal);
  const finish = (bytes: Buffer | null) => {
    if (!deferred.settled()) {
      deferred.resolve(bytes);
    }
  };
  const onAbort = () => {
    finish(null);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return (async () => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        agent: false,
        family: address.family,
        lookup: (_hostname, _options, callback) => {
          callback(null, address.address, address.family);
        },
        headers: { Accept: "image/*", "Accept-Encoding": "identity" },
        maxHeaderSize: 16 * 1024,
        signal,
      },
      (response) => {
        response.on("error", () => {
          finish(null);
        });
        response.on("aborted", () => {
          finish(null);
        });
        // Redirects and encoded responses must not bypass the target/byte limits.
        if (
          response.statusCode !== 200 ||
          !response.headers["content-type"]
            ?.toLowerCase()
            .startsWith("image/") ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity") ||
          Number(response.headers["content-length"]) >
            SLACK_PREVIEW_IMAGE_MAX_BYTES
        ) {
          finish(null);
          response.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          if (deferred.settled()) {
            return;
          }
          size += chunk.byteLength;
          if (size > SLACK_PREVIEW_IMAGE_MAX_BYTES) {
            finish(null);
            response.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          finish(Buffer.concat(chunks));
        });
      },
    );
    request.on("error", () => {
      finish(null);
    });
    request.end();
    return await deferred.promise;
  })().finally(() => {
    signal.removeEventListener("abort", onAbort);
    finish(null);
  });
}

/** Anonymous reads pin public DNS results and never follow redirects. */
export async function fetchSlackPreviewImage(url: URL, signal: AbortSignal) {
  const owner = new AbortController();
  const result = await settleIncludingAbort(
    readImage(
      url,
      AbortSignal.any([signal, owner.signal, AbortSignal.timeout(5000)]),
    ),
  ).finally(() => {
    owner.abort();
  });
  signal.throwIfAborted();
  return result.ok ? result.value : null;
}
