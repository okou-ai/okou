export type MessageArtifactFileKind =
  | "image"
  | "video"
  | "audio"
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "pdf"
  | "html"
  | "file";

function fileExt(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function normalizeType(contentType?: string): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

const CHAT_KIND_BY_CONTENT_TYPE: Readonly<
  Record<string, MessageArtifactFileKind>
> = {
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/plain": "text",
  "text/tab-separated-values": "text",
  "text/xml": "text",
  "text/yaml": "text",
  "text/x-yaml": "text",
  "application/xml": "text",
  "application/yaml": "text",
  "application/x-yaml": "text",
  "application/json": "json",
  "text/csv": "csv",
  "application/pdf": "pdf",
  "text/html": "html",
} as const;

const CHAT_KIND_BY_EXTENSION: Readonly<
  Record<string, MessageArtifactFileKind>
> = {
  md: "markdown",
  txt: "text",
  log: "text",
  xml: "text",
  yaml: "text",
  yml: "text",
  tsv: "text",
  json: "json",
  csv: "csv",
  pdf: "pdf",
  html: "html",
  htm: "html",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  avif: "image",
  heic: "image",
  heif: "image",
  tif: "image",
  tiff: "image",
  psd: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  ogv: "video",
  mp3: "audio",
  wav: "audio",
  wave: "audio",
  m4a: "audio",
  aac: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  flac: "audio",
  mpga: "audio",
} as const;

function mediaKindFromContentType(
  type: string,
): MessageArtifactFileKind | null {
  if (type.startsWith("image/")) {
    return "image";
  }
  if (type.startsWith("video/")) {
    return "video";
  }
  if (type.startsWith("audio/")) {
    return "audio";
  }
  return null;
}

export function classifyMessageArtifact(attachment: {
  readonly filename: string;
  readonly contentType?: string;
  readonly url?: string;
}): MessageArtifactFileKind {
  const type = normalizeType(attachment.contentType);
  const ext = fileExt(attachment.filename);
  const mediaKind = mediaKindFromContentType(type);

  if (mediaKind) {
    return mediaKind;
  }

  return (
    CHAT_KIND_BY_CONTENT_TYPE[type] ?? CHAT_KIND_BY_EXTENSION[ext] ?? "file"
  );
}
