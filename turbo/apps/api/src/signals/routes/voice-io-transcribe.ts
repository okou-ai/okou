import {
  VOICE_IO_TRANSCRIBE_MAX_CONTEXT_CHARS,
  VOICE_IO_TRANSCRIBE_MAX_SEGMENT_SECONDS,
  voiceIoTranscribeSegmentOptionsSchema,
  voiceIoTranscribeContract,
  voiceIoEditorContextSchema,
  type VoiceIoEditorContext,
  type VoiceIoTranscribeSegmentOptions,
} from "@okouai/api-contracts/contracts/voice-io-transcribe";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  DEFAULT_VOICE_INPUT_MODEL,
  VOICE_INPUT_MODELS,
} from "@okouai/api-contracts/contracts/voice-input-models";
import { command, computed } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { request$ } from "../context/hono";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { audioInputLifetimeQuota } from "../services/voice-io.service";
import {
  badRequest,
  getAudioDuration,
  MAX_STT_FILE_SIZE,
  recordSttUsage$,
  sttDailyPolicy$,
} from "../services/voice-io-post.service";
import { transcribeVoiceSegment$ } from "../services/voice-io-transcribe.service";
import { safeJsonParse } from "../utils";
import { userPreferences } from "../services/user-data.service";

const ALLOWED_VOICE_DRAFT_MIME_TYPES = [
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
] as const;

const voiceIoFeatureContext$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  return await loadUserFeatureSwitchContext(get(db$), auth.orgId, auth.userId);
});

const selectedVoiceInputModel$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const preferences = await get(
    userPreferences({ orgId: auth.orgId, userId: auth.userId }),
  );
  const modelId = preferences.voiceInputModel ?? DEFAULT_VOICE_INPUT_MODEL;
  return VOICE_INPUT_MODELS.find((candidate) => {
    return candidate.id === modelId;
  });
});

function isAllowedVoiceDraftMimeType(value: string): boolean {
  const baseMimeType = value.split(";")[0]?.toLowerCase() ?? value;
  return ALLOWED_VOICE_DRAFT_MIME_TYPES.some((mimeType) => {
    return mimeType === baseMimeType;
  });
}

function audioFiles(formData: FormData): readonly File[] | null {
  const entries = formData.getAll("file");
  if (
    entries.length === 0 ||
    entries.some((entry) => {
      return !(entry instanceof File);
    })
  ) {
    return null;
  }
  return entries as readonly File[];
}

function lastAssistantReference(formData: FormData): string | undefined | null {
  const value = formData.get("lastAssistantMessage");
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const reference = value.trim();
  if (!reference || reference.length > VOICE_IO_TRANSCRIBE_MAX_CONTEXT_CHARS) {
    return null;
  }
  return reference;
}

function editorReference(
  formData: FormData,
): VoiceIoEditorContext | undefined | null {
  const value = formData.get("editorContext");
  if (value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = voiceIoEditorContextSchema.safeParse(safeJsonParse(value));
  return parsed.success ? parsed.data : null;
}

function parseVoiceDraftForm(formData: FormData) {
  const options = voiceIoTranscribeSegmentOptionsSchema.safeParse(
    safeJsonParse(String(formData.get("options"))),
  );
  if (!options.success) {
    return badRequest("Invalid voice segment options");
  }
  const segment = options.data;
  const files =
    segment.final && formData.getAll("file").length === 0
      ? []
      : audioFiles(formData);
  if (!files) {
    return badRequest("No audio file provided");
  }
  if (files.length > 1) {
    return badRequest("Voice segments must contain at most one audio file");
  }
  const reference = lastAssistantReference(formData);
  if (reference === null) {
    return badRequest("Invalid last assistant message");
  }
  const editorContext = editorReference(formData);
  if (editorContext === null) {
    return badRequest("Invalid editor context");
  }

  const totalBytes = files.reduce((total, file) => {
    return total + file.size;
  }, 0);
  if (totalBytes > MAX_STT_FILE_SIZE) {
    return badRequest("Audio files are too large (max 25 MB)");
  }
  for (const file of files) {
    if (!isAllowedVoiceDraftMimeType(file.type)) {
      return badRequest("Voice draft audio must be 16 kHz PCM WAV");
    }
  }

  return { files, segment, reference, editorContext };
}

async function validateVoiceDraftDuration(
  files: readonly File[],
  segment: VoiceIoTranscribeSegmentOptions,
  signal: AbortSignal,
) {
  const durations = await Promise.all(
    files.map(async (file) => {
      return await getAudioDuration(file);
    }),
  );
  signal.throwIfAborted();
  const validDurations = durations.filter((duration): duration is number => {
    return duration !== null && duration > 0;
  });
  if (validDurations.length !== durations.length) {
    return badRequest("Voice draft audio contains an invalid WAV file");
  }
  const durationSeconds = validDurations.reduce((total, duration) => {
    return total + duration;
  }, 0);
  if (
    durationSeconds > VOICE_IO_TRANSCRIBE_MAX_SEGMENT_SECONDS ||
    durationSeconds > segment.totalDurationSeconds
  ) {
    return badRequest(
      "Voice segment duration exceeds its recording or segment limit",
      "AUDIO_DURATION_TOO_LONG",
    );
  }
  if (
    segment.overlapDurationSeconds > 0 &&
    segment.overlapDurationSeconds >= durationSeconds
  ) {
    return badRequest(
      "Voice segment must contain new audio beyond its overlap",
    );
  }
  // Preserve the precise uploaded duration for response grounding checks; only
  // usage counters round the unique, non-overlapping recording time.
  return {
    audioDurationSeconds: durationSeconds,
    usageDurationSeconds: Math.ceil(
      durationSeconds - segment.overlapDurationSeconds,
    ),
  };
}

const voiceIoTranscribeHandler$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const featureContext = await get(voiceIoFeatureContext$);
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.VoiceInputV2, featureContext)) {
      return {
        status: 403 as const,
        body: {
          error: {
            code: "FORBIDDEN" as const,
            message: "Voice draft transcription is not enabled",
          },
        },
      };
    }
    signal.throwIfAborted();

    const auth = get(organizationAuthContext$);
    const model = await get(selectedVoiceInputModel$);
    signal.throwIfAborted();
    if (!model) {
      return badRequest(
        "The selected voice input model is unavailable. Choose another model in Debug preferences.",
      );
    }
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
    const parsed = parseVoiceDraftForm(formData);
    if ("status" in parsed) {
      return parsed;
    }
    const { files, segment, reference, editorContext } = parsed;
    const duration = await validateVoiceDraftDuration(files, segment, signal);
    signal.throwIfAborted();
    if ("status" in duration) {
      return duration;
    }
    const { audioDurationSeconds, usageDurationSeconds } = duration;

    const policy = await set(
      sttDailyPolicy$,
      auth.orgId,
      auth.userId,
      usageDurationSeconds,
      signal,
    );
    if ("status" in policy) {
      return policy;
    }

    const input = {
      files,
      model,
      audioDurationSeconds,
      debug: isFeatureEnabled(FeatureSwitchKey.OkouDebug, featureContext),
      ...(reference === undefined ? {} : { lastAssistantMessage: reference }),
      ...(editorContext === undefined ? {} : { editorContext }),
    };
    const result = await set(
      transcribeVoiceSegment$,
      { ...input, ...segment },
      signal,
    );
    if (result.status !== 200) {
      return result;
    }

    await set(
      recordSttUsage$,
      {
        ...policy,
        recordLifetimeUsage: policy.recordLifetimeUsage && segment.final,
        orgId: auth.orgId,
        userId: auth.userId,
      },
      signal,
    );
    return result;
  },
);

export const voiceIoTranscribeRoutes: readonly RouteEntry[] = [
  {
    route: voiceIoTranscribeContract.segment,
    handler: authRoute(
      {
        accept: ["session"],
        requireOrganization: true,
        missingOrganizationStatus: 401,
      },
      voiceIoTranscribeHandler$,
    ),
  },
];
