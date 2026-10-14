import { i18n } from "../../i18n/index.ts";

const SPREADSHEET_FILE_RE =
  /\.(csv|tsv|xls|xlsx|xlsm|xlsb|xlm|xltx|xltm|ods|numbers|parquet)$/i;
const DATABASE_FILE_RE = /\.(sqlite|sqlite3|db)$/i;
const PRESENTATION_FILE_RE =
  /\.(ppt|pptx|pptm|pot|potx|potm|pps|ppsx|ppsm|odp|key)$/i;
const ARCHIVE_FILE_RE = /\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i;
const ARTWORK_FILE_RE = /\.(psd|ai|eps)$/i;
const DOCUMENT_FILE_RE = /\.(doc|docx|docm|dot|dotx|dotm|odt|rtf|pages|epub)$/i;
const PDF_FILE_RE = /\.pdf$/i;
const MARKDOWN_FILE_RE = /\.(md|markdown|mdx)$/i;
const TEXT_FILE_RE = /\.(txt|log|xml|yaml|yml)$/i;
const JSON_FILE_RE = /\.json$/i;
const HTML_FILE_RE = /\.(html|htm)$/i;
const AUDIO_FILE_RE = /\.(mp3|mpga|wav|wave|m4a|aac|ogg|oga|opus|flac)$/i;
const VIDEO_FILE_RE = /\.(mp4|webm|mov|ogv)$/i;
const SPREADSHEET_EXTENSION_RE =
  /^(CSV|TSV|XLS|XLSX|XLSM|XLSB|XLM|XLTX|XLTM|ODS|NUMBERS|PARQUET)$/;
const DATABASE_EXTENSION_RE = /^(SQLITE|SQLITE3|DB)$/;
const PRESENTATION_EXTENSION_RE =
  /^(PPT|PPTX|PPTM|POT|POTX|POTM|PPS|PPSX|PPSM|ODP|KEY)$/;
const ARCHIVE_EXTENSION_RE = /^(ZIP|RAR|7Z|TAR|GZ|TGZ|BZ2|XZ)$/;
const ARTWORK_EXTENSION_RE = /^(PSD|AI|EPS)$/;
const DOCUMENT_EXTENSION_RE =
  /^(DOC|DOCX|DOCM|DOT|DOTX|DOTM|ODT|RTF|PAGES|EPUB)$/;

type FilePreviewIconMeta = {
  label: string;
  bandClassName: string;
};

type FilePreviewIconSize = "sm" | "md" | "lg";

function filePreviewIconSizeClass(size: FilePreviewIconSize) {
  if (size === "sm") {
    return {
      root: "h-5 w-5 rounded-[5px]",
      top: "h-2.5",
      band: "h-2.5 px-0.5 text-[5px] tracking-[0.02em]",
    };
  }

  // Large enough to carry a tile on its own, where the icon is the whole
  // cover rather than a marker beside a filename.
  if (size === "lg") {
    return {
      root: "h-16 w-16 rounded-[16px]",
      top: "h-8",
      band: "h-8 px-1.5 text-[12px] tracking-[0.05em]",
    };
  }

  return {
    root: "h-10 w-10 rounded-[10px]",
    top: "h-5",
    band: "h-5 px-1 text-[8px] tracking-[0.04em]",
  };
}

function normalizeContentType(contentType?: string): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase();
}

function matchesFilePreviewType(
  lowerFilename: string,
  lowerContentType: string,
  filenamePattern: RegExp,
  contentTypeFragments: string[],
) {
  return (
    filenamePattern.test(lowerFilename) ||
    contentTypeFragments.some((fragment) => {
      return lowerContentType.includes(fragment);
    })
  );
}

function isSpreadsheetPreviewFile(
  lowerFilename: string,
  lowerContentType: string,
) {
  return matchesFilePreviewType(
    lowerFilename,
    lowerContentType,
    SPREADSHEET_FILE_RE,
    ["spreadsheet", "excel", "csv", "parquet"],
  );
}

function isDatabasePreviewFile(
  lowerFilename: string,
  lowerContentType: string,
) {
  return matchesFilePreviewType(
    lowerFilename,
    lowerContentType,
    DATABASE_FILE_RE,
    ["sqlite"],
  );
}

function isPresentationPreviewFile(
  lowerFilename: string,
  lowerContentType: string,
) {
  return matchesFilePreviewType(
    lowerFilename,
    lowerContentType,
    PRESENTATION_FILE_RE,
    ["presentation", "powerpoint", "keynote"],
  );
}

function isArchivePreviewFile(lowerFilename: string, lowerContentType: string) {
  return matchesFilePreviewType(
    lowerFilename,
    lowerContentType,
    ARCHIVE_FILE_RE,
    ["zip", "compressed", "gzip"],
  );
}

export function getFilePreviewAccentClass(
  filename: string,
  contentType?: string,
) {
  const lower = filename.toLowerCase();
  const type = normalizeContentType(contentType);

  if (
    isSpreadsheetPreviewFile(lower, type) ||
    isDatabasePreviewFile(lower, type)
  ) {
    return "from-teal-500/15 via-emerald-500/10 to-background";
  }

  if (isPresentationPreviewFile(lower, type)) {
    return "from-blue-500/15 via-cyan-500/10 to-background";
  }

  if (isArchivePreviewFile(lower, type)) {
    return "from-amber-500/15 via-orange-500/10 to-background";
  }

  return "from-slate-500/15 via-cyan-500/10 to-background";
}

function filePreviewExtension(filename: string): string {
  const ext = filename.split(".").pop()?.toUpperCase();
  return ext && ext !== filename.toUpperCase() ? ext : "";
}

function spreadsheetFilePreviewLabel(ext: string) {
  return ext ? ext.slice(0, 4) : "XLS";
}

function presentationFilePreviewLabel(ext: string) {
  return ext ? ext.slice(0, 4) : "PPT";
}

function archiveFilePreviewLabel(ext: string) {
  return ext ? ext.slice(0, 4) : "ZIP";
}

function documentFilePreviewLabel(ext: string) {
  return ext ? ext.slice(0, 4) : "DOC";
}

function getTextDocumentPreviewIconMeta(
  lower: string,
  type: string,
  ext: string,
): FilePreviewIconMeta | null {
  if (PDF_FILE_RE.test(lower) || type === "application/pdf") {
    return { label: "PDF", bandClassName: "bg-[#D73527]" };
  }

  if (HTML_FILE_RE.test(lower) || type === "text/html") {
    return { label: "HTML", bandClassName: "bg-[#D84E1F]" };
  }

  if (JSON_FILE_RE.test(lower) || type === "application/json") {
    return { label: "JSON", bandClassName: "bg-[#8A6D00]" };
  }

  if (MARKDOWN_FILE_RE.test(lower) || type.includes("markdown")) {
    return { label: "MD", bandClassName: "bg-[#395BFF]" };
  }

  if (
    TEXT_FILE_RE.test(lower) ||
    type.startsWith("text/") ||
    type.includes("xml") ||
    type.includes("yaml")
  ) {
    return { label: ext || "TXT", bandClassName: "bg-[#64748B]" };
  }

  if (AUDIO_FILE_RE.test(lower) || type.startsWith("audio/")) {
    return {
      label:
        ext ||
        i18n.t(($) => {
          return $.artifacts.fileBadges.audio;
        }),
      bandClassName: "bg-[#7C3AED]",
    };
  }

  if (VIDEO_FILE_RE.test(lower) || type.startsWith("video/")) {
    return {
      label:
        ext ||
        i18n.t(($) => {
          return $.artifacts.fileBadges.video;
        }),
      bandClassName: "bg-[#E11D48]",
    };
  }

  return null;
}

function getStructuredFilePreviewIconMeta(
  lower: string,
  type: string,
  ext: string,
): FilePreviewIconMeta | null {
  if (
    SPREADSHEET_EXTENSION_RE.test(ext) ||
    isSpreadsheetPreviewFile(lower, type)
  ) {
    return {
      label: spreadsheetFilePreviewLabel(ext),
      bandClassName: "bg-[#E47412]",
    };
  }

  if (DATABASE_EXTENSION_RE.test(ext) || isDatabasePreviewFile(lower, type)) {
    return { label: "DB", bandClassName: "bg-[#0F766E]" };
  }

  if (
    PRESENTATION_EXTENSION_RE.test(ext) ||
    isPresentationPreviewFile(lower, type)
  ) {
    return {
      label: presentationFilePreviewLabel(ext),
      bandClassName: "bg-[#2563EB]",
    };
  }

  if (ARCHIVE_EXTENSION_RE.test(ext) || isArchivePreviewFile(lower, type)) {
    return {
      label: archiveFilePreviewLabel(ext),
      bandClassName: "bg-[#D97706]",
    };
  }

  if (
    ARTWORK_EXTENSION_RE.test(ext) ||
    matchesFilePreviewType(lower, type, ARTWORK_FILE_RE, ["illustrator"])
  ) {
    return {
      label:
        ext ||
        i18n.t(($) => {
          return $.artifacts.fileBadges.artwork;
        }),
      bandClassName: "bg-[#D84E1F]",
    };
  }

  if (DOCUMENT_EXTENSION_RE.test(ext) || DOCUMENT_FILE_RE.test(lower)) {
    return {
      label: documentFilePreviewLabel(ext),
      bandClassName: "bg-[#395BFF]",
    };
  }

  return null;
}

function getFilePreviewIconMeta(
  filename: string,
  contentType?: string,
): FilePreviewIconMeta {
  const lower = filename.toLowerCase();
  const type = normalizeContentType(contentType);
  const ext = filePreviewExtension(filename);
  const knownMeta =
    getTextDocumentPreviewIconMeta(lower, type, ext) ??
    getStructuredFilePreviewIconMeta(lower, type, ext);

  if (knownMeta) {
    return knownMeta;
  }

  return {
    label: ext
      ? ext.slice(0, 4)
      : i18n.t(($) => {
          return $.artifacts.fileBadges.file;
        }),
    bandClassName: "bg-[#64748B]",
  };
}

export function FilePreviewIcon({
  filename,
  contentType,
  className,
  size = "md",
  testId,
}: {
  filename: string;
  contentType?: string;
  className?: string;
  size?: FilePreviewIconSize;
  testId?: string;
}) {
  const { label, bandClassName } = getFilePreviewIconMeta(
    filename,
    contentType,
  );
  const sizeClass = filePreviewIconSizeClass(size);

  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className={`relative flex overflow-hidden border border-[#E1DBD5] bg-white shadow-sm ${sizeClass.root}${
        className ? ` ${className}` : ""
      }`}
    >
      <span
        className={`absolute inset-x-0 top-0 bg-[#F0EBE5] ${sizeClass.top}`}
      />
      <span
        className={`absolute inset-x-0 bottom-0 flex items-center justify-center font-bold text-white ${sizeClass.band} ${bandClassName}`}
      >
        {label}
      </span>
    </span>
  );
}
