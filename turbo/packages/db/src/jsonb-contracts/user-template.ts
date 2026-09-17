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

export type UserTemplateManifest = UserTemplatePresentationManifest;
