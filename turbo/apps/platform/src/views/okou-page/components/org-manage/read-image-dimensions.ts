import {
  createDeferredPromise,
  withCleanup,
} from "../../../../signals/utils.ts";

export function readImageDimensions(
  file: File,
  signal: AbortSignal,
): Promise<{ width: number; height: number } | null> {
  signal.throwIfAborted();
  const url = URL.createObjectURL(file);
  const img = new Image();
  const dimensions = createDeferredPromise<{
    width: number;
    height: number;
  } | null>(signal);
  const onLoad = () => {
    dimensions.resolve({ width: img.naturalWidth, height: img.naturalHeight });
  };
  const onError = () => {
    dimensions.resolve(null);
  };
  img.addEventListener("load", onLoad, { once: true, signal });
  img.addEventListener("error", onError, { once: true, signal });
  img.src = url;
  // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
  return withCleanup(dimensions.promise, () => {
    img.removeEventListener("load", onLoad);
    img.removeEventListener("error", onError);
    img.removeAttribute("src");
    URL.revokeObjectURL(url);
  });
}
