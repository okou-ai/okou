export interface ClientResponseTransform {
  readonly client: "desktop";
  /** Contract method and path, e.g. "POST" and "/api/computer-use/hosts/register". */
  readonly method: string;
  readonly path: string;
  /** The 2xx status whose body is transformed. */
  readonly status: number;
  /**
   * Highest Desktop version that still receives the transformed (old) shape.
   * null means every currently published Desktop; the Desktop PR that adopts
   * the new shape sets it to the first version that reads the new shape.
   */
  readonly maxVersion: string | null;
  /** The PR that introduced the transform, e.g. "#38750". */
  readonly since: string;
  /** Renders the current contract body as the shape clients up to maxVersion expect. */
  readonly transform: (body: unknown) => unknown;
}
