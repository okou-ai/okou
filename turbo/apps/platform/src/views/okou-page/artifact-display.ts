import type { AttachmentArtifactMetadata } from "../../signals/okou-page/attachment-chips.ts";
import { i18n } from "../../i18n/index.ts";
import { officeFilePreviewKind } from "./office-file-preview.ts";

type ArtifactDisplayKind =
  | "markdown"
  | "text"
  | "json"
  | "csv"
  | "html"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "file";

type ArtifactTitleMetadata = Pick<
  AttachmentArtifactMetadata,
  "artifactKind" | "contentType" | "createdAt" | "filename" | "size"
>;

type ArtifactTitleKind =
  | "presentation"
  | "hosted-site"
  | "code"
  | "document"
  | "data"
  | "image"
  | "video"
  | "audio"
  | "file";

function fileExtension(filename: string): string | null {
  const extension = filename.split(".").pop();
  if (!extension || extension === filename) {
    return null;
  }
  return extension.toUpperCase();
}

function contentTypeFormat(contentType: string): string | null {
  const subtype = contentType.split("/")[1]?.split(";")[0]?.trim();
  if (!subtype) {
    return null;
  }
  if (subtype === "jpeg") {
    return "JPG";
  }
  if (subtype === "plain") {
    return "TXT";
  }
  if (subtype === "mpeg") {
    return "MP3";
  }
  return subtype.toUpperCase();
}

function isPresentationExtension(extension: string): boolean {
  switch (extension) {
    case "KEY":
    case "ODP":
    case "PPT":
    case "PPTX": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function isCodeExtension(extension: string): boolean {
  switch (extension) {
    case "CSS":
    case "GO":
    case "HTML":
    case "JS":
    case "JSX":
    case "PY":
    case "RB":
    case "RS":
    case "TS":
    case "TSX": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function artifactFormat(meta: ArtifactTitleMetadata): string | null {
  return fileExtension(meta.filename) ?? contentTypeFormat(meta.contentType);
}

function formatArtifactBytes(bytes: number): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value = value / 1024;
    unitIndex += 1;
  }
  return new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language, {
    style: "unit",
    unit: units[unitIndex],
    unitDisplay: "short",
    maximumFractionDigits: value >= 10 || unitIndex === 0 ? 0 : 1,
  }).format(value);
}

function formatArtifactGeneratedTime(value: string): string {
  return new Date(value).toLocaleString(
    i18n.resolvedLanguage ?? i18n.language,
    {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    },
  );
}

function artifactTitleKind(
  kind: ArtifactDisplayKind,
  filename: string,
  artifactKind: ArtifactTitleMetadata["artifactKind"],
): ArtifactTitleKind {
  if (artifactKind === "presentation-html") {
    return "presentation";
  }
  const officePreviewKind = officeFilePreviewKind(filename);
  if (officePreviewKind === "document") {
    return "document";
  }
  if (officePreviewKind === "spreadsheet") {
    return "data";
  }
  if (officePreviewKind === "presentation") {
    return "presentation";
  }
  const extension = fileExtension(filename);
  if (extension && isPresentationExtension(extension)) {
    return "presentation";
  }
  if (extension && isCodeExtension(extension)) {
    return kind === "html" ? "hosted-site" : "code";
  }

  switch (kind) {
    case "markdown":
    case "pdf":
    case "text": {
      return "document";
    }
    case "json":
    case "csv": {
      return "data";
    }
    case "html": {
      return "hosted-site";
    }
    case "image": {
      return "image";
    }
    case "video": {
      return "video";
    }
    case "audio": {
      return "audio";
    }
    case "file": {
      return "file";
    }
  }
}

function artifactKindTitle(kind: ArtifactTitleKind): string {
  switch (kind) {
    case "presentation": {
      return i18n.t(($) => {
        return $.artifacts.kinds.presentation;
      });
    }
    case "hosted-site": {
      return i18n.t(($) => {
        return $.artifacts.kinds.hostedSite;
      });
    }
    case "code": {
      return i18n.t(($) => {
        return $.artifacts.kinds.code;
      });
    }
    case "document": {
      return i18n.t(($) => {
        return $.artifacts.kinds.document;
      });
    }
    case "data": {
      return i18n.t(($) => {
        return $.artifacts.kinds.data;
      });
    }
    case "image": {
      return i18n.t(($) => {
        return $.artifacts.kinds.image;
      });
    }
    case "video": {
      return i18n.t(($) => {
        return $.artifacts.kinds.video;
      });
    }
    case "audio": {
      return i18n.t(($) => {
        return $.artifacts.kinds.audio;
      });
    }
    case "file": {
      return i18n.t(($) => {
        return $.artifacts.kinds.file;
      });
    }
  }
}

/**
 * Fullscreen exists to make a picture bigger. An audio player has no picture,
 * so offering the control there only produces a larger empty stage.
 */
export function artifactSupportsFullscreen(kind: ArtifactDisplayKind): boolean {
  return kind !== "audio";
}

export function artifactFallbackSubtitle(
  kind: ArtifactDisplayKind,
  filename: string,
): string {
  return artifactKindTitle(artifactTitleKind(kind, filename, undefined));
}

export function artifactTitleSubtitle(
  kind: ArtifactDisplayKind,
  meta: ArtifactTitleMetadata,
  options: { readonly showSize?: boolean } = {},
): string {
  const titleKind = artifactTitleKind(kind, meta.filename, meta.artifactKind);
  const parts = [artifactKindTitle(titleKind)];
  const format = artifactFormat(meta);
  if (format && titleKind !== "hosted-site") {
    parts.push(format);
  }
  if (options.showSize ?? true) {
    parts.push(formatArtifactBytes(meta.size));
  }
  parts.push(
    i18n.t(
      ($) => {
        return $.artifacts.metadata.generated;
      },
      {
        date: formatArtifactGeneratedTime(meta.createdAt),
      },
    ),
  );
  return parts.join(" · ");
}
