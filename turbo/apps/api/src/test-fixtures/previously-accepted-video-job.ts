/**
 * Video and avatar jobs accepted before retirement can still receive provider
 * callbacks. New production submissions cannot construct that historical state;
 * this narrow fixture keeps its completion, ownership and billing contracts
 * testable through the existing webhook, status and artifact endpoints.
 */
import { createHmac, randomUUID } from "node:crypto";
import { builtInGenerationJobs } from "@okouai/db/schema/built-in-generation-job";
import type { BuiltInGenerationRequest } from "@okouai/db/jsonb-contracts/built-in-generation-job";
import { createStore } from "ccstate";
import { env } from "../lib/env";
import { nowDate } from "../lib/time";
import { writeDb$ } from "../signals/external/db";

export async function seedPreviouslyAcceptedVideoJob(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
  readonly privateArtifacts: boolean;
  readonly provider: "fal" | "byteplus" | "minimax" | "joggai";
  readonly providerJobId: string;
  readonly request: BuiltInGenerationRequest;
}): Promise<{ readonly generationId: string; readonly callbackPath: string }> {
  const generationId = randomUUID();
  await createStore()
    .set(writeDb$)
    .insert(builtInGenerationJobs)
    .values({
      id: generationId,
      type: "video",
      status: "running",
      orgId: args.orgId,
      userId: args.userId,
      runId: args.runId ?? null,
      billingRunId: args.runId ?? null,
      billingContext: args.runId ? "run" : "runless",
      startedAt: nowDate(),
      request: {
        ...args.request,
        __builtInGeneration: {
          privateArtifacts: args.privateArtifacts,
          publicBrand: "okou",
          provider: args.provider,
          providerJobId: args.providerJobId,
          providerTask: args.provider === "joggai" ? "avatar-video" : "video",
        },
      },
    });
  const token = createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`${args.provider}:${generationId}:`)
    .digest("hex");
  return {
    generationId,
    callbackPath: `/api/webhooks/built-in-generations/${args.provider}/${generationId}?token=${token}`,
  };
}
