import { enum as zEnum } from "zod";
import { command } from "ccstate";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { files } from "@okouai/db/schema/file";
import {
  MAX_TOTAL_AUDIO_BYTES,
  MAX_VOICE_CLIPS,
} from "@okouai/api-contracts/contracts/voice-clips";
import { badRequestMessage, notFound } from "../../lib/error";
import { db$ } from "../external/db";
import { downloadS3BufferWithMaxBytes$ } from "../external/s3";
import {
  privateArtifactFromRow,
  readPrivateAttachmentRows,
  type PrivateAttachmentRow,
} from "./private-artifact-storage.service";

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

type VoiceClipRequest = {
  readonly orgId: string;
  readonly userId: string;
  readonly fileIds: readonly string[];
};

interface ResolvedVoiceClip {
  readonly bucket: string;
  readonly key: string;
  readonly size: number;
  readonly mimeType: string;
}

export function voiceClipRequestError(fileIds: readonly string[]) {
  if (fileIds.length > MAX_VOICE_CLIPS) {
    return badRequestMessage("Too many voice clips");
  }
  return null;
}

export function resolveVoiceClipRecords(
  args: VoiceClipRequest,
  records: ReadonlyMap<string, PrivateAttachmentRow>,
) {
  const clips: ResolvedVoiceClip[] = [];
  let total = 0;
  for (const id of args.fileIds) {
    const row = records.get(id.toLowerCase());
    const record =
      row?.userId === args.userId && row.orgId === args.orgId
        ? privateArtifactFromRow(row)
        : null;
    const size = record?.sizeBytes;
    if (
      !record ||
      !record.isReady ||
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
}

export const resolveVoiceClips$ = command(
  async ({ get }, args: VoiceClipRequest, signal: AbortSignal) => {
    signal.throwIfAborted();
    const error = voiceClipRequestError(args.fileIds);
    if (error) {
      return error;
    }
    const ids = args.fileIds.map((id) => {
      return id.toLowerCase();
    });
    const rows = await readPrivateAttachmentRows(
      get(db$),
      and(
        eq(files.orgId, args.orgId),
        eq(files.ownerUserId, args.userId),
        isNull(files.deletedAt),
        inArray(files.id, ids),
      ),
    );
    signal.throwIfAborted();
    const records = new Map(
      rows.map((row) => {
        return [row.id, row];
      }),
    );
    return resolveVoiceClipRecords(args, records);
  },
);

export const loadVoiceClipAudio$ = command(
  async ({ set }, clips: readonly ResolvedVoiceClip[], signal: AbortSignal) => {
    const audio = [];
    for (const clip of clips) {
      const bytes = await set(
        downloadS3BufferWithMaxBytes$,
        { ...clip, maxBytes: clip.size },
        signal,
      );
      if (bytes.length !== clip.size) {
        throw new Error("Private audio size changed");
      }
      audio.push({ data: bytes.toString("base64"), mimeType: clip.mimeType });
    }
    signal.throwIfAborted();
    return audio;
  },
);
