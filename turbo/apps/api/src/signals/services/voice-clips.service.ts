import { enum as zEnum } from "zod";
import { command } from "ccstate";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { MAX_VOICE_CLIPS } from "@okouai/api-contracts/contracts/voice-clips";
import {
  badRequestMessage,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { db$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { privateArtifactFromRow } from "./private-artifact-storage.service";

export const MAX_TOTAL_AUDIO_BYTES = 25 * 1024 * 1024;
const audioTypes = zEnum([
  "audio/wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/ogg",
  "audio/flac",
  "audio/webm",
  "audio/x-aac",
]);

export const resolveVoiceClips$ = command(
  async (
    { get, set },
    args: { orgId: string; userId: string; fileIds: readonly string[] },
    signal: AbortSignal,
  ) => {
    const context = await set(
      loadUserFeatureSwitchContext$,
      args.orgId,
      args.userId,
      signal,
    );
    if (!isFeatureEnabled(FeatureSwitchKey.VoiceMessages, context)) {
      return resourceUnavailable("Voice messages are disabled");
    }
    if (args.fileIds.length > MAX_VOICE_CLIPS) {
      return badRequestMessage("Too many voice clips");
    }
    const ids = args.fileIds.map((id) => {
      return id.toLowerCase();
    });
    const rows = await get(db$)
      .select()
      .from(runUploadedFiles)
      .where(
        and(
          eq(runUploadedFiles.orgId, args.orgId),
          eq(runUploadedFiles.userId, args.userId),
          isNull(runUploadedFiles.deletedAt),
          inArray(runUploadedFiles.id, ids),
        ),
      );
    signal.throwIfAborted();
    const records = new Map(
      rows.map((row) => {
        return [row.id, row];
      }),
    );
    const clips = [];
    let total = 0;
    for (const id of ids) {
      const row = records.get(id);
      const record = privateArtifactFromRow(row);
      const size = record?.sizeBytes;
      if (
        !record ||
        record.materializationStatus !== "ready" ||
        !size ||
        size < 0 ||
        !Number.isSafeInteger(size)
      ) {
        return notFound("Private audio clip not found or upload incomplete");
      }
      const mimeType =
        record.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
      if (!audioTypes.safeParse(mimeType).success) {
        return badRequestMessage("Unsupported audio content type");
      }
      total += size;
      if (total > MAX_TOTAL_AUDIO_BYTES) {
        return badRequestMessage("Voice clips exceed 25 MiB in total");
      }
      clips.push({ bucket: record.bucket, key: record.key, size, mimeType });
    }
    return { clips };
  },
);
