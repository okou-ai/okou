import { command } from "ccstate";
import {
  sharedThreadArtifactPolicyKey,
  sharedThreadArtifactPolicySchema,
} from "@okouai/api-contracts/contracts/shared-thread-artifacts";
import { nowDate } from "../../lib/time";
import {
  generateArtifactPreviewUrl,
  readArtifactSharePolicyObject,
} from "../external/s3";
import { settle } from "../utils";
import { sharedThreadHostedSnapshotFile } from "../../lib/shared-thread-artifact";
import type { SharedThreadArtifactReference } from "./artifact-reference.service";
import { createHostedPreviewGrant$ } from "./private-hosted-preview.service";
import { privateArtifactsBucket } from "./private-artifact-storage.service";
import { sharedThreadArtifactsBucket } from "./shared-thread-artifact-snapshot.service";

/** Snapshot authority is independent of the original resource's current state. */
export const resolveSharedThreadArtifactReference$ = command(
  async (
    { get, set },
    reference: SharedThreadArtifactReference,
    signal: AbortSignal,
  ) => {
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
    if (target.kind === "file") {
      const preview = await get(
        generateArtifactPreviewUrl(privateArtifactsBucket(), target.key, {
          signingDate: nowDate(),
        }),
      );
      signal.throwIfAborted();
      return {
        ...preview,
        filename: target.filename,
        contentType: target.contentType,
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
        publicBrand: policy.publicBrand,
        snapshotId: target.snapshotId,
      },
      signal,
    );
    return {
      ...preview,
      ...(reference.previewPath
        ? { url: new URL(reference.previewPath, preview.url).href }
        : {}),
      filename: file.path.slice(file.path.lastIndexOf("/") + 1),
      contentType: file.contentType,
      sharedThreadSnapshot: true as const,
      target: { kind: target.kind, id: target.id },
    };
  },
);
