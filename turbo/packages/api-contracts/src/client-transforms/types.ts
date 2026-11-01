export interface ClientResponseTransform {
  readonly client: "desktop" | "ios";
  /** Contract method and path, e.g. "POST" and "/api/computer-use/hosts/register". */
  readonly method: string;
  readonly path: string;
  /** The 2xx status whose body is transformed. */
  readonly status: number;
  /**
   * Highest client version that still receives the transformed (old) shape;
   * selection is inclusive, so a version v receives it when v <= maxVersion.
   * null means every currently published client. The client PR that adopts
   * the new shape sets it to the last version that still decodes the old
   * shape, which is the version just before that PR's release.
   */
  readonly maxVersion: string | null;
  /** The PR that introduced the transform, e.g. "#38750". */
  readonly since: string;
  /** Renders the current contract body as the shape clients up to maxVersion expect. */
  readonly transform: (body: unknown) => unknown;
}
