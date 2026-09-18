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
 * package. It renders no pages, so it stores none: the arm carries the
 * discriminant alone rather than an empty array that would read as a template
 * whose pages went missing.
 */
export interface UserTemplateDocumentManifest {
  readonly kind: "document";
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
