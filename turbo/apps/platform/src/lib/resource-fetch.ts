import { createDeferredPromise } from "../signals/utils.ts";

/**
 * Read public assets and transfer presigned objects without application auth.
 * API requests belong to apiClient$, which owns auth and response contracts.
 */
export function fetchResource(
  url: string | URL,
  options: Omit<RequestInit, "credentials" | "signal">,
  signal?: AbortSignal,
): Promise<Response> {
  signal?.throwIfAborted();
  return fetch(url, { ...options, credentials: "omit", signal });
}

/** Transfer a presigned object with native upload progress and no app credentials. */
export async function uploadResource(
  url: string | URL,
  body: Blob,
  headers: Readonly<Record<string, string>>,
  onProgress: ((bytes: number) => void) | undefined,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const target = new URL(url, location.href);
  // XHR cannot omit same-origin cookies, so presigned uploads must be external.
  if (
    target.origin === location.origin ||
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password
  ) {
    throw new TypeError("Presigned uploads require an external HTTP URL");
  }
  const request = new XMLHttpRequest();
  const progress = (event: ProgressEvent) => {
    if (!signal.aborted) {
      onProgress?.(Math.min(body.size, event.loaded));
    }
  };
  request.upload.addEventListener("progress", progress);
  request.open("PUT", target.href);
  request.withCredentials = false;
  for (const [name, value] of Object.entries(headers)) {
    request.setRequestHeader(name, value);
  }
  const completion = createDeferredPromise<number>(
    { rejection: "owner" },
    signal,
  );
  const loaded = () => {
    if (!completion.settled()) {
      completion.resolve(request.status);
    }
  };
  const failed = () => {
    if (!completion.settled()) {
      completion.reject(new TypeError("Storage upload failed"));
    }
  };
  const aborted = () => {
    if (!completion.settled()) {
      completion.reject(new DOMException("Upload cancelled", "AbortError"));
    }
  };
  const cancel = () => {
    request.abort();
  };
  request.addEventListener("load", loaded);
  request.addEventListener("error", failed);
  request.addEventListener("timeout", failed);
  request.addEventListener("abort", aborted);
  signal.addEventListener("abort", cancel, { once: true });
  const send = async () => {
    request.send(body);
    return await completion.promise;
  };
  const [result] = await Promise.allSettled([send()]);
  request.removeEventListener("load", loaded);
  request.removeEventListener("error", failed);
  request.removeEventListener("timeout", failed);
  request.removeEventListener("abort", aborted);
  request.upload.removeEventListener("progress", progress);
  signal.removeEventListener("abort", cancel);
  if (result.status === "rejected") {
    if (!completion.settled()) {
      completion.reject(result.reason);
    }
    request.abort();
    throw result.reason;
  }
  signal.throwIfAborted();
  return result.value;
}
