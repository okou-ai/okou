import type { VoiceInputModel } from "@okouai/api-contracts/contracts/voice-input-models";
import { VOICE_IO_POLISH_MAX_TEXT_CHARS } from "@okouai/api-contracts/contracts/voice-io-polish";
import { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { readBoundedResponseText, safeJsonParse } from "../utils";
import type { VoiceAudio } from "./voice-completion-types";
import { requestVoiceProvider } from "./voice-provider-request";
import { VoiceResponseError } from "./voice-response-error";

type TranscriptionModel = Extract<VoiceInputModel, { kind: "transcription" }>;
const ELEVENLABS_MODEL = "fal-ai/elevenlabs/speech-to-text/scribe-v2";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const transcriptionSchema = z.object({
  text: z.string().trim().max(VOICE_IO_POLISH_MAX_TEXT_CHARS),
});

const L = logger("VoiceTranscription");

export function isVoiceTranscriptionConfigured(
  model: TranscriptionModel,
): boolean {
  return model.id === ELEVENLABS_MODEL
    ? Boolean(env("FAL_KEY"))
    : Boolean(optionalEnv("OPENROUTER_API_KEY"));
}

export async function transcribeVoiceInputAudio(
  model: TranscriptionModel,
  audio: VoiceAudio,
  signal: AbortSignal,
): Promise<string> {
  const elevenLabs = model.id === ELEVENLABS_MODEL;
  const key = elevenLabs ? env("FAL_KEY") : optionalEnv("OPENROUTER_API_KEY");
  if (!key) {
    throw new Error("Voice transcription provider is not configured");
  }
  return await requestVoiceProvider(
    (requestSignal) => {
      return fetch(
        elevenLabs
          ? `https://fal.run/${ELEVENLABS_MODEL}`
          : "https://openrouter.ai/api/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            Authorization: `${elevenLabs ? "Key" : "Bearer"} ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(
            elevenLabs
              ? {
                  audio_url: `data:audio/wav;base64,${audio.data}`,
                  tag_audio_events: false,
                  diarize: false,
                }
              : {
                  model: model.id,
                  input_audio: audio,
                  response_format: "json",
                },
          ),
          signal: requestSignal,
        },
      );
    },
    async (response) => {
      if (!response.ok) {
        await response.body?.cancel();
        L.warn("Voice transcription provider rejected the request", {
          provider: elevenLabs ? "fal" : "openrouter",
          model: model.id,
          source: "http",
          status: response.status,
        });
        throw new VoiceResponseError("http", "provider");
      }
      const body = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
      signal.throwIfAborted();
      if (body.kind !== "text") {
        throw new VoiceResponseError("response_too_large");
      }
      const parsed = transcriptionSchema.safeParse(safeJsonParse(body.text));
      if (!parsed.success) {
        throw new VoiceResponseError("invalid_response");
      }
      return parsed.data.text;
    },
    { provider: elevenLabs ? "fal" : "openrouter", model: model.id },
    signal,
  );
}
