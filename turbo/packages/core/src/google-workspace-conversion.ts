import {
  convertsToGoogleSlides,
  GOOGLE_SLIDES_MIME_TYPE,
} from "./google-slides-conversion";

/** Shared eligibility for preview actions and native Drive imports. */
export type GoogleWorkspaceTarget = "document" | "spreadsheet" | "presentation";
export type GoogleDriveUploadMode = "original" | "google";

export const GOOGLE_WORKSPACE_MIME_TYPES = {
  document: "application/vnd.google-apps.document",
  spreadsheet: "application/vnd.google-apps.spreadsheet",
  presentation: GOOGLE_SLIDES_MIME_TYPE,
} as const;

const DOCUMENT_FORMATS: Readonly<Record<string, string>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
};
const SPREADSHEET_FORMATS: Readonly<Record<string, string>> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
};

export function googleWorkspaceConversion(filename: string): {
  readonly target: Exclude<GoogleWorkspaceTarget, "presentation">;
  readonly sourceMimeType: string;
  readonly extension: string;
} | null {
  const name = filename.split(/[?#]/u, 1)[0]?.toLowerCase();
  const extension = name?.split(".").pop();
  if (!extension || extension === name) {
    return null;
  }
  const documentMime = Object.hasOwn(DOCUMENT_FORMATS, extension)
    ? DOCUMENT_FORMATS[extension]
    : undefined;
  if (documentMime) {
    return { target: "document", sourceMimeType: documentMime, extension };
  }
  const spreadsheetMime = Object.hasOwn(SPREADSHEET_FORMATS, extension)
    ? SPREADSHEET_FORMATS[extension]
    : undefined;
  return spreadsheetMime
    ? { target: "spreadsheet", sourceMimeType: spreadsheetMime, extension }
    : null;
}

export function googleWorkspaceTarget(
  filename: string,
): GoogleWorkspaceTarget | undefined {
  return (
    googleWorkspaceConversion(filename)?.target ??
    (convertsToGoogleSlides(filename) ? "presentation" : undefined)
  );
}
