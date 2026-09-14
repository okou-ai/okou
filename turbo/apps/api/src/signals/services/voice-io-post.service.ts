import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { command, computed, type Computed } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { userBehaviorCount } from "@okouai/db/schema/user-behavior-count";
import { and, eq, inArray, sql } from "drizzle-orm";
import { parseBuffer } from "music-metadata";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import {
  resolveUsagePricingProvider,
  usagePricingResolution$,
} from "../context/usage-pricing-resolution";
import { db$, writeDb$ } from "../external/db";
import { checkBillableOperationCredits$ } from "./billable-operation-admission.service";
import { nowDate } from "../../lib/time";
import { tapError } from "../utils";
import { storeGeneratedArtifactObject$ } from "./artifact-storage.service";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import {
  AUDIO_INPUT_BEHAVIOR_KEY,
  sttDailyDurationKey,
  sttDailyRateKey,
} from "./voice-io-limits";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

const L = logger("VoiceIoPost");

export const OPENAI_AUDIO_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const BYTEPLUS_ASR_FLASH_URL =
  "https://byteplus-proxy.vm0.ai/api/v3/auc/bigmodel/recognize/flash";
const BYTEPLUS_ASR_RESOURCE_ID = "volc.seedasr.auc_turbo";
const BYTEPLUS_ASR_MODEL = "bigmodel";
const BYTEPLUS_ERROR_BODY_LOG_MAX_LENGTH = 4000;
export const VOICE_IO_TTS_MODEL = "gpt-4o-mini-tts";
const SPEECH_CONTENT_TYPE = "audio/wav";
export const SPEECH_RESPONSE_FORMAT = "wav";
export const SPEECH_MAX_INPUT_TOKENS = 2000;
export const MAX_STT_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_STT_REQUEST_DURATION_SECONDS = 5 * 60;

const USAGE_KIND = "audio";
const USAGE_PROVIDER = VOICE_IO_TTS_MODEL;
const USAGE_CATEGORY = "output_audio_seconds";
const MAX_DURATION_READ_BYTES = 4096;
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;
const EBML_HEADER = [0x1a, 0x45, 0xdf, 0xa3] as const;

const ALLOWED_STT_MIME_TYPES = [
  "audio/webm",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/mpga",
] as const;

const SPEECH_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;

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

interface VoiceInputSttSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface VoiceInputSttTranscript {
  readonly text: string;
  readonly segments?: readonly VoiceInputSttSegment[];
}

type VoiceInputSttProviderResult = VoiceInputSttTranscript | ErrorResponse;

interface BytePlusSttAttempt {
  readonly response: Response;
  readonly requestId: string;
  readonly providerStatus: string | null;
  readonly providerDurationMs: number;
  readonly attempt: number;
}

interface SttDailyPolicy {
  readonly recordLifetimeUsage: boolean;
  readonly rateKey: string;
  readonly durationKey: string;
  readonly durationSeconds: number;
}

export interface SpeechPricing {
  readonly unitPrice: number;
  readonly unitSize: number;
}

interface RecordedSpeech {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
  readonly durationSeconds: number;
  readonly creditsCharged: number;
  readonly model: string;
  readonly voice: string;
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

export function internalError(message: string) {
  return {
    status: 500 as const,
    body: errorBody(message, "INTERNAL_SERVER_ERROR"),
  };
}

export function badGateway(message: string, code: string) {
  return { status: 502 as const, body: errorBody(message, code) };
}

export function serviceUnavailable(message: string, code: string) {
  return { status: 503 as const, body: errorBody(message, code) };
}

export function insufficientCredits() {
  return {
    status: 402 as const,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bytePlusAudioFormatForKey(value: string): string | undefined {
  if (isBytePlusWavFormat(value)) {
    return "wav";
  }
  if (isBytePlusMp3Format(value)) {
    return "mp3";
  }
  if (isBytePlusOggFormat(value)) {
    return "ogg";
  }
  if (isBytePlusWebmFormat(value)) {
    return "webm";
  }
  if (isBytePlusM4aFormat(value)) {
    return "m4a";
  }
  return undefined;
}

function isBytePlusWavFormat(value: string): boolean {
  return (
    value === "audio/wav" ||
    value === "audio/wave" ||
    value === "audio/x-wav" ||
    value === "wav"
  );
}

function isBytePlusMp3Format(value: string): boolean {
  return (
    value === "audio/mpeg" ||
    value === "audio/mp3" ||
    value === "audio/mpga" ||
    value === "mp3" ||
    value === "mpga" ||
    value === "mpeg"
  );
}

function isBytePlusOggFormat(value: string): boolean {
  return value === "audio/ogg" || value === "ogg";
}

function isBytePlusWebmFormat(value: string): boolean {
  return value === "audio/webm" || value === "webm";
}

function isBytePlusM4aFormat(value: string): boolean {
  return (
    value === "audio/mp4" ||
    value === "audio/m4a" ||
    value === "audio/x-m4a" ||
    value === "mp4" ||
    value === "m4a"
  );
}

function bytePlusAudioFormat(file: File): string {
  const baseMimeType = file.type.split(";")[0]?.toLowerCase() ?? file.type;
  const extension = file.name.toLowerCase().split(".").pop();
  const mimeFormat = bytePlusAudioFormatForKey(baseMimeType);
  if (mimeFormat) {
    return mimeFormat;
  }

  if (extension) {
    return bytePlusAudioFormatForKey(extension) ?? extension;
  }
  return "raw";
}

function bytePlusAudioCodec(file: File): string | undefined {
  const mimeType = file.type.toLowerCase();
  if (mimeType.includes("opus") || mimeType.startsWith("audio/webm")) {
    return "opus";
  }
  return undefined;
}

async function providerErrorBodyForLog(
  response: Response,
): Promise<string | undefined> {
  const body = await tapError(response.text());
  if (!body) {
    return undefined;
  }
  return body.length > BYTEPLUS_ERROR_BODY_LOG_MAX_LENGTH
    ? `${body.slice(0, BYTEPLUS_ERROR_BODY_LOG_MAX_LENGTH)}...`
    : body;
}

function bytePlusTranscriptionStatus(response: Response): string | null {
  return (
    response.headers.get("x-api-status-code") ??
    response.headers.get("X-Api-Status-Code")
  );
}

function isBytePlusTranscriptionSuccessStatus(
  providerStatus: string | null,
): boolean {
  return (
    providerStatus === null ||
    providerStatus === "20000000" ||
    providerStatus === "20000003"
  );
}

function isRetryableBytePlusStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

async function sendBytePlusSttRequest(
  apiKey: string,
  requestBody: string,
  signal: AbortSignal,
  attempt: number,
): Promise<BytePlusSttAttempt> {
  const requestId = randomUUID();
  const providerRequestStartedAt = performance.now();
  const response = await fetch(BYTEPLUS_ASR_FLASH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": BYTEPLUS_ASR_RESOURCE_ID,
      "X-Api-Request-Id": requestId,
      "X-Api-Sequence": "-1",
    },
    body: requestBody,
    signal,
  });
  signal.throwIfAborted();

  const providerStatus = bytePlusTranscriptionStatus(response);
  const providerDurationMs = Math.round(
    performance.now() - providerRequestStartedAt,
  );
  L.debug("BytePlus STT response received", {
    requestId,
    attempt,
    status: response.status,
    statusText: response.statusText,
    providerStatus,
    providerDurationMs,
  });
  return {
    response,
    requestId,
    providerStatus,
    providerDurationMs,
    attempt,
  };
}

function isBytePlusTranscriptionBody(value: unknown): value is {
  readonly result: {
    readonly text: string;
    readonly utterances?: readonly unknown[];
  };
} {
  return (
    isRecord(value) &&
    isRecord(value.result) &&
    typeof value.result.text === "string"
  );
}

function isBytePlusUtterance(value: unknown): value is {
  readonly start_time: number;
  readonly end_time: number;
  readonly text: string;
} {
  return (
    isRecord(value) &&
    typeof value.start_time === "number" &&
    typeof value.end_time === "number" &&
    typeof value.text === "string"
  );
}

function bytePlusSegments(
  utterances: readonly unknown[] | undefined,
): readonly VoiceInputSttSegment[] | undefined {
  if (!utterances) {
    return undefined;
  }
  return utterances.filter(isBytePlusUtterance).map((utterance) => {
    return {
      start: utterance.start_time / 1000,
      end: utterance.end_time / 1000,
      text: utterance.text,
    };
  });
}

export async function transcribeBytePlusVoiceInputFile(
  file: File,
  signal: AbortSignal,
): Promise<VoiceInputSttProviderResult> {
  const apiKey = env("BYTEPLUS_STT_API_KEY");
  if (!apiKey) {
    return serviceUnavailable(
      "BytePlus STT is not configured",
      "BYTEPLUS_STT_NOT_CONFIGURED",
    );
  }

  const fileBytes = await file.arrayBuffer();
  signal.throwIfAborted();
  const fileBytesView = new Uint8Array(fileBytes);
  const audioFormat = bytePlusAudioFormat(file);
  const audioCodec = bytePlusAudioCodec(file);
  const hasWebmEbmlHeader =
    audioFormat === "webm"
      ? fileBytes.byteLength >= EBML_HEADER.length &&
        EBML_HEADER.every((byte, index) => {
          return fileBytesView[index] === byte;
        })
      : null;
  const audio: Record<string, unknown> = {
    data: Buffer.from(fileBytes).toString("base64"),
    format: audioFormat,
  };
  if (audioCodec) {
    audio.codec = audioCodec;
  }

  L.debug("BytePlus STT request prepared", {
    fileMime: file.type,
    fileSize: file.size,
    fileName: file.name,
    audioByteLength: fileBytes.byteLength,
    audioFormat,
    audioCodec: audioCodec ?? null,
    hasWebmEbmlHeader,
  });

  const requestBody = JSON.stringify({
    audio,
    request: {
      model_name: BYTEPLUS_ASR_MODEL,
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      enable_speaker_info: false,
      show_utterances: true,
    },
  });
  let providerAttempt = await sendBytePlusSttRequest(
    apiKey,
    requestBody,
    signal,
    1,
  );
  if (isRetryableBytePlusStatus(providerAttempt.response.status)) {
    L.warn("Retrying BytePlus STT after transient response", {
      requestId: providerAttempt.requestId,
      status: providerAttempt.response.status,
      statusText: providerAttempt.response.statusText,
      providerDurationMs: providerAttempt.providerDurationMs,
    });
    await providerAttempt.response.arrayBuffer();
    signal.throwIfAborted();
    providerAttempt = await sendBytePlusSttRequest(
      apiKey,
      requestBody,
      signal,
      2,
    );
  }

  const {
    response: bytePlusResponse,
    requestId,
    providerStatus,
    providerDurationMs,
    attempt,
  } = providerAttempt;
  if (
    !bytePlusResponse.ok ||
    !isBytePlusTranscriptionSuccessStatus(providerStatus)
  ) {
    const responseBody = await providerErrorBodyForLog(bytePlusResponse);
    signal.throwIfAborted();
    L.error("BytePlus STT API error", {
      status: bytePlusResponse.status,
      statusText: bytePlusResponse.statusText,
      providerStatus,
      providerDurationMs,
      responseBody,
      fileMime: file.type,
      fileSize: file.size,
      fileName: file.name,
      requestId,
      attempt,
    });
    return internalError("Transcription failed");
  }

  const result: unknown = await bytePlusResponse.json();
  signal.throwIfAborted();
  if (!isBytePlusTranscriptionBody(result)) {
    return internalError("Transcription failed");
  }

  const segments = bytePlusSegments(result.result.utterances);
  return {
    text: result.result.text,
    ...(segments !== undefined && { segments }),
  };
}

export function isAllowedSttMimeType(value: string): boolean {
  return ALLOWED_STT_MIME_TYPES.some((mimeType) => {
    return mimeType === value;
  });
}

export function isSpeechVoice(value: string): boolean {
  return SPEECH_VOICES.some((voice) => {
    return voice === value;
  });
}

function estimatedSpeechCredits(
  durationSeconds: number,
  pricing: SpeechPricing,
): number {
  return Math.ceil((durationSeconds * pricing.unitPrice) / pricing.unitSize);
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

export function parseSpeechWavDurationSeconds(
  bytes: Uint8Array,
): number | null {
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

export const speechPricing$: Computed<Promise<SpeechPricing | null>> = computed(
  async (get): Promise<SpeechPricing | null> => {
    const db = get(db$);
    const provider = resolveUsagePricingProvider(
      get(usagePricingResolution$),
      USAGE_KIND,
      USAGE_PROVIDER,
    );
    const [pricing] = await db
      .select({
        unitPrice: usagePricing.unitPrice,
        unitSize: usagePricing.unitSize,
      })
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, USAGE_KIND),
          eq(usagePricing.provider, provider),
          eq(usagePricing.category, USAGE_CATEGORY),
        ),
      )
      .limit(1);

    return pricing ?? null;
  },
);

export const checkSpeechCredits$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    return await set(checkBillableOperationCredits$, args, signal);
  },
);

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
    const lifetimeLimit = capabilities ? capabilities.audioLifetimeLimit : 0;
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
      recordLifetimeUsage: lifetimeLimit !== null,
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
      params.recordLifetimeUsage
        ? writeDb
            .insert(userBehaviorCount)
            .values({
              orgId: params.orgId,
              userId: params.userId,
              behaviorKey: AUDIO_INPUT_BEHAVIOR_KEY,
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
            })
        : Promise.resolve(),
    ]);
    signal.throwIfAborted();
  },
);

export const recordGeneratedSpeech$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string | undefined;
      readonly publicBrand: PublicBrand;
      readonly privateArtifacts: boolean;
      readonly voice: string;
      readonly audioBytes: Uint8Array;
      readonly durationSeconds: number;
      readonly pricing: SpeechPricing;
    },
    signal: AbortSignal,
  ): Promise<RecordedSpeech> => {
    const writeDb = set(writeDb$);
    const artifact = await set(
      storeGeneratedArtifactObject$,
      {
        userId: params.userId,
        orgId: params.orgId,
        privateArtifacts: params.privateArtifacts,
        filenamePrefix: "voice",
        extension: "wav",
        body: Buffer.from(params.audioBytes),
        contentType: SPEECH_CONTENT_TYPE,
        publicBrand: params.publicBrand,
      },
      signal,
    );
    const { id: fileId, filename, key: s3Key, url } = artifact;
    await set(
      recordWebUploadedFile$,
      {
        runId: params.runId,
        externalId: fileId,
        userId: params.userId,
        orgId: params.orgId,
        filename,
        contentType: SPEECH_CONTENT_TYPE,
        sizeBytes: params.audioBytes.byteLength,
        url,
        s3Key,
        publicBrand: params.publicBrand,
        metadata: {
          generatedBy: "zero-official-voice",
          model: VOICE_IO_TTS_MODEL,
          voice: params.voice,
          durationSeconds: params.durationSeconds,
        },
      },
      signal,
    );
    signal.throwIfAborted();

    await writeDb.insert(usageEvent).values({
      runId: params.runId ?? null,
      billingContext: params.runId ? "run" : "runless",
      idempotencyKey: randomUUID(),
      orgId: params.orgId,
      userId: params.userId,
      kind: USAGE_KIND,
      provider: USAGE_PROVIDER,
      category: USAGE_CATEGORY,
      quantity: params.durationSeconds,
    });
    signal.throwIfAborted();

    await set(processOrgUsageEvents$, params.orgId, signal);
    signal.throwIfAborted();

    return {
      id: fileId,
      filename,
      contentType: SPEECH_CONTENT_TYPE,
      size: params.audioBytes.byteLength,
      url,
      durationSeconds: params.durationSeconds,
      creditsCharged: estimatedSpeechCredits(
        params.durationSeconds,
        params.pricing,
      ),
      model: VOICE_IO_TTS_MODEL,
      voice: params.voice,
    };
  },
);
