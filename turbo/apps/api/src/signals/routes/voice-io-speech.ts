import { artifactVisibilityUnavailable } from "../../lib/error";
import { privateArtifactCreationEnabled } from "../services/private-artifact-storage.service";
import { command } from "ccstate";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { voiceIoSpeechContract } from "@okouai/api-contracts/contracts/voice-io-speech";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { logger } from "../../lib/log";
import type { RouteEntry } from "../route-entry";
import {
  badGateway,
  badRequest,
  checkSpeechCredits$,
  insufficientCredits,
  internalError,
  isSpeechVoice,
  OPENAI_AUDIO_SPEECH_URL,
  parseSpeechWavDurationSeconds,
  recordGeneratedSpeech$,
  serviceUnavailable,
  type SpeechPricing,
  SPEECH_MAX_INPUT_TOKENS,
  SPEECH_RESPONSE_FORMAT,
  speechPricing$,
  VOICE_IO_TTS_MODEL,
} from "../services/voice-io-post.service";
import { env } from "../../lib/env";
import {
  completeRunBuiltInAdmission$,
  isRunBuiltInAdmissionError,
  startRunBuiltInAdmission$,
} from "../services/run-built-in-admission.service";
import { onRejection } from "../utils";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const L = logger("VoiceIoSpeech");
const speechBody$ = bodyResultOf(voiceIoSpeechContract.post);

interface GenerateSpeechResponseArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly publicBrand: PublicBrand;
  readonly text: string;
  readonly voice: string;
  readonly instructions: string | undefined;
  readonly pricing: SpeechPricing;
  readonly privateArtifacts?: boolean;
}

const generateSpeechResponse$ = command(
  async (
    { get, set },
    args: GenerateSpeechResponseArgs,
    signal: AbortSignal,
  ) => {
    const privateArtifacts =
      args.privateArtifacts ??
      (await get(privateArtifactCreationEnabled(args.orgId, args.userId)));
    signal.throwIfAborted();
    const openaiResponse = await fetch(OPENAI_AUDIO_SPEECH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VOICE_IO_TTS_MODEL,
        voice: args.voice,
        input: args.text,
        ...(args.instructions ? { instructions: args.instructions } : {}),
        response_format: SPEECH_RESPONSE_FORMAT,
      }),
      signal,
    });
    signal.throwIfAborted();

    if (!openaiResponse.ok) {
      const errorBody = await openaiResponse.text();
      signal.throwIfAborted();
      L.error("OpenAI speech request failed", {
        status: openaiResponse.status,
        body: errorBody,
      });
      return {
        admissionStatus: "failed" as const,
        response: internalError("Speech generation failed"),
      };
    }

    const audioBytes = new Uint8Array(await openaiResponse.arrayBuffer());
    signal.throwIfAborted();
    if (audioBytes.byteLength === 0) {
      return {
        admissionStatus: "failed" as const,
        response: badGateway("Model returned empty audio", "NO_AUDIO_RETURNED"),
      };
    }

    const durationSeconds = parseSpeechWavDurationSeconds(audioBytes);
    if (durationSeconds === null) {
      L.error("Unable to parse generated WAV duration", {
        byteLength: audioBytes.byteLength,
      });
      return {
        admissionStatus: "failed" as const,
        response: badGateway(
          "Could not determine generated audio duration",
          "AUDIO_DURATION_UNKNOWN",
        ),
      };
    }

    const body = await set(
      recordGeneratedSpeech$,
      {
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        publicBrand: args.publicBrand,
        privateArtifacts,
        voice: args.voice,
        audioBytes,
        durationSeconds: Math.ceil(durationSeconds),
        pricing: args.pricing,
      },
      signal,
    );

    return {
      admissionStatus: "completed" as const,
      response: { status: 200 as const, body },
    };
  },
);

const postSpeechInner$ = command(
  async (
    { get, set },
    requirePrivateArtifact: boolean,
    signal: AbortSignal,
  ) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(speechBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const privacyRequired =
      requirePrivateArtifact || bodyResult.data.requirePrivateArtifact === true;
    const privateArtifacts = privacyRequired
      ? await get(privateArtifactCreationEnabled(auth.orgId, auth.userId))
      : undefined;
    signal.throwIfAborted();
    if (privacyRequired && !privateArtifacts) {
      return artifactVisibilityUnavailable();
    }

    const text =
      typeof bodyResult.data.text === "string"
        ? bodyResult.data.text.trim()
        : "";
    if (text.length === 0) {
      return badRequest("text is required");
    }

    const voice =
      typeof bodyResult.data.voice === "string"
        ? bodyResult.data.voice
        : "marin";
    if (!isSpeechVoice(voice)) {
      return badRequest(`Unsupported voice: ${voice}`);
    }

    const instructions =
      typeof bodyResult.data.instructions === "string" &&
      bodyResult.data.instructions.trim().length > 0
        ? bodyResult.data.instructions.trim()
        : undefined;
    const tokenCount = encode(`${instructions ?? ""}\n${text}`).length;
    if (tokenCount > SPEECH_MAX_INPUT_TOKENS) {
      return badRequest(
        `text and instructions exceed ${SPEECH_MAX_INPUT_TOKENS} input tokens`,
      );
    }

    const runId =
      auth.tokenType === "agent" || auth.tokenType === "sandbox"
        ? auth.runId
        : undefined;
    const hasCredits = await set(
      checkSpeechCredits$,
      { orgId: auth.orgId, userId: auth.userId, runId },
      signal,
    );
    if (!hasCredits) {
      return insufficientCredits();
    }

    const pricing = await get(speechPricing$);
    signal.throwIfAborted();
    if (!pricing) {
      return serviceUnavailable(
        "Audio generation pricing is not configured",
        "NOT_CONFIGURED",
      );
    }

    const publicBrand = PUBLIC_BRAND;
    const admission = await set(
      startRunBuiltInAdmission$,
      { runId, kind: "voice" },
      signal,
    );
    if (isRunBuiltInAdmissionError(admission)) {
      return admission;
    }

    const result = await onRejection(
      set(
        generateSpeechResponse$,
        {
          orgId: auth.orgId,
          userId: auth.userId,
          runId,
          publicBrand,
          text,
          voice,
          instructions,
          pricing,
          privateArtifacts,
        },
        signal,
      ),
      async () => {
        await set(completeRunBuiltInAdmission$, {
          admission,
          status: "failed",
        });
        signal.throwIfAborted();
      },
    );
    signal.throwIfAborted();

    await set(completeRunBuiltInAdmission$, {
      admission,
      status: result.admissionStatus,
    });
    signal.throwIfAborted();
    return result.response;
  },
);

export const voiceIoSpeechRoutes: readonly RouteEntry[] = [
  {
    route: voiceIoSpeechContract.postPrivate,
    handler: authRoute(
      { requireOrganization: true, requiredCapability: "file:write" },
      command(({ set }, signal: AbortSignal) => {
        return set(postSpeechInner$, true, signal);
      }),
    ),
  },
  {
    route: voiceIoSpeechContract.post,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      command(({ set }, signal: AbortSignal) => {
        return set(postSpeechInner$, false, signal);
      }),
    ),
  },
];
