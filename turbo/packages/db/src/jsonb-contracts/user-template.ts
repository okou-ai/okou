/**
 * What a reverse run produced for one user template, beyond the compiled
 * package itself.
 *
 * Discriminated on `kind` so a second template kind adds an arm instead of
 * turning this into a bag of optional fields whose valid combinations are
 * undocumented. The discriminant lives in the value rather than in a column
 * because decoding needs it and no query filters by it; the day one does, it
 * becomes a column and this stays the shape it names.
 */
export interface UserTemplatePresentationManifest {
  readonly kind: "presentation";
  /**
   * Private artifact object keys for the rendered page images. Array position
   * is the page number and element 0 is the cover, so the page count is the
   * array length and never a stored field.
   */
  readonly pageKeys: readonly string[];
}

/**
 * A document template is the styles the reverse run extracted into its
 * package. It renders no pages, so it stores none — there is no `pageKeys`
 * here, and an empty array would read as a template whose pages went missing.
 *
 * What it does store is one picture of the source's first page, so the catalog
 * can show the document rather than the icon of its file format, and how long
 * that source was.
 *
 * Both are optional and independently so, because a reverse run that cannot
 * render the first page still publishes a usable template: the catalog names
 * that row by its file, which is what it does for every template with no
 * cover. A row with a cover and no count is one the run could draw but not
 * count. Storing the count rather than the "has more pages" boolean the
 * catalog reads keeps the answer to a question nobody has asked yet — how long
 * was it — out of a second reverse run.
 */
export interface UserTemplateDocumentManifest {
  readonly kind: "document";
  /** Private artifact object key for the rendered first page. */
  readonly coverKey?: string;
  /** How many pages the source file had, not how many this template renders. */
  readonly pageCount?: number;
}

/**
 * An illustration template is a style, and what the catalog shows for it is
 * the picture it was reversed from. That file is already on the row as
 * `source_storage_key`, so this arm carries the discriminant alone: repeating
 * the key here would give one object two places to say where the cover is.
 */
export interface UserTemplateIllustrationManifest {
  readonly kind: "illustration";
}

export type UserTemplateManifest =
  | UserTemplatePresentationManifest
  | UserTemplateDocumentManifest
  | UserTemplateIllustrationManifest;
