type OfficeFilePreviewKind = "document" | "spreadsheet" | "presentation";

function fileExtension(filename: string): string | null {
  const normalizedFilename = filename.split(/[?#]/u, 1)[0]?.toLowerCase();
  const extension = normalizedFilename?.split(".").pop();
  if (!extension || extension === normalizedFilename) {
    return null;
  }
  return extension;
}

function isOfficeDocumentExtension(extension: string): boolean {
  switch (extension) {
    case "doc":
    case "docm":
    case "docx":
    case "dot":
    case "dotm":
    case "dotx":
    case "odt": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function isOfficeSpreadsheetExtension(extension: string): boolean {
  switch (extension) {
    case "ods":
    case "xls":
    case "xlsb":
    case "xlsm":
    case "xlsx": {
      return true;
    }
    default: {
      return false;
    }
  }
}

function isOfficePresentationExtension(extension: string): boolean {
  switch (extension) {
    case "odp":
    case "pot":
    case "potm":
    case "potx":
    case "pps":
    case "ppsm":
    case "ppsx":
    case "ppt":
    case "pptm":
    case "pptx": {
      return true;
    }
    default: {
      return false;
    }
  }
}

/**
 * Returns the Office for the web family for formats Microsoft documents as
 * viewable. Formats that only open in the desktop apps, including Excel
 * templates and Office add-ins, intentionally remain on the generic fallback.
 */
export function officeFilePreviewKind(
  filename: string,
): OfficeFilePreviewKind | null {
  const extension = fileExtension(filename);
  if (extension === null) {
    return null;
  }
  if (isOfficeDocumentExtension(extension)) {
    return "document";
  }
  if (isOfficeSpreadsheetExtension(extension)) {
    return "spreadsheet";
  }
  if (isOfficePresentationExtension(extension)) {
    return "presentation";
  }
  return null;
}

export function isOfficeFilePreview(filename: string): boolean {
  return officeFilePreviewKind(filename) !== null;
}
