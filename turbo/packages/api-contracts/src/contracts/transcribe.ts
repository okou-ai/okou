import { array, literal, object, string, url, uuid } from "zod";
import { authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import { initContract } from "./trpc-contract";
import { MAX_VOICE_CLIPS, VOICE_TRANSCRIPTION_MODEL } from "./voice-clips";

export const transcribeContract = initContract().router({
  playback: {
    method: "GET",
    path: "/api/voice/clips/:fileId/playback",
    headers: authHeadersSchema,
    pathParams: object({ fileId: uuid() }),
    responses: {
      200: object({ url: url() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a temporary playback URL for an owned voice clip",
  },
  transcribe: {
    method: "POST",
    path: "/api/voice/transcribe",
    headers: authHeadersSchema,
    body: object({
      model: literal(VOICE_TRANSCRIPTION_MODEL),
      fileIds: array(uuid()).min(1).max(MAX_VOICE_CLIPS),
      operationId: uuid().optional(),
    }).strict(),
    responses: {
      200: object({ transcript: string() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      402: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Transcribe ordered private audio clips using model credits",
  },
});
