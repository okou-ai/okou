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

export type UserTemplateManifest =
  | UserTemplatePresentationManifest
  | UserTemplateDocumentManifest;
