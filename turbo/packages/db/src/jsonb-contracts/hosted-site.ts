import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

export interface HostedSiteManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly immutable?: boolean;
}

/** Server-collected metadata; older deployments acquire it on first share. */
export interface HostedSiteSnapshotDependencies {
  readonly version: 1;
  readonly sourceManifestHash: string;
  readonly status: "complete" | "too-large";
  readonly files: Readonly<
    Record<
      string,
      {
        readonly etag: string;
        readonly sha256: string;
        readonly size: number;
        readonly references: readonly string[];
      }
    >
  >;
}

export interface HostedSiteManifest {
  readonly version: 1;
  readonly access?: "owner-private-v1";
  readonly publicBrand?: PublicBrand;
  readonly deploymentId: string;
  readonly siteId: string;
  readonly site?: string;
  readonly publicSlug: string;
  readonly deploymentVersion?: number;
  readonly createdAt: string;
  readonly artifactKind?: "hosted-site" | "presentation-html";
  readonly spaFallback: boolean;
  readonly files: Record<string, HostedSiteManifestFile>;
  readonly snapshotDependencies?: HostedSiteSnapshotDependencies;
}
