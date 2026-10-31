import { derivePlatformServiceOrigin } from "@okouai/core/platform-service-origin";
import { i18n } from "../../i18n/index.ts";
import { createDeferredPromise } from "../utils.ts";

/** Only the matching first-party Marketing site can supply browser-local files. */
export function landingFileSource(
  source: string,
  appOrigin: string,
): URL | null {
  if (!URL.canParse(source)) {
    return null;
  }
  const url = new URL(source);
  const app = new URL(appOrigin);
  const expected = new URL(derivePlatformServiceOrigin(appOrigin, "www"));
  const preview =
    /^(?:staging|pr-[0-9]+)-app\.omby\.ai$/u.test(app.hostname) &&
    /^(?:staging|pr-[0-9]+)-www\.omby\.ai$/u.test(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.protocol !== expected.protocol ||
    url.port !== expected.port ||
    (url.origin !== expected.origin && !preview)
  ) {
    return null;
  }
  return url;
}

export async function readLandingFiles(
  source: URL,
  id: string,
  signal: AbortSignal,
): Promise<File[]> {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(id)) {
    throw new Error("Invalid landing file draft");
  }
  const transferSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  transferSignal.throwIfAborted();
  const result = createDeferredPromise<File[]>(transferSignal);
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.title = i18n.t(($) => {
    return $.chat.landingFiles.loading;
  });
  frame.referrerPolicy = "no-referrer";
  frame.src = new URL("/file-handoff", source).toString();
  let settled = false;
  const receive = (event: MessageEvent<unknown>) => {
    if (
      settled ||
      transferSignal.aborted ||
      event.origin !== source.origin ||
      event.source !== frame.contentWindow
    ) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== "object" || !("type" in data)) {
      return;
    }
    if (data.type === "okou:landing-files:ready") {
      frame.contentWindow?.postMessage(
        { type: "okou:landing-files:read", id },
        source.origin,
      );
      return;
    }
    if (
      data.type !== "okou:landing-files:result" ||
      !("id" in data) ||
      data.id !== id ||
      !("files" in data)
    ) {
      return;
    }
    settled = true;
    const files: unknown = data.files;
    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      files.length > 10 ||
      !files.every((file: unknown): file is File => {
        return file instanceof File;
      }) ||
      files.reduce((size, file: File) => {
        return size + file.size;
      }, 0) >
        1024 * 1024 * 1024
    ) {
      result.reject(new Error("Landing files are unavailable in this browser"));
      return;
    }
    result.resolve(files);
  };
  window.addEventListener("message", receive);
  document.body.append(frame);
  const [outcome] = await Promise.allSettled([result.promise]);
  window.removeEventListener("message", receive);
  frame.remove();
  if (!outcome || outcome.status === "rejected") {
    throw outcome?.reason ?? new Error("File transfer did not complete");
  }
  return outcome.value;
}
