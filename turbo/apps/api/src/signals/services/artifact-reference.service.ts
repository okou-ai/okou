import { command, computed } from "ccstate";
import { z } from "zod";
import {
  artifactShareTargetSchema,
  type ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { env } from "../../lib/env";
import { artifactHash } from "../../lib/file-url";
import {
  readArtifactSharePolicyObject,
  writeArtifactSharePolicyObject,
} from "../external/s3";
import { settle } from "../utils";

const referenceRecordSchema = z.discriminatedUnion("version", [
  // Previously copied organization links keep following their share policy.
  z.object({ version: z.literal(1), shareId: z.uuid() }),
  z.object({ version: z.literal(2), target: artifactShareTargetSchema }),
]);

function referenceBucket(): string {
  const bucket = env("R2_HOSTED_SITES_BUCKET_NAME");
  if (!bucket) {
    throw new Error("Artifact reference storage is not configured");
  }
  return bucket;
}

function referenceKey(reference: string): string {
  return `artifact-references/${reference}.json`;
}

/** Immutable identity only; callers must authorize the recorded target. */
export function artifactReferenceRecord(
  reference: string,
  signal: AbortSignal,
) {
  return computed(async (get) => {
    const stored = await settle(
      get(
        readArtifactSharePolicyObject(
          referenceBucket(),
          referenceKey(reference),
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
    return referenceRecordSchema.parse(
      JSON.parse(stored.value.buffer.toString("utf8")),
    );
  });
}

/** Deterministic candidates and conditional creation make retries stable. */
export const allocateArtifactReference$ = command(
  async ({ get }, target: ArtifactShareTarget, signal: AbortSignal) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const reference = artifactHash(target.id, `${target.kind}:${attempt}`);
      const written = await settle(
        get(
          writeArtifactSharePolicyObject(
            referenceBucket(),
            referenceKey(reference),
            JSON.stringify({ version: 2, target }),
            null,
            signal,
          ),
        ),
        signal,
      );
      if (written.ok) {
        return reference;
      }
      if (
        !(written.error instanceof Error) ||
        written.error.name !== "PreconditionFailed"
      ) {
        throw written.error;
      }
      const existing = await get(artifactReferenceRecord(reference, signal));
      signal.throwIfAborted();
      if (
        existing?.version === 2 &&
        existing.target.kind === target.kind &&
        existing.target.id === target.id
      ) {
        return reference;
      }
    }
    throw new Error("Unable to allocate a unique artifact reference");
  },
);
