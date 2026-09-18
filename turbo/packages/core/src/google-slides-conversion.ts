/**
 * Google Slides conversion targets for presentation artifacts.
 *
 * Drive converts an upload to a native Google editor format when the file
 * metadata asks for one, so the only thing this module decides is which
 * source formats may make that request. The platform menu and the API sync
 * service both import it: if they disagreed, the menu would offer "Upload to
 * Google Slides" for a file the service then stored as a plain attachment.
 */

export const GOOGLE_SLIDES_MIME_TYPE =
  "application/vnd.google-apps.presentation";

/**
 * OOXML presentation extensions only.
 *
 * The legacy binary family (.ppt/.pps/.pot) is deliberately absent. Drive
 * accepts those uploads and answers HTTP 200, but the resulting deck has no
 * page elements at all — a silent blank conversion. The same content routed
 * through OOXML converts with every element intact, so the binary formats
 * need a normalization step this service does not have.
 */
const SLIDES_CONVERTIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "potm",
  "potx",
  "ppsm",
  "ppsx",
  "pptm",
  "pptx",
]);

function fileExtension(filename: string): string | null {
  const name = filename.split(/[?#]/u, 1)[0]?.toLowerCase();
  const extension = name?.split(".").pop();
  if (!extension || extension === name) {
    return null;
  }
  return extension;
}

/** Whether syncing this artifact may ask Drive for a native Slides deck. */
export function convertsToGoogleSlides(filename: string): boolean {
  const extension = fileExtension(filename);
  return extension !== null && SLIDES_CONVERTIBLE_EXTENSIONS.has(extension);
}
