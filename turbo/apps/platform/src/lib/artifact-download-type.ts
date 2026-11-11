import type { ArtifactKind } from "../signals/chat-page/artifact-card-signals.ts";

export type ArtifactDownloadType =
  | "image"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "website"
  | "pdf"
  | "html"
  | "audio"
  | "video"
  | "archive"
  | "other";

interface ArtifactDownloadSource {
  readonly filename: string;
  readonly contentType?: string | undefined;
  readonly artifactKind?: "hosted-site" | "presentation-html" | undefined;
  readonly previewKind?: ArtifactKind | undefined;
}

const PREVIEW_TYPES: Readonly<
  Partial<Record<ArtifactKind, ArtifactDownloadType>>
> = {
  image: "image",
  video: "video",
  audio: "audio",
  markdown: "document",
  text: "document",
  csv: "spreadsheet",
  pdf: "pdf",
  html: "html",
};

const FILE_TYPES: readonly {
  readonly type: ArtifactDownloadType;
  readonly filename: RegExp;
  readonly contentType: RegExp;
}[] = [
  {
    type: "image",
    filename: /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?|heic|heif)$/iu,
    contentType: /^image\//u,
  },
  {
    type: "spreadsheet",
    filename: /\.(?:csv|tsv|xlsx?|xlsm|xlsb|xltx|xltm|ods|numbers|parquet)$/iu,
    contentType:
      /(?:spreadsheet|ms-excel|opendocument\.spreadsheet|^text\/(?:csv|tab-separated-values)$|parquet)/u,
  },
  {
    type: "presentation",
    filename: /\.(?:pptx?|pptm|potx?|potm|ppsx?|ppsm|odp|key)$/iu,
    contentType:
      /(?:presentation|powerpoint|opendocument\.presentation|keynote)/u,
  },
  {
    type: "document",
    filename:
      /\.(?:docx?|docm|dotx?|dotm|odt|rtf|pages|epub|md|markdown|mdx|txt)$/iu,
    contentType:
      /(?:msword|wordprocessingml|opendocument\.text|^application\/(?:rtf|epub\+zip)$|^text\/(?:plain|markdown|x-markdown|rtf)$)/u,
  },
  {
    type: "pdf",
    filename: /\.pdf$/iu,
    contentType: /^application\/pdf$/u,
  },
  {
    type: "html",
    filename: /\.(?:html?|xhtml)$/iu,
    contentType: /^(?:text\/html|application\/xhtml\+xml)$/u,
  },
  {
    type: "audio",
    filename: /\.(?:mp3|mpga|wav|wave|m4a|aac|ogg|oga|opus|flac)$/iu,
    contentType: /^audio\//u,
  },
  {
    type: "video",
    filename: /\.(?:mp4|webm|mov|ogv|mkv|avi|m4v)$/iu,
    contentType: /^video\//u,
  },
  {
    type: "archive",
    filename: /\.(?:zip|rar|7z|tar|gz|tgz|bz2|xz)$/iu,
    contentType:
      /^application\/(?:zip|x-zip-compressed|x-tar|gzip|x-gzip|x-7z-compressed|x-rar-compressed|vnd\.rar|x-bzip2|x-xz)$/u,
  },
];

/** Return only a bounded category; never send filenames, MIME types or URLs. */
export function artifactDownloadType({
  filename,
  contentType,
  artifactKind,
  previewKind,
}: ArtifactDownloadSource): ArtifactDownloadType {
  if (artifactKind === "presentation-html") {
    return "presentation";
  }
  if (artifactKind === "hosted-site") {
    return "website";
  }
  const mimeType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const name = filename.trim();
  return (
    FILE_TYPES.find((candidate) => {
      return candidate.contentType.test(mimeType);
    })?.type ??
    (previewKind ? PREVIEW_TYPES[previewKind] : undefined) ??
    FILE_TYPES.find((candidate) => {
      return candidate.filename.test(name);
    })?.type ??
    "other"
  );
}
