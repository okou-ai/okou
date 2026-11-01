import {
  derivePlatformServiceOrigin,
  okouAppWorkerPreviewJobRef,
} from "@okouai/core/platform-service-origin";
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
    okouAppWorkerPreviewJobRef(app.hostname) !== null &&
    /^(?:staging|pr-[0-9]+)-www\.(?:omby\.ai|vm6\.ai)$/u.test(url.hostname);
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

export function landingFileReturnUrl(
  source: URL,
  id: string,
  appOrigin: string,
) {
  const url = new URL(source);
  url.searchParams.set("fileDraft", id);
  const preview = okouAppWorkerPreviewJobRef(new URL(appOrigin).hostname);
  if (preview?.startsWith("pr-")) {
    url.searchParams.set("appPreview", preview.slice(3));
  }
  return url.toString();
}

export class LandingFilePopupBlockedError extends Error {}
export class LandingFilesUnavailableError extends Error {}

export function validLandingFiles(files: unknown): files is File[] {
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.length <= 10 &&
    files.every((file: unknown): file is File => {
      return file instanceof File;
    }) &&
    files.reduce((size, file: File) => {
      return size + file.size;
    }, 0) <=
      1024 * 1024 * 1024
  );
}

/** Called directly from the start button, before yielding user activation. */
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
  const nonce = crypto.randomUUID();
  const bridge = new URL("/file-handoff", source);
  bridge.searchParams.set("appOrigin", location.origin);
  bridge.hash = nonce;
  // A top-level window reads the same first-party IndexedDB used on the
  // landing page. A cross-site iframe instead sees partitioned, empty storage.
  const popup = window.open(bridge, "_blank", "popup,width=600,height=500");
  if (!popup) {
    throw new LandingFilePopupBlockedError("Allow the file transfer window");
  }
  const result = createDeferredPromise<File[]>(transferSignal);
  let settled = false;
  const receive = (event: MessageEvent<unknown>) => {
    if (
      settled ||
      transferSignal.aborted ||
      event.origin !== source.origin ||
      event.source !== popup
    ) {
      return;
    }
    const data = event.data;
    if (
      !data ||
      typeof data !== "object" ||
      !("type" in data) ||
      !("nonce" in data) ||
      data.nonce !== nonce
    ) {
      return;
    }
    if (data.type === "okou:landing-files:closed") {
      settled = true;
      result.reject(
        new LandingFilesUnavailableError("File transfer window closed"),
      );
      return;
    }
    if (data.type === "okou:landing-files:ready") {
      popup.postMessage(
        { type: "okou:landing-files:read", id, nonce },
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
    if (!validLandingFiles(files)) {
      result.reject(
        new LandingFilesUnavailableError(
          "Landing files are unavailable in this browser",
        ),
      );
      return;
    }
    result.resolve(files);
  };
  window.addEventListener("message", receive);
  const [outcome] = await Promise.allSettled([result.promise]);
  window.removeEventListener("message", receive);
  popup.close();
  if (outcome.status === "rejected") {
    throw outcome.reason;
  }
  return outcome.value;
}
