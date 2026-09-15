import { command } from "ccstate";
import { voiceIoSttContract } from "@okouai/api-contracts/contracts/voice-io-stt";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route-entry";
import { audioInputLifetimeQuota } from "../services/voice-io.service";
import {
  badRequest,
  getAudioDuration,
  isAllowedSttMimeType,
  MAX_STT_FILE_SIZE,
  MAX_STT_REQUEST_DURATION_SECONDS,
  recordSttUsage$,
  sttDailyPolicy$,
  transcribeBytePlusVoiceInputFile,
} from "../services/voice-io-post.service";

const L = logger("VoiceIoStt");

function logSttUploadInspection(
  file: File,
  parsedDurationSeconds: number | null,
): void {
  L.debug("STT upload inspected", {
    fileMime: file.type,
    fileSize: file.size,
    fileName: file.name,
    parsedDurationSeconds,
  });
}

const postSttInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const quota = await get(audioInputLifetimeQuota(auth.orgId, auth.userId));
  signal.throwIfAborted();
  if (!quota.allowed) {
    return {
      status: 402 as const,
      body: {
        error: {
          message:
            "Audio input quota exceeded. Upgrade to Pro or Team for unlimited audio input.",
          code: "AUDIO_INPUT_QUOTA_EXCEEDED",
        },
        quota: { count: quota.count, limit: quota.limit },
      },
    };
  }

  const formData = await get(request$).raw.formData();
  signal.throwIfAborted();
  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    L.warn("STT validation rejected: no file", {
      hasField: file !== null,
      fieldType: typeof file,
    });
    return badRequest("No audio file provided");
  }

  if (file.size > MAX_STT_FILE_SIZE) {
    L.warn("STT validation rejected: file too large", {
      fileSize: file.size,
      fileMime: file.type,
    });
    return badRequest("File too large (max 25 MB)");
  }

  const baseMimeType = file.type.split(";")[0] ?? file.type;
  if (!isAllowedSttMimeType(baseMimeType)) {
    L.warn("STT validation rejected: unsupported mime", {
      fileMime: file.type,
      baseMimeType,
      fileSize: file.size,
    });
    return badRequest(
      `Unsupported audio format: ${baseMimeType}. Supported: webm, wav, mp3, m4a, mp4, mpeg, mpga`,
    );
  }

  const audioDurationSeconds = await getAudioDuration(file);
  signal.throwIfAborted();
  const durationSeconds =
    audioDurationSeconds === null ? null : Math.ceil(audioDurationSeconds);
  logSttUploadInspection(file, durationSeconds);
  if (
    durationSeconds !== null &&
    durationSeconds > MAX_STT_REQUEST_DURATION_SECONDS
  ) {
    L.warn("STT validation rejected: duration too long", {
      durationSeconds,
      maxSeconds: MAX_STT_REQUEST_DURATION_SECONDS,
      fileMime: file.type,
      fileSize: file.size,
    });
    return badRequest(
      `Audio duration (${durationSeconds}s) exceeds maximum (${MAX_STT_REQUEST_DURATION_SECONDS}s)`,
      "AUDIO_DURATION_TOO_LONG",
    );
  }

  const policy = await set(
    sttDailyPolicy$,
    auth.orgId,
    auth.userId,
    durationSeconds ?? 0,
    signal,
  );
  if ("status" in policy) {
    return policy;
  }

  const result = await transcribeBytePlusVoiceInputFile(file, signal);
  signal.throwIfAborted();
  if ("status" in result) {
    L.warn("STT provider rejected transcription", {
      provider: "byteplus",
      status: result.status,
      fileMime: file.type,
      fileSize: file.size,
      fileName: file.name,
    });
    return result;
  }
  signal.throwIfAborted();

  await set(
    recordSttUsage$,
    { ...policy, orgId: auth.orgId, userId: auth.userId },
    signal,
  );

  return {
    status: 200 as const,
    body: {
      text: result.text,
      ...(result.segments !== undefined && { segments: result.segments }),
    },
  };
});

export const voiceIoSttRoutes: readonly RouteEntry[] = [
  {
    route: voiceIoSttContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
        missingOrganizationStatus: 401,
      },
      postSttInner$,
    ),
  },
];
