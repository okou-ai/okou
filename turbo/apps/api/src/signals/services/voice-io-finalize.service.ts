import { voiceIoPolishSegmentsRequestSchema } from "@okouai/api-contracts/contracts/voice-io-polish";
import { command } from "ccstate";
import { requestSignal$ } from "../context/hono";
import { onRejection, settle } from "../utils";
import { VoiceResponseError } from "../external/voice-response-error";
import { polishVoiceTranscript$ } from "./voice-io-polish.service";
import {
  transcribeVoiceSegment$,
  type VoiceDraftTranscriptionInput,
} from "./voice-io-transcribe.service";

const completeVoiceRequest$ = command(
  async ({ set }, input: VoiceDraftTranscriptionInput, signal: AbortSignal) => {
    const transcribed =
      input.files.length > 0
        ? await set(transcribeVoiceSegment$, input, signal)
        : { status: 204 as const, body: undefined };
    if (
      !input.final ||
      (transcribed.status !== 200 && transcribed.status !== 204)
    ) {
      return transcribed;
    }
    const transcript =
      transcribed.status === 200 ? transcribed.body.transcript : "";
    const segments = [input.previousTranscript, transcript].filter((text) => {
      return Boolean(text.trim());
    });
    if (segments.length === 0) {
      return { status: 204 as const, body: undefined };
    }
    const body = voiceIoPolishSegmentsRequestSchema.safeParse({
      segments,
      lastAssistantMessage: input.lastAssistantMessage,
    });
    if (!body.success) {
      return {
        status: 400 as const,
        body: {
          error: {
            code: "BAD_REQUEST",
            message: "Complete voice transcript exceeds the text limit",
          },
        },
      };
    }
    const polished = await set(polishVoiceTranscript$, body.data, signal);
    if (polished.status !== 200) {
      return polished;
    }
    return {
      status: 200 as const,
      body: {
        transcript,
        language:
          transcribed.status === 200 ? transcribed.body.language : "und",
        polishedText: polished.body.text,
      },
    };
  },
);

// Old Web -> new API: retain the live final HTTP contract until the replacement
// App is live, its floor excludes old senders, and older APIs leave serving/
// rollback (closing the new-App fallback too). Both model calls stay separate;
// no combined audio-plus-polish prompt or voice-cache reader returns.
export const transcribeCompatibleVoiceSegment$ = command(
  async (
    { get, set },
    input: VoiceDraftTranscriptionInput,
    signal: AbortSignal,
  ) => {
    if (!input.final) {
      return await set(transcribeVoiceSegment$, input, signal);
    }
    // Two independently bounded calls must also fit one legacy edge request.
    const deadline = AbortSignal.timeout(80_000);
    const completed = await settle(
      onRejection(
        set(completeVoiceRequest$, input, AbortSignal.any([signal, deadline])),
        () => {
          signal.throwIfAborted();
          get(requestSignal$).throwIfAborted();
          if (deadline.aborted) {
            throw new VoiceResponseError("deadline_exceeded");
          }
        },
      ),
      signal,
    );
    signal.throwIfAborted();
    get(requestSignal$).throwIfAborted();
    if (completed.ok) {
      return completed.value;
    }
    if (deadline.aborted) {
      return {
        status: 503 as const,
        body: {
          error: {
            code: "PROVIDER_UNAVAILABLE",
            message: "Voice draft completion is temporarily unavailable",
          },
        },
      };
    }
    throw completed.error;
  },
);
