import { command, computed } from "ccstate";
import { artifactShareReferencePath } from "@okouai/api-contracts/contracts/artifact-references";
import {
  sharedThreadArtifactPolicyKey,
  sharedThreadArtifactPolicySchema,
} from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import { nowDate } from "../../lib/time";
import { env } from "../../lib/env";
import {
  generateArtifactPreviewUrl,
  generateHostedSitesPresignedGetUrl,
  readArtifactSharePolicyObject,
} from "../external/s3";
import { settle } from "../utils";
import { sharedThreadHostedSnapshotFile } from "../../lib/shared-thread-artifact";
import type { SharedThreadArtifactReference } from "./artifact-reference.service";
import { createHostedPreviewGrant$ } from "./private-hosted-preview.service";
import { privateArtifactsBucket } from "./private-artifact-storage.service";
import { sharedThreadArtifactsBucket } from "./shared-thread-artifact-snapshot.service";

/** Snapshot authority is independent of the original resource's current state. */
function sharedThreadArtifactSnapshot(
  reference: SharedThreadArtifactReference,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    const stored = await settle(
      get(
        readArtifactSharePolicyObject(
          sharedThreadArtifactsBucket(),
          sharedThreadArtifactPolicyKey(
            reference.publicBrand,
            reference.threadId,
          ),
          signal,
        ),
      ),
      signal,
    );
    if (!stored.ok) {
      if (stored.error instanceof Error && stored.error.name === "NoSuchKey") {
        return null;
      }
      throw stored.error;
    }
    const policy = sharedThreadArtifactPolicySchema.parse(
      JSON.parse(stored.value.buffer.toString("utf8")),
    );
    if (
      policy.threadId !== reference.threadId ||
      policy.publicBrand !== reference.publicBrand ||
      policy.status !== "active"
    ) {
      return null;
    }
    const target = policy.resources[reference.publicToken];
    if (
      !target ||
      target.kind !== reference.target.kind ||
      target.id !== reference.target.id
    ) {
      return null;
    }
    const previewImage = policy.previews?.[reference.publicToken];
    const previewTarget = previewImage
      ? policy.resources[previewImage.token]
      : undefined;
    const previewImageUrl =
      previewImage && previewTarget?.kind === "file"
        ? new URL(
            artifactShareReferencePath(
              previewImage.reference,
              previewTarget.filename,
            ),
            env("APP_URL"),
          ).href
        : undefined;
    return { target, previewImageUrl };
  });
}

export function sharedThreadArtifactTarget(
  reference: SharedThreadArtifactReference,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    const snapshot = await get(sharedThreadArtifactSnapshot(reference, signal));
    signal.throwIfAborted();
    return snapshot?.target ?? null;
  });
}

export const resolveSharedThreadArtifactReference$ = command(
  async (
    { get, set },
    reference: SharedThreadArtifactReference,
    signal: AbortSignal,
  ) => {
    const snapshot = await get(sharedThreadArtifactSnapshot(reference, signal));
    signal.throwIfAborted();
    if (!snapshot) {
      return null;
    }
    const { target, previewImageUrl } = snapshot;
    if (target.kind === "file") {
      const signingDate = nowDate();
      const [preview, download] = await Promise.all([
        get(
          generateArtifactPreviewUrl(privateArtifactsBucket(), target.key, {
            signingDate,
          }),
        ),
        get(
          generateArtifactPreviewUrl(privateArtifactsBucket(), target.key, {
            signingDate,
            filename: target.filename,
          }),
        ),
      ]);
      signal.throwIfAborted();
      return {
        ...preview,
        downloadUrl: download.url,
        filename: target.filename,
        contentType: target.contentType,
        ...(previewImageUrl ? { previewImageUrl } : {}),
        sharedThreadSnapshot: true as const,
        target: { kind: target.kind, id: target.id },
      };
    }
    const file = sharedThreadHostedSnapshotFile(target, reference.previewPath);
    if (!file) {
      return null;
    }
    const preview = await set(
      createHostedPreviewGrant$,
      {
        deploymentId: target.id,
        publicBrand: reference.publicBrand,
        snapshotId: target.snapshotId,
      },
      signal,
    );
    const filename = file.path.slice(file.path.lastIndexOf("/") + 1);
    const downloadUrl = await get(
      generateHostedSitesPresignedGetUrl(
        sharedThreadArtifactsBucket(),
        `shared-artifacts/${reference.publicBrand}/${target.snapshotId}/${target.id}${file.path}`,
        true,
        { signingDate: nowDate(), filename },
      ),
    );
    signal.throwIfAborted();
    return {
      ...preview,
      downloadUrl,
      ...(reference.previewPath
        ? { url: new URL(reference.previewPath, preview.url).href }
        : {}),
      filename,
      contentType: file.contentType,
      ...(previewImageUrl ? { previewImageUrl } : {}),
      sharedThreadSnapshot: true as const,
      target: { kind: target.kind, id: target.id },
    };
  },
);
