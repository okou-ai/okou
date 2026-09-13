/** Mount-independent discovery data derived from an immutable Storage archive. */
export type PiDiscoveryText =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "invalid_utf8" };

export type PiDiscoverySkill =
  | {
      readonly kind: "skill";
      readonly name?: string;
      readonly description?: string;
      readonly disableModelInvocation?: boolean;
    }
  | { readonly kind: "invalid_utf8" | "invalid_frontmatter" };

export interface PiResourceIndexFile {
  readonly path: string;
  readonly text?: PiDiscoveryText;
  readonly skill?: PiDiscoverySkill;
}

export interface PiResourceVersionIndex {
  readonly schemaVersion: 1;
  /** Preserve TAR entry order, including duplicate paths. */
  readonly files: readonly PiResourceIndexFile[];
}
