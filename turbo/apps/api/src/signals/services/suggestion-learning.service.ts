import { command } from "ccstate";
import { and, eq, exists, inArray, sql } from "drizzle-orm";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { agentSuggestions } from "@okouai/db/schema/agent-suggestion";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import {
  SUGGESTION_MEMORY_PATH,
  SUGGESTION_MEMORY_MAX_BYTES,
  currentSuggestionMemory,
  emptySuggestionMemory,
  suggestionMemorySchema,
} from "@okouai/api-contracts/contracts/suggestion-memory";
import { nowDate } from "../../lib/time";
import { env } from "../../lib/env";
import { badRequestMessage } from "../../lib/error";
import { extractTarGzTargetOccurrences } from "../../lib/tar";
import { db$, writeDb$ } from "../external/db";
import { downloadS3BufferWithMaxBytes$ } from "../external/s3";
import { safeJsonParse } from "../utils";
import {
  pendingSuggestionInputs$,
  suggestionOwner,
} from "./agent-suggestion-read.service";

/** Only owned, published HEAD is proof; local candidates never acknowledge input. */
export const prepareSuggestionLearning$ = command(
  async (
    { get, set },
    owner: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ) => {
    const [published] = await get(db$)
      .select({
        storageId: storages.id,
        versionId: storageVersions.id,
        s3Key: storageVersions.s3Key,
        fileCount: storageVersions.fileCount,
      })
      .from(storages)
      .innerJoin(
        storageVersions,
        and(
          eq(storageVersions.id, storages.headVersionId),
          eq(storageVersions.storageId, storages.id),
        ),
      )
      .where(
        and(
          eq(storages.orgId, owner.orgId),
          eq(storages.userId, owner.userId),
          eq(storages.name, MEMORY_ARTIFACT_NAME),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    let memory = emptySuggestionMemory();
    if (published && published.fileCount > 0) {
      const archive = await set(
        downloadS3BufferWithMaxBytes$,
        {
          bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
          key: `${published.s3Key}/archive.tar.gz`,
          maxBytes: 32 * 1024 * 1024,
        },
        signal,
      );
      const matches = extractTarGzTargetOccurrences(
        archive,
        [SUGGESTION_MEMORY_PATH],
        64 * 1024 * 1024,
      );
      const match = matches[0];
      if (
        matches.length > 1 ||
        (match &&
          (!match.content ||
            match.content.length > SUGGESTION_MEMORY_MAX_BYTES))
      ) {
        return badRequestMessage(
          "Suggestion feedback memory must be one regular file of at most 64 KiB.",
        );
      }
      if (match?.content) {
        const parsed = suggestionMemorySchema.safeParse(
          safeJsonParse(
            new TextDecoder("utf-8", { fatal: true }).decode(match.content),
          ),
        );
        if (!parsed.success) {
          return badRequestMessage(
            "Published suggestion feedback memory is invalid. Correct the selected Memory before learning again.",
          );
        }
        memory = parsed.data;
      }
    }
    const at = nowDate();
    if (published && memory.processedFeedback.length > 0) {
      const processed = sql.param(JSON.stringify(memory.processedFeedback));
      await set(writeDb$)
        .update(agentSuggestions)
        .set({
          feedbacks: sql`(SELECT COALESCE(jsonb_agg(CASE WHEN feedback->'learnedAt' = 'null'::jsonb AND EXISTS (SELECT 1 FROM jsonb_array_elements(${processed}::jsonb) AS proof WHERE proof->>'suggestionId' = ${agentSuggestions.id}::text AND proof->>'feedbackId' = feedback->>'id') THEN feedback || jsonb_build_object('learnedAt', ${at.toISOString()}::text) ELSE feedback END), '[]'::jsonb) FROM jsonb_array_elements(${agentSuggestions.feedbacks}) AS feedback)`,
        })
        .where(
          and(
            suggestionOwner(owner),
            inArray(agentSuggestions.id, [
              ...new Set(
                memory.processedFeedback.map((item) => {
                  return item.suggestionId;
                }),
              ),
            ]),
            sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${agentSuggestions.feedbacks}) AS feedback JOIN jsonb_array_elements(${processed}::jsonb) AS proof ON proof->>'suggestionId' = ${agentSuggestions.id}::text AND proof->>'feedbackId' = feedback->>'id' WHERE feedback->'learnedAt' = 'null'::jsonb)`,
            exists(
              get(db$)
                .select({ id: storages.id })
                .from(storages)
                .where(
                  and(
                    eq(storages.id, published.storageId),
                    eq(storages.headVersionId, published.versionId),
                  ),
                ),
            ),
          ),
        );
      signal.throwIfAborted();
    }
    const pending = await set(pendingSuggestionInputs$, owner, signal);
    return {
      status: 200 as const,
      body: {
        memory: currentSuggestionMemory(memory, at.getTime()),
        pending,
      },
    };
  },
);
