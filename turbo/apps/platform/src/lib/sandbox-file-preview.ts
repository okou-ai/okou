import type { SandboxChannelPeer } from "@okouai/core/sandbox-channel-peer";
import {
  SANDBOX_FS_LIMITS,
  sandboxFsOpen,
  sandboxFsRead,
  sandboxFsFinish,
} from "@okouai/api-contracts/contracts/sandbox-channel-fs";
import {
  createDeferredPromise,
  settle,
  withCleanup,
} from "../signals/utils.ts";

type PreviewKind =
  "text" | "markdown" | "json" | "csv" | "image" | "pdf" | "unknown";
export type FilePreviewFailure =
  | "unsupported"
  | "size"
  | "invalid"
  | "decode"
  | "changed"
  | "updateRequired"
  | "unavailable";
export class FilePreviewError extends Error {
  constructor(readonly code: FilePreviewFailure) {
    super(`File preview ${code}`);
  }
}

function previewFormat(name: string): { kind: PreviewKind; mime: string } {
  const extension = name.toLowerCase().split(".").at(-1) ?? "";
  const images: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  const image = Object.hasOwn(images, extension)
    ? images[extension]
    : undefined;
  if (image) {
    return { kind: "image", mime: image };
  }
  if (extension === "pdf") {
    return { kind: "pdf", mime: "application/pdf" };
  }
  if (["md", "markdown"].includes(extension)) {
    return { kind: "markdown", mime: "text/plain" };
  }
  if (extension === "json") {
    return { kind: "json", mime: "text/plain" };
  }
  if (extension === "csv") {
    return { kind: "csv", mime: "text/plain" };
  }
  if (
    /^(txt|log|jsonl|ndjson|yaml|yml|toml|xml|html?|svg|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|pyi|rs|go|java|kt|kts|c|h|cc|cpp|hpp|cs|rb|php|sh|bash|zsh|fish|sql|r|swift|vue|svelte|ini|conf|cfg|env|properties|diff|patch|tex|rst|adoc)$/.test(
      extension,
    ) ||
    /^(readme|license|dockerfile|makefile|\.gitignore)$/i.test(name)
  ) {
    return { kind: "text", mime: "text/plain" };
  }
  // Linux text files may have any name. Validate their bounded prefix before
  // showing escaped source; an unknown suffix is not evidence of binary data.
  return { kind: "unknown", mime: "text/plain" };
}

function signature(
  bytes: Uint8Array,
  offset: number,
  expected: readonly number[],
): boolean {
  return expected.every((value, index) => {
    return bytes[offset + index] === value;
  });
}
function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  return signature(
    bytes,
    offset,
    Array.from(value, (character) => {
      return character.charCodeAt(0);
    }),
  );
}
function bounds(width: number, height: number): void {
  if (
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 16_000_000
  ) {
    throw new FilePreviewError("size");
  }
}

function jpegDimensions(bytes: Uint8Array, view: DataView) {
  if (signature(bytes, 0, [255, 216])) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) {
        break;
      }
      while (bytes[offset] === 255) {
        offset++;
      }
      const marker = bytes[offset++];
      if (marker === undefined || marker === 218 || marker === 217) {
        break;
      }
      if (marker === 1 || (marker >= 208 && marker <= 215)) {
        continue;
      }
      if (offset + 2 > bytes.length) {
        break;
      }
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) {
        break;
      }
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      ) {
        return {
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3),
        };
      }
      offset += length;
    }
  }
  throw new FilePreviewError("invalid");
}

function webpDimensions(bytes: Uint8Array, view: DataView) {
  if (
    bytes.length >= 20 &&
    ascii(bytes, 0, "RIFF") &&
    ascii(bytes, 8, "WEBP") &&
    view.getUint32(4, true) + 8 === bytes.length
  ) {
    const uint24 = (offset: number) => {
      return (
        view.getUint8(offset) +
        (view.getUint8(offset + 1) << 8) +
        (view.getUint8(offset + 2) << 16)
      );
    };
    if (
      bytes.length >= 30 &&
      ascii(bytes, 12, "VP8X") &&
      view.getUint32(16, true) === 10
    ) {
      return { width: uint24(24) + 1, height: uint24(27) + 1 };
    }
    if (
      bytes.length >= 30 &&
      ascii(bytes, 12, "VP8 ") &&
      signature(bytes, 23, [157, 1, 42])
    ) {
      return {
        width: view.getUint16(26, true) & 0x3f_ff,
        height: view.getUint16(28, true) & 0x3f_ff,
      };
    }
    if (bytes.length >= 25 && ascii(bytes, 12, "VP8L") && bytes[20] === 47) {
      const packed = view.getUint32(21, true);
      return {
        width: (packed & 0x3f_ff) + 1,
        height: ((packed >>> 14) & 0x3f_ff) + 1,
      };
    }
  }
  throw new FilePreviewError("invalid");
}

/** Inspect declared dimensions before any browser decoder sees untrusted bytes. */
function imageDimensions(bytes: Uint8Array, mime: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    mime === "image/png" &&
    bytes.length >= 33 &&
    signature(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10]) &&
    view.getUint32(8) === 13 &&
    ascii(bytes, 12, "IHDR")
  ) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (
    mime === "image/gif" &&
    bytes.length >= 13 &&
    (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a"))
  ) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (mime === "image/jpeg") {
    return jpegDimensions(bytes, view);
  }
  if (mime === "image/webp") {
    return webpDimensions(bytes, view);
  }
  throw new FilePreviewError("invalid");
}

async function validateImage(
  blob: Blob,
  declared: { width: number; height: number },
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const image = new Image();
  const url = URL.createObjectURL(blob);
  const ready = createDeferredPromise<void>(signal);
  const loaded = () => {
    const original =
      image.naturalWidth === declared.width &&
      image.naturalHeight === declared.height;
    // EXIF orientation may exchange the axes without changing the pixel budget.
    const rotated =
      image.naturalWidth === declared.height &&
      image.naturalHeight === declared.width;
    if (!original && !rotated) {
      ready.reject(new FilePreviewError("invalid"));
    } else {
      ready.resolve();
    }
  };
  const failed = () => {
    return ready.reject(new FilePreviewError("decode"));
  };
  image.addEventListener("load", loaded, { once: true, signal });
  image.addEventListener("error", failed, { once: true, signal });
  image.src = url;
  await withCleanup(ready.promise, () => {
    image.removeEventListener("load", loaded);
    image.removeEventListener("error", failed);
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  });
}

export type SandboxPreviewContent =
  | {
      readonly kind: "text" | "markdown" | "csv" | "json";
      readonly text: string;
      readonly truncated: boolean;
      readonly empty: boolean;
    }
  | {
      readonly kind: "image" | "pdf";
      readonly blob: Blob;
      readonly truncated: false;
      readonly empty: false;
    };

/** The caller owns/always closes this dedicated peer, including its handles. */
export async function readSandboxFilePreview(
  peer: SandboxChannelPeer,
  path: readonly string[],
  name: string,
  signal: AbortSignal,
): Promise<SandboxPreviewContent> {
  const format = previewFormat(name);
  const binary = ["image", "pdf"].includes(format.kind);
  await peer.connect(signal);
  signal.throwIfAborted();
  const opened = await peer.call(
    sandboxFsOpen,
    { path: [...path], mode: binary ? "preview" : "prefix" },
    signal,
  );
  const full = BigInt(opened.fileSize);
  const selected = BigInt(opened.selectedSize);
  const cap = BigInt(
    binary
      ? SANDBOX_FS_LIMITS.maxPreviewBytes
      : SANDBOX_FS_LIMITS.maxPrefixBytes,
  );
  if (selected > cap || (binary && full > cap)) {
    throw new FilePreviewError("size");
  }
  if (
    opened.nameToken !== path.at(-1) ||
    selected !== (full < cap ? full : cap) ||
    (binary && opened.truncated)
  ) {
    throw new FilePreviewError("invalid");
  }
  const bytes = new Uint8Array(Number(selected));
  for (let offset = 0; offset < bytes.length;) {
    signal.throwIfAborted();
    const length = Math.min(
      SANDBOX_FS_LIMITS.maxChunkBytes,
      bytes.length - offset,
    );
    const chunk = await peer.call(
      sandboxFsRead,
      { handle: opened.handle, offset: String(offset), length },
      signal,
    );
    signal.throwIfAborted();
    if (chunk.offset !== String(offset) || chunk.length !== length) {
      throw new FilePreviewError("invalid");
    }
    bytes.set(
      Uint8Array.from(atob(chunk.data), (character) => {
        return character.charCodeAt(0);
      }),
      offset,
    );
    offset += length;
  }
  await peer.call(sandboxFsFinish, { handle: opened.handle }, signal);
  signal.throwIfAborted();
  if (bytes.length === 0) {
    return { kind: "text", text: "", truncated: false, empty: true };
  }
  if (binary) {
    if (format.kind === "pdf" && !ascii(bytes, 0, "%PDF-")) {
      throw new FilePreviewError("invalid");
    }
    const blob = new Blob([bytes], { type: format.mime });
    if (format.kind === "image") {
      const dimensions = imageDimensions(bytes, format.mime);
      bounds(dimensions.width, dimensions.height);
      await validateImage(blob, dimensions, signal);
    }
    return {
      kind: format.kind === "image" ? "image" : "pdf",
      blob,
      truncated: false,
      empty: false,
    };
  }
  return previewText(bytes, opened.truncated, format.kind, signal);
}

async function previewText(
  bytes: Uint8Array,
  truncated: boolean,
  kind: PreviewKind,
  signal: AbortSignal,
): Promise<SandboxPreviewContent> {
  // Streaming decode discards an incomplete final code point only for a prefix.
  // Fatal decoding still rejects malformed bytes anywhere before that boundary.
  const decoded = await settle(() => {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: truncated,
    });
  }, signal);
  const decodeFailure = kind === "unknown" ? "unsupported" : "decode";
  if (!decoded.ok) {
    throw new FilePreviewError(decodeFailure);
  }
  const text = decoded.value;
  if (
    Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    })
  ) {
    throw new FilePreviewError(decodeFailure);
  }
  return {
    kind:
      kind === "json" || kind === "markdown"
        ? kind
        : kind === "csv" && !truncated
          ? "csv"
          : "text",
    text,
    truncated,
    empty: bytes.length === 0,
  };
}
