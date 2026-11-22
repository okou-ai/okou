export interface MemberMemoryOwner {
  readonly orgId: string;
  readonly userId: string;
}

export function memberMemoryMergeVersions(
  capturedVersionId: string,
  headVersionId: string | null,
): readonly [string, string] {
  if (!headVersionId) {
    throw new Error("Memory has no HEAD version");
  }
  return [capturedVersionId, headVersionId];
}

type MemberMemorySnapshotSource =
  | { readonly versionId: string; readonly empty: true }
  | {
      readonly versionId: string;
      readonly empty: false;
      readonly manifestKey: string;
      readonly archiveKey: string;
    };

/** Resolve logical empty revisions without requiring an archive object. */
export function memberMemorySnapshotSource(args: {
  readonly objectPrefix: string;
  readonly versionId: string;
  readonly revision:
    { readonly objectPrefix: string; readonly fileCount: number } | undefined;
}): MemberMemorySnapshotSource {
  const { revision, versionId } = args;
  if (
    !revision ||
    revision.objectPrefix !== `${args.objectPrefix}/${versionId}`
  ) {
    throw new Error("Memory merge version is unavailable");
  }
  return revision.fileCount === 0
    ? { versionId, empty: true }
    : {
        versionId,
        empty: false,
        manifestKey: `${revision.objectPrefix}/manifest.json`,
        archiveKey: `${revision.objectPrefix}/archive.tar.gz`,
      };
}
