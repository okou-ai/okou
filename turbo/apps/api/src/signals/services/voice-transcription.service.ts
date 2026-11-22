import { object, string } from "zod";
import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { usagePricing } from "@okouai/db/runtime/usage-pricing";
import { voiceTranscriptions } from "@okouai/db/schema/voice-transcription";
import { VOICE_TRANSCRIPTION_MODEL } from "@okouai/api-contracts/contracts/voice-clips";
import {
  conflict,
  insufficientCredits,
  notConfigured,
  resourceUnavailable,
  providerUnavailable,
} from "../../lib/error";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import { waitUntil } from "../context/wait-until";
import type { VoiceContentPart } from "../external/voice-completion-types";
import { writeDb$ } from "../external/db";
import { downloadS3BufferWithMaxBytes$ } from "../external/s3";
import {
  generateVertexVoice,
  VERTEX_VOICE_MAX_OUTPUT_TOKENS,
} from "../external/vertex-voice";
import { gcpLlmConfiguration } from "../external/gcp-llm-auth";
import { voiceTranscriptionUsage } from "./voice-transcription-usage";
import { resolveVoiceClips$ } from "./voice-clips.service";
import { checkBillableOperationCredits$ } from "./billable-operation-admission.service";
import { recordProviderUsageBatch$ } from "./provider-usage-publication.service";
import { processUsageEventKeys$ } from "./credit-usage.service";

const transcriptOutput = object({ transcript: string() });
const TRANSCRIPTION_NAMESPACE = "1db7b130-7dbd-41a7-a756-f211f179dceb";
const categories = {
  audioTokens: "tokens.input.audio",
  textTokens: "tokens.input.text",
  cachedAudioTokens: "tokens.input.cached_audio",
  cachedTextTokens: "tokens.input.cached_text",
  outputTokens: "tokens.output",
} as const;
type Receipt = typeof voiceTranscriptions.$inferSelect;

const deliverTranscript$ = command(
  async ({ set }, receipt: Receipt, signal: AbortSignal) => {
    if (receipt.transcript === null) {
      return conflict(
        "Transcription is pending or its provider outcome is unknown",
      );
    }
    if (receipt.settledAt === null) {
      const events = Object.entries(categories).flatMap(([key, category]) => {
        const quantity = receipt[key as keyof typeof categories];
        if (quantity === null) {
          throw new Error("Incomplete transcription usage checkpoint");
        }
        return quantity > 0
          ? [
              {
                idempotencyKey: uuidv5(category, receipt.id),
                kind: "model",
                provider: VOICE_TRANSCRIPTION_MODEL,
                category,
                quantity,
              },
            ]
          : [];
      });
      await set(
        recordProviderUsageBatch$,
        {
          orgId: receipt.orgId,
          userId: receipt.userId,
          runId: receipt.runId ?? undefined,
          billingRunId: receipt.runId,
          billingContext: receipt.runId ? "run" : "runless",
          events,
        },
        signal,
      );
      await set(
        processUsageEventKeys$,
        {
          orgId: receipt.orgId,
          idempotencyKeys: events.map((e) => {
            return e.idempotencyKey;
          }),
        },
        signal,
      );
      await set(writeDb$)
        .update(voiceTranscriptions)
        .set({ settledAt: nowDate() })
        .where(eq(voiceTranscriptions.id, receipt.id));
    }
    return { status: 200 as const, body: { transcript: receipt.transcript } };
  },
);

const completeVoiceTranscription$ = command(
  async (
    { set },
    claim: Pick<
      typeof voiceTranscriptions.$inferInsert,
      "id" | "userId" | "orgId" | "runId" | "requestHash"
    >,
    content: readonly VoiceContentPart[],
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const claimed = await db
      .insert(voiceTranscriptions)
      .values(claim)
      .onConflictDoNothing()
      .returning({ id: voiceTranscriptions.id });
    signal.throwIfAborted();
    if (!claimed.length) {
      return conflict(
        "Transcription already claimed; retry the same operation",
      );
    }
    const generated = await settle(
      generateVertexVoice(
        {
          model: VOICE_TRANSCRIPTION_MODEL,
          content,
          systemPrompt:
            "Faithfully transcribe these audio clips in order in their original languages. Return the speech as text. For silence return an empty transcript.",
          jsonSchema: {
            name: "ordered_voice_transcript",
            properties: { transcript: {} },
            required: ["transcript"],
          },
          maxOutputTokens: VERTEX_VOICE_MAX_OUTPUT_TOKENS,
          singleAttempt: true,
        },
        (text, usage) => {
          return {
            transcript: transcriptOutput.parse(JSON.parse(text)).transcript,
            ...voiceTranscriptionUsage(usage),
          };
        },
        signal,
      ),
      signal,
    );
    if (!generated.ok) {
      return providerUnavailable(
        "Transcription did not produce a complete result. The operation has been retained for reconciliation.",
      );
    }
    const result = generated.value;
    if (!result) {
      return notConfigured("Voice transcription is unavailable");
    }
    const [receipt] = await db
      .update(voiceTranscriptions)
      .set(result)
      .where(eq(voiceTranscriptions.id, claim.id))
      .returning();
    signal.throwIfAborted();
    if (!receipt) {
      throw new Error("Missing transcription checkpoint");
    }
    return await set(deliverTranscript$, receipt, signal);
  },
);

export const transcribeClips$ = command(
  async (
    { set },
    args: {
      userId: string;
      orgId: string;
      runId?: string;
      model: typeof VOICE_TRANSCRIPTION_MODEL;
      fileIds: string[];
      operationId?: string;
    },
    signal: AbortSignal,
  ) => {
    const resolved = await set(resolveVoiceClips$, args, signal);
    if ("status" in resolved) {
      return resolved;
    }
    const db = set(writeDb$);
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          args.model,
          ...args.fileIds.map((id) => {
            return id.toLowerCase();
          }),
        ]),
      )
      .digest("hex");
    const id = uuidv5(
      JSON.stringify([
        args.orgId,
        args.userId,
        args.runId ?? null,
        args.operationId ?? hash,
      ]),
      TRANSCRIPTION_NAMESPACE,
    );
    const [existing] = await db
      .select()
      .from(voiceTranscriptions)
      .where(eq(voiceTranscriptions.id, id));
    signal.throwIfAborted();
    if (existing) {
      return existing.requestHash === hash
        ? await set(deliverTranscript$, existing, signal)
        : conflict("Operation ID belongs to another input");
    }
    const credit = await set(checkBillableOperationCredits$, args, signal);
    if (credit === "closed") {
      return resourceUnavailable("Official Workflow run is no longer active");
    }
    if (!credit) {
      return insufficientCredits();
    }
    if (!gcpLlmConfiguration()) {
      return notConfigured("Voice transcription is not configured");
    }
    const prices = await db
      .select()
      .from(usagePricing)
      .where(
        and(
          eq(usagePricing.kind, "model"),
          eq(usagePricing.provider, args.model),
        ),
      );
    signal.throwIfAborted();
    if (
      !Object.values(categories).every((category) => {
        return prices.some((p) => {
          return p.category === category && p.unitSize > 0 && p.unitPrice > 0;
        });
      })
    ) {
      return notConfigured("Voice transcription pricing is incomplete");
    }

    const content = [];
    for (const clip of resolved.clips) {
      const bytes = await set(
        downloadS3BufferWithMaxBytes$,
        { ...clip, maxBytes: clip.size },
        signal,
      );
      if (bytes.length !== clip.size) {
        throw new Error("Private audio size changed");
      }
      content.push({
        type: "audio" as const,
        audio: { data: bytes.toString("base64"), mimeType: clip.mimeType },
      });
    }
    signal.throwIfAborted();
    // The claim owns the paid request and its checkpoint across client disconnects.
    const completion = set(
      completeVoiceTranscription$,
      {
        id,
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        requestHash: hash,
      },
      content,
      AbortSignal.timeout(240_000),
    );
    waitUntil(completion);
    return await completion;
  },
);
