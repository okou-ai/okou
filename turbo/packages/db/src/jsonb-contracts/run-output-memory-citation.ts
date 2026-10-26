/** Persisted shape retained for API versions that still write this table. */
export interface RunOutputMemoryCitation {
  readonly entries: readonly {
    readonly path: string;
    readonly lineStart: number;
    readonly lineEnd: number;
    readonly note: string;
  }[];
  readonly rolloutIds: readonly string[];
}
