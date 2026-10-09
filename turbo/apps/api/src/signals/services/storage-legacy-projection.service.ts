import type { ContextArtifact, PersistedStorageMount } from "@okouai/db/types";
import { SYSTEM_ORG_ID } from "@okouai/core/storage-names";

interface LegacyVolumeVersionsSnapshot {
  readonly versions: Record<string, string>;
}

interface RunStorageProjection {
  readonly artifactSnapshots: readonly ContextArtifact[] | null;
  readonly artifactVersions: Record<string, string> | null;
  readonly volumeVersionsSnapshot: LegacyVolumeVersionsSnapshot | null;
}

export function projectLegacyWritebackArtifacts(
  mounts: readonly PersistedStorageMount[],
): readonly ContextArtifact[] {
  return mounts.flatMap((mount) => {
    if (!mount.writeback) {
      return [];
    }
    return [
      {
        name: mount.name,
        ...(mount.version === undefined ? {} : { version: mount.version }),
        mountPath: mount.mountPath,
        ...(mount.missingRootPolicy === undefined
          ? {}
          : { missingRootPolicy: mount.missingRootPolicy }),
      },
    ];
  });
}

/**
 * Projects launch mounts and writeback outputs into the existing Run result shape.
 */
export function projectRunStorage(
  mounts: readonly PersistedStorageMount[],
): RunStorageProjection {
  const artifactSnapshots: ContextArtifact[] = [];
  const artifactVersions: Record<string, string> = {};
  const volumeVersions: Record<string, string> = {};

  for (const mount of mounts) {
    if (mount.version === undefined) {
      throw new Error(`Invalid Run Storage "${mount.name}": missing version`);
    }
    if (mount.writeback) {
      artifactSnapshots.push({
        name: mount.name,
        version: mount.version,
        mountPath: mount.mountPath,
        ...(mount.missingRootPolicy === undefined
          ? {}
          : { missingRootPolicy: mount.missingRootPolicy }),
      });
      artifactVersions[mount.name] = mount.version;
      continue;
    }
    // Run-result payloads reported user volume state,
    // not internal system Storage or resolved instruction mounts.
    if (
      mount.orgId === SYSTEM_ORG_ID ||
      mount.instructionsTargetFilename !== undefined
    ) {
      continue;
    }
    volumeVersions[mount.name] = mount.version;
  }

  return {
    artifactSnapshots:
      artifactSnapshots.length === 0 ? null : artifactSnapshots,
    artifactVersions:
      Object.keys(artifactVersions).length === 0 ? null : artifactVersions,
    volumeVersionsSnapshot:
      Object.keys(volumeVersions).length === 0
        ? null
        : { versions: volumeVersions },
  };
}
