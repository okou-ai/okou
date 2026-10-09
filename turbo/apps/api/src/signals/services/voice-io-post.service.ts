import { command } from "ccstate";
import { userBehaviorCount } from "@okouai/db/schema/user-behavior-count";
import { and, eq, inArray, sql } from "drizzle-orm";
import { parseBuffer } from "music-metadata";

import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { tapError } from "../utils";
import { sttDailyDurationKey, sttDailyRateKey } from "./voice-io-limits";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

export const MAX_STT_FILE_SIZE = 25 * 1024 * 1024;
const MAX_DURATION_READ_BYTES = 4096;
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;
const EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3] as const;

type ErrorStatus = 400 | 402 | 403 | 429 | 500 | 502 | 503;

interface ErrorBody {
  readonly error: {
    readonly message: string;
    readonly code: string;
  };
}

interface QuotaErrorBody extends ErrorBody {
  readonly quota: {
    readonly count: number;
    readonly limit: number | null;
  };
}

type ErrorResponse = {
  readonly status: ErrorStatus;
  readonly body: ErrorBody | QuotaErrorBody;
};

interface SttDailyPolicy {
  readonly rateKey: string;
  readonly durationKey: string;
  readonly durationSeconds: number;
}

interface WavFormat {
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
}

function errorBody(message: string, code: string): ErrorBody {
  return { error: { message, code } };
}

export function badRequest(message: string, code = "BAD_REQUEST") {
  return { status: 400 as const, body: errorBody(message, code) };
}

function quotaError(
  status: 402 | 429,
  message: string,
  code: string,
  count: number,
  limit: number | null,
) {
  return {
    status,
    body: {
      error: { message, code },
      quota: { count, limit },
    },
  };
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i++) {
    text += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return text;
}

function isRiffWav(bytes: Uint8Array): boolean {
  return readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WAVE";
}

function readSpeechWavFormat(
  view: DataView,
  chunkStart: number,
  byteLength: number,
): WavFormat | null {
  if (chunkStart + 16 > byteLength) {
    return null;
  }
  return {
    channels: view.getUint16(chunkStart + 2, true),
    sampleRate: view.getUint32(chunkStart + 4, true),
    bitsPerSample: view.getUint16(chunkStart + 14, true),
  };
}

function readStandardSpeechWavFormat(view: DataView): WavFormat {
  return {
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
  };
}

function hasUsableWavFormat(format: WavFormat): boolean {
  return (
    format.channels > 0 && format.sampleRate > 0 && format.bitsPerSample > 0
  );
}

function parseSpeechWavDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 44) {
    return null;
  }
  if (!isRiffWav(bytes)) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: WavFormat | null = null;
  let dataOffset: number | null = null;
  let dataChunkSize: number | null = null;
  let offset = 12;

  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkId === "fmt " && chunkSize >= 16) {
      format =
        readSpeechWavFormat(view, chunkStart, bytes.byteLength) ?? format;
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      dataChunkSize = chunkSize;
    }

    if (chunkEnd > bytes.byteLength) {
      break;
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  format = format ?? readStandardSpeechWavFormat(view);
  if (!hasUsableWavFormat(format)) {
    return null;
  }

  const remaining =
    dataOffset !== null ? bytes.byteLength - dataOffset : bytes.byteLength - 44;
  // Prefer the declared data-chunk size when it fits the buffer, so trailing
  // chunks after `data` (LIST/INFO/JUNK) are not counted as audio. Fall back to
  // the remaining bytes for oversized/placeholder/truncated sizes (streamed WAV).
  const audioBytes =
    dataChunkSize !== null && dataChunkSize > 0 && dataChunkSize <= remaining
      ? dataChunkSize
      : remaining;
  if (audioBytes <= 0) {
    return null;
  }

  const bytesPerSecond =
    format.sampleRate * format.channels * (format.bitsPerSample / 8);
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return null;
  }
  return audioBytes / bytesPerSecond;
}

// mp3 / mp4 / m4a / mpga: read the real container duration. Estimating from
// byte size assumes a bitrate and is wrong by the ratio of the real bitrate to
// the assumed one (a 64 kbps clip read against an 8 kbps assumption over-counts
// ~8x). Returns null when the duration cannot be determined.
async function parseCompressedAudioDurationSeconds(
  file: File,
): Promise<number | null> {
  const mimeType = file.type.split(";")[0] ?? file.type;
  const parsed = await tapError(
    parseBuffer(
      new Uint8Array(await file.arrayBuffer()),
      { mimeType, size: file.size },
      { duration: true },
    ),
  );
  if (!parsed) {
    return null;
  }
  const { duration } = parsed.format;
  return typeof duration === "number" ? duration : null;
}

function vintLen(firstByte: number): number | null {
  let mask = 0x80;
  for (let i = 1; i <= 8; i++) {
    if (firstByte & mask) {
      return i;
    }
    mask >>= 1;
  }
  return null;
}

function readVint(
  buf: Uint8Array,
  pos: number,
): { readonly value: number; readonly next: number } | null {
  if (pos >= buf.length) {
    return null;
  }
  const len = vintLen(buf[pos] ?? 0);
  if (len === null || pos + len > buf.length) {
    return null;
  }

  let value = (buf[pos] ?? 0) & ((1 << (8 - len)) - 1);
  for (let i = 1; i < len; i++) {
    value = (value << 8) | (buf[pos + i] ?? 0);
  }
  return { value, next: pos + len };
}

function readDurationFloat(
  buf: Uint8Array,
  valuePos: number,
  valueSize: number,
): number | null {
  if (valuePos + valueSize > buf.length) {
    return null;
  }
  const view = new DataView(buf.buffer, buf.byteOffset + valuePos, valueSize);
  let value: number;
  if (valueSize === 8) {
    value = view.getFloat64(0, false);
  } else if (valueSize === 4) {
    value = view.getFloat32(0, false);
  } else {
    return null;
  }
  if (Number.isNaN(value) || value < 0) {
    return null;
  }
  return value;
}

function readTimecodeScale(
  buf: Uint8Array,
  valuePos: number,
  valueSize: number,
): number | null {
  if (valuePos + valueSize > buf.length) {
    return null;
  }
  if (valueSize <= 0 || valueSize > 8) {
    return null;
  }
  let scale = 0;
  for (let i = 0; i < valueSize; i++) {
    scale = scale * 256 + (buf[valuePos + i] ?? 0);
  }
  return scale > 0 ? scale : null;
}

function findDurationInInfo(
  buf: Uint8Array,
  dataStart: number,
  dataLen: number,
): number | null {
  const end = Math.min(dataStart + dataLen, buf.length);
  let pos = dataStart;
  let durationInScale: number | null = null;
  let timecodeScaleNs = DEFAULT_TIMECODE_SCALE_NS;

  while (pos + 2 <= end) {
    const idLen = vintLen(buf[pos] ?? 0);
    if (idLen === null || pos + idLen > end) {
      return null;
    }
    const sizeResult = readVint(buf, pos + idLen);
    if (sizeResult === null) {
      return null;
    }

    const elemStart = pos;
    const valuePos = sizeResult.next;
    const valueSize = sizeResult.value;

    if (idLen === 2 && buf[elemStart] === 0x44 && buf[elemStart + 1] === 0x89) {
      const value = readDurationFloat(buf, valuePos, valueSize);
      if (value === null) {
        return null;
      }
      durationInScale = value;
    } else if (
      idLen === 3 &&
      buf[elemStart] === 0x2a &&
      buf[elemStart + 1] === 0xd7 &&
      buf[elemStart + 2] === 0xb1
    ) {
      const scale = readTimecodeScale(buf, valuePos, valueSize);
      if (scale !== null) {
        timecodeScaleNs = scale;
      }
    }

    pos = valuePos + Math.min(valueSize, buf.length - valuePos);
  }

  if (durationInScale === null) {
    return null;
  }
  return (durationInScale * timecodeScaleNs) / 1_000_000_000;
}

function findDurationInSegment(buf: Uint8Array, pos: number): number | null {
  while (pos + 2 <= buf.length) {
    const idLen = vintLen(buf[pos] ?? 0);
    if (idLen === null || pos + idLen > buf.length) {
      return null;
    }
    const sizeResult = readVint(buf, pos + idLen);
    if (sizeResult === null) {
      return null;
    }

    const elemStart = pos;
    const dataPos = sizeResult.next;
    const dataSize = sizeResult.value;

    if (
      idLen === 4 &&
      buf[elemStart] === 0x15 &&
      buf[elemStart + 1] === 0x49 &&
      buf[elemStart + 2] === 0xa9 &&
      buf[elemStart + 3] === 0x66
    ) {
      return findDurationInInfo(buf, dataPos, dataSize);
    }

    pos = dataPos + Math.min(dataSize, buf.length - dataPos);
  }
  return null;
}

function parseWebmDuration(buf: Uint8Array): number | null {
  if (buf.length < 12) {
    return null;
  }
  if (
    buf[0] !== EBML_HEADER[0] ||
    buf[1] !== EBML_HEADER[1] ||
    buf[2] !== EBML_HEADER[2] ||
    buf[3] !== EBML_HEADER[3]
  ) {
    return null;
  }

  let pos = 4;
  const ebmlSize = readVint(buf, pos);
  if (ebmlSize === null) {
    return null;
  }
  pos = ebmlSize.next + ebmlSize.value;

  if (pos + 4 > buf.length) {
    return null;
  }
  const segIdLen = vintLen(buf[pos] ?? 0);
  if (segIdLen === null || segIdLen !== 4) {
    return null;
  }
  pos += segIdLen;
  const segSizeLen = readVint(buf, pos);
  if (segSizeLen === null) {
    return null;
  }
  pos = segSizeLen.next;

  return findDurationInSegment(buf, pos);
}

export async function getAudioDuration(file: File): Promise<number | null> {
  const mimeType = file.type.split(";")[0] ?? file.type;

  if (
    mimeType === "audio/wav" ||
    mimeType === "audio/wave" ||
    mimeType === "audio/x-wav"
  ) {
    // Walk the RIFF chunk chain over the whole file. ffmpeg-produced WAV is not
    // guaranteed to place the data chunk at a fixed offset (it can insert
    // LIST/INFO/JUNK chunks), so a fixed-offset header read mis-measures it.
    return parseSpeechWavDurationSeconds(
      new Uint8Array(await file.arrayBuffer()),
    );
  }
  if (mimeType === "audio/webm") {
    const head = new Uint8Array(
      await file
        .slice(0, Math.min(file.size, MAX_DURATION_READ_BYTES))
        .arrayBuffer(),
    );
    return parseWebmDuration(head);
  }
  return parseCompressedAudioDurationSeconds(file);
}

export const sttDailyPolicy$ = command(
  async (
    { get },
    orgId: string,
    userId: string,
    durationSeconds: number,
    signal: AbortSignal,
  ): Promise<SttDailyPolicy | ErrorResponse> => {
    const db = get(db$);
    const currentDate = nowDate();
    const rateKey = sttDailyRateKey(currentDate);
    const durationKey = sttDailyDurationKey(currentDate);
    const capabilities = await loadOrgPlanCapabilities(db, orgId);
    signal.throwIfAborted();
    const rateLimit = capabilities?.audioDailyRateLimit ?? 0;
    const durationLimit = capabilities?.audioDailyDurationSeconds ?? 0;
    const behaviorRows = await db
      .select({
        key: userBehaviorCount.behaviorKey,
        count: userBehaviorCount.count,
      })
      .from(userBehaviorCount)
      .where(
        and(
          eq(userBehaviorCount.orgId, orgId),
          eq(userBehaviorCount.userId, userId),
          inArray(userBehaviorCount.behaviorKey, [rateKey, durationKey]),
        ),
      );
    signal.throwIfAborted();

    const counts = new Map(
      behaviorRows.map((row): readonly [string, number] => {
        return [row.key, row.count];
      }),
    );
    const rateCount = counts.get(rateKey) ?? 0;
    if (rateCount >= rateLimit) {
      return quotaError(
        429,
        "Daily request rate limit exceeded",
        "DAILY_RATE_LIMIT_EXCEEDED",
        rateCount,
        rateLimit,
      );
    }

    const dailyDurationSeconds = counts.get(durationKey) ?? 0;
    if (dailyDurationSeconds + durationSeconds > durationLimit) {
      return quotaError(
        429,
        "Daily audio duration limit exceeded",
        "DAILY_DURATION_LIMIT_EXCEEDED",
        dailyDurationSeconds,
        durationLimit,
      );
    }

    return {
      rateKey,
      durationKey,
      durationSeconds,
    };
  },
);

export const recordSttUsage$ = command(
  async (
    { set },
    params: SttDailyPolicy & {
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await Promise.all([
      writeDb
        .insert(userBehaviorCount)
        .values({
          orgId: params.orgId,
          userId: params.userId,
          behaviorKey: params.rateKey,
          count: 1,
        })
        .onConflictDoUpdate({
          target: [
            userBehaviorCount.orgId,
            userBehaviorCount.userId,
            userBehaviorCount.behaviorKey,
          ],
          set: {
            count: sql`${userBehaviorCount.count} + 1`,
            lastAt: sql`now()`,
          },
        }),
      writeDb
        .insert(userBehaviorCount)
        .values({
          orgId: params.orgId,
          userId: params.userId,
          behaviorKey: params.durationKey,
          count: params.durationSeconds,
        })
        .onConflictDoUpdate({
          target: [
            userBehaviorCount.orgId,
            userBehaviorCount.userId,
            userBehaviorCount.behaviorKey,
          ],
          set: {
            count: sql`${userBehaviorCount.count} + ${params.durationSeconds}`,
            lastAt: sql`now()`,
          },
        }),
    ]);
    signal.throwIfAborted();
  },
);
