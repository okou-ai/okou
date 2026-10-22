import type { Element, Root } from "hast";
import { visit } from "unist-util-visit";

import { createDeferredPromise, withCleanup } from "../../signals/utils.ts";
import { renderMermaidDiagramFile } from "../mermaid-renderer.ts";
import { prepareSvgImage } from "./svg.ts";
import type { PdfAssets, PdfRasterImage } from "./types.ts";
import { imageResourceUrl, readPdfResource } from "./urls.ts";

async function rasterizeImage(
  blob: Blob,
  signal: AbortSignal,
  svg = false,
): Promise<PdfRasterImage> {
  signal.throwIfAborted();
  // Chromium can taint canvases for foreignObject SVGs loaded from blob URLs.
  // A self-contained data URL keeps the trusted Mermaid SVG origin-clean.
  const url = svg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(await blob.text())}`
    : URL.createObjectURL(blob);
  signal.throwIfAborted();
  const image = new Image();
  const loaded = createDeferredPromise<void>(signal);
  const onLoad = () => {
    if (!loaded.settled()) {
      loaded.resolve();
    }
  };
  const onError = () => {
    if (!loaded.settled()) {
      loaded.reject(new Error("PDF image could not be decoded"));
    }
  };
  image.addEventListener("load", onLoad, { once: true, signal });
  image.addEventListener("error", onError, { once: true, signal });
  image.src = url;
  return withCleanup(
    (async () => {
      await loaded.promise;
      signal.throwIfAborted();
      if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) {
        throw new Error("PDF image has no usable dimensions");
      }
      // Preserve the original pixels except for a bounded very large image.
      const scale = Math.min(
        1,
        4096 / Math.max(image.naturalWidth, image.naturalHeight),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("PDF image canvas is unavailable");
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      canvas.width = 0;
      canvas.height = 0;
      return {
        dataUrl,
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
    })(),
    () => {
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
      image.removeAttribute("src");
      if (!svg) {
        URL.revokeObjectURL(url);
      }
    },
  );
}

export async function preparePdfAssets(
  tree: Root,
  imageUrls: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<PdfAssets> {
  const assets: PdfAssets = { images: new Map(), diagrams: new Map() };
  const nodes: Element[] = [];
  visit(tree, "element", (node) => {
    if (node.tagName === "img" || node.data?.mermaid) {
      nodes.push(node);
    }
  });
  for (const node of nodes) {
    signal.throwIfAborted();
    if (node.data?.mermaid) {
      const code = node.data.mermaid.code;
      if (!assets.diagrams.has(code)) {
        const file = await renderMermaidDiagramFile(code);
        signal.throwIfAborted();
        if (!file) {
          throw new Error("PDF Mermaid diagram is invalid or unsupported");
        }
        assets.diagrams.set(code, await rasterizeImage(file, signal, true));
      }
    } else {
      const source = node.properties.src;
      if (typeof source !== "string" || source === "") {
        throw new Error("PDF image has no source URL");
      }
      if (!assets.images.has(source)) {
        const resource = imageResourceUrl(imageUrls.get(source) ?? source);
        // A preview may have cached an opaque <img> response. Export needs a
        // fresh CORS-readable response rather than that no-CORS cache entry.
        const response = await readPdfResource(resource, "reload", signal);
        const blob = await response.blob();
        signal.throwIfAborted();
        const svg = /^image\/svg\+xml(?:$|;)/iu.test(blob.type);
        if (
          !svg &&
          !/^image\/(?:png|jpeg|gif|webp|avif|bmp)(?:$|;)/iu.test(blob.type)
        ) {
          throw new Error("PDF image is not a supported image format");
        }
        const imageBlob = svg ? await prepareSvgImage(blob, signal) : blob;
        assets.images.set(source, await rasterizeImage(imageBlob, signal, svg));
      }
    }
  }
  return assets;
}
