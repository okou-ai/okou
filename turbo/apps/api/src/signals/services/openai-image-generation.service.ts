import { command, computed } from "ccstate";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { builtInGenerationJobs } from "@okouai/db/schema/built-in-generation-job";
import { openaiImageWebhookReceipts } from "@okouai/db/schema/openai-image-webhook-receipt";
import { usagePricing } from "@okouai/db/schema/usage-pricing";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  builtInGenerationIsPrivate,
  completeBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  getBuiltInGenerationJob$,
  getBuiltInGenerationWebhookJob$,
  mergeBuiltInGenerationJobInternal$,
  readBuiltInGenerationRequestInternal,
  type BuiltInGenerationWebhookJob,
} from "./built-in-generation.service";
import {
  imagePricing$,
  parseImageOptions,
  settleGeneratedImageUsage$,
  storeGeneratedImage$,
} from "./image-generation.service";
import {
  MAINLINE_MODEL,
  deleteOpenAiImageResponse,
  parseOpenAiImageResponse,
  retrieveOpenAiImageResponse,
  submitOpenAiImageResponse,
} from "./openai-image-response";
import { completeRunBuiltInAdmission$ } from "./run-built-in-admission.service";
import { resolveProviderReferenceUrls$ } from "./provider-reference-url.service";
import { recordProviderUsageBatch$ } from "./provider-usage-publication.service";
import { processUsageEventKeys$ } from "./credit-usage.service";
import { officialWorkflowCreditAccess$ } from "./official-workflow-policy.service";
import { builtInGenerationUsageIdempotencyKey } from "./built-in-generation-usage-idempotency";

const L = logger("OpenAiImageJobs");
const MAINLINE_PRICING_PROVIDER = `openai/${MAINLINE_MODEL}`;
const MAINLINE_CATEGORIES = [
  "tokens.input",
  "tokens.cache_read",
  "tokens.output",
] as const;

export const openAiImageOrchestrationPricing$ = computed(async (get) => {
  const rows = await get(db$)
    .select({
      category: usagePricing.category,
      unitPrice: usagePricing.unitPrice,
      unitSize: usagePricing.unitSize,
    })
    .from(usagePricing)
    .where(
      and(
        eq(usagePricing.kind, "model"),
        eq(usagePricing.provider, MAINLINE_PRICING_PROVIDER),
        inArray(usagePricing.category, [...MAINLINE_CATEGORIES]),
      ),
    );
  if (
    MAINLINE_CATEGORIES.some((category) => {
      return !rows.some((row) => {
        return row.category === category && row.unitSize > 0;
      });
    })
  ) {
    throw new Error("OpenAI image orchestration pricing is not configured");
  }
  return rows;
});

const settlementSchema = z.object({
  billing: z.array(
    z.object({
      category: z.enum([
        "tokens.input.text",
        "tokens.input.image",
        "tokens.output.image",
      ]),
      quantity: z.number().nonnegative(),
    }),
  ),
  mainModelUsage: z.object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
});
const storedImageSchema = z
  .object({ creditsCharged: z.number() })
  .catchall(z.unknown());

const finishAdmission$ = command(
  async (
    { set },
    args: { job: BuiltInGenerationWebhookJob; status: "completed" | "failed" },
  ) => {
    const internal = readBuiltInGenerationRequestInternal(args.job.request);
    await set(completeRunBuiltInAdmission$, {
      admission: internal.admissionId ? { id: internal.admissionId } : null,
      status: args.status,
    });
  },
);

const failJob$ = command(
  async (
    { set },
    args: {
      job: BuiltInGenerationWebhookJob;
      error: { message: string; code: string };
    },
    signal: AbortSignal,
  ) => {
    await set(finishAdmission$, { job: args.job, status: "failed" });
    signal.throwIfAborted();
    await set(
      failBuiltInGenerationJob$,
      { generationId: args.job.id, error: args.error },
      signal,
    );
  },
);

// The queued -> running transition authorizes exactly one submission attempt.
// A lost POST response is uncertainty, not permission to generate a second image.
export const submitOpenAiImageJob$ = command(
  async (
    { set },
    generationId: string,
    signal: AbortSignal,
  ): Promise<null | {
    readonly status: number;
    readonly body: {
      readonly error: { readonly message: string; readonly code: string };
    };
  }> => {
    const job = await set(
      getBuiltInGenerationWebhookJob$,
      generationId,
      signal,
    );
    if (!job || job.status !== "queued") {
      return null;
    }
    const options = parseImageOptions(job.request);
    if ("status" in options) {
      await set(failJob$, { job, error: options.body.error }, signal);
      return options;
    }
    const apiKey = env("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error("OpenAI image generation is not configured");
    }
    const urls = [
      ...options.sourceImageUrls,
      ...(options.maskImageUrl ? [options.maskImageUrl] : []),
    ];
    const references = await set(
      resolveProviderReferenceUrls$,
      { orgId: job.orgId, userId: job.userId, urls },
      signal,
    );
    if ("status" in references) {
      await set(failJob$, { job, error: references.body.error }, signal);
      return references;
    }
    // Resolve authorized references before the irreversible submission boundary.
    // Preparation failures leave a queued job that the cron can safely resume.
    const writeDb = set(writeDb$);
    const [started] = await writeDb
      .update(builtInGenerationJobs)
      .set({ status: "running", startedAt: nowDate(), updatedAt: nowDate() })
      .where(
        and(
          eq(builtInGenerationJobs.id, generationId),
          eq(builtInGenerationJobs.status, "queued"),
        ),
      )
      .returning({ id: builtInGenerationJobs.id });
    signal.throwIfAborted();
    if (!started) {
      return null;
    }
    const submitted = await settle(
      submitOpenAiImageResponse(
        options,
        {
          sourceImageUrls: references.slice(0, options.sourceImageUrls.length),
          maskImageUrl: options.maskImageUrl
            ? references[options.sourceImageUrls.length]
            : undefined,
        },
        apiKey,
        generationId,
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!submitted.ok) {
      L.warn(
        "OpenAI image submission outcome is unknown; awaiting signed receipt",
        { generationId },
      );
      return null;
    }
    if ("status" in submitted.value) {
      await set(failJob$, { job, error: submitted.value.body.error }, signal);
      return submitted.value;
    }
    await set(
      mergeBuiltInGenerationJobInternal$,
      { generationId, internal: { providerJobId: submitted.value.id } },
      signal,
    );
    return null;
  },
);

const settleStoredOpenAiImageJob$ = command(
  async (
    { get, set },
    args: { job: BuiltInGenerationWebhookJob; result: unknown },
    signal: AbortSignal,
  ) => {
    const { job } = args;
    const options = parseImageOptions(job.request);
    if ("status" in options) {
      throw new Error("Invalid persisted image request");
    }
    const result = storedImageSchema.parse(args.result);
    const settlement = settlementSchema.parse(
      job.request.__openAiImageSettlement,
    );
    const usage = settlement.mainModelUsage;
    if (usage.inputTokens < usage.cachedInputTokens) {
      throw new Error("Invalid OpenAI cached token usage");
    }
    const quantities = {
      "tokens.input": usage.inputTokens - usage.cachedInputTokens,
      "tokens.cache_read": usage.cachedInputTokens,
      "tokens.output": usage.outputTokens,
    };
    const pricing = await get(openAiImageOrchestrationPricing$);
    signal.throwIfAborted();
    const events = MAINLINE_CATEGORIES.filter((category) => {
      return quantities[category] > 0;
    }).map((category) => {
      return {
        idempotencyKey: builtInGenerationUsageIdempotencyKey({
          generationId: job.id,
          category: `orchestration:${category}`,
        }),
        orgId: job.orgId,
        userId: job.userId,
        kind: "model",
        provider: MAINLINE_PRICING_PROVIDER,
        category,
        quantity: quantities[category],
      };
    });
    await set(
      settleGeneratedImageUsage$,
      {
        generationId: job.id,
        orgId: job.orgId,
        userId: job.userId,
        runId: job.runId ?? undefined,
        billingRunId: job.billingRunId,
        billingContext: job.billingContext,
        generation: { model: options.model, billing: settlement.billing },
      },
      signal,
    );
    await set(
      recordProviderUsageBatch$,
      {
        orgId: job.orgId,
        userId: job.userId,
        runId: job.runId ?? undefined,
        billingRunId: job.billingRunId,
        billingContext: job.billingContext,
        events,
      },
      signal,
    );
    await set(
      processUsageEventKeys$,
      {
        orgId: job.orgId,
        idempotencyKeys: events.map((event) => {
          return event.idempotencyKey;
        }),
      },
      signal,
    );
    const access = await set(
      officialWorkflowCreditAccess$,
      {
        orgId: job.orgId,
        userId: job.userId,
        runId: job.billingRunId ?? job.runId ?? undefined,
      },
      signal,
    );
    const orchestrationCredits =
      access === "standard"
        ? events.reduce((total, event) => {
            const price = pricing.find((entry) => {
              return entry.category === event.category;
            });
            if (!price) {
              throw new Error("Missing OpenAI orchestration pricing");
            }
            return (
              total +
              Math.ceil((event.quantity * price.unitPrice) / price.unitSize)
            );
          }, 0)
        : 0;
    await set(finishAdmission$, { job, status: "completed" });
    signal.throwIfAborted();
    await set(
      completeBuiltInGenerationJob$,
      {
        generationId: job.id,
        result: {
          ...result,
          creditsCharged: result.creditsCharged + orchestrationCredits,
        },
      },
      signal,
    );
  },
);

const advanceOpenAiImageJob$ = command(
  async (
    { get, set },
    job: BuiltInGenerationWebhookJob,
    signal: AbortSignal,
  ) => {
    const internal = readBuiltInGenerationRequestInternal(job.request);
    if (job.status === "queued") {
      await set(submitOpenAiImageJob$, job.id, signal);
      return;
    }
    if (!internal.providerJobId) {
      return;
    }
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .select({ result: builtInGenerationJobs.result })
      .from(builtInGenerationJobs)
      .where(eq(builtInGenerationJobs.id, job.id))
      .limit(1);
    signal.throwIfAborted();
    if (row?.result) {
      await set(
        settleStoredOpenAiImageJob$,
        { job, result: row.result },
        signal,
      );
      return;
    }
    const options = parseImageOptions(job.request);
    if ("status" in options) {
      throw new Error("Invalid persisted image request");
    }
    const apiKey = env("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error("OpenAI image generation is not configured");
    }
    const response = await retrieveOpenAiImageResponse(
      internal.providerJobId,
      apiKey,
      signal,
    );
    signal.throwIfAborted();
    if ("body" in response) {
      // Retain the provider identity on an unavailable/expired result. Never POST again.
      throw new Error(response.body.error.code);
    }
    if (
      response.id !== internal.providerJobId ||
      response.metadata.generation_id !== job.id
    ) {
      throw new Error("OpenAI image response identity mismatch");
    }
    if (response.status === "queued" || response.status === "in_progress") {
      return;
    }
    const generation = parseOpenAiImageResponse(response, options);
    if ("status" in generation) {
      if (generation.body.error.code === "OPENAI_IMAGE_USAGE_UNAVAILABLE") {
        // Preserve the same stored provider response for accounting repair. A
        // missing tool-usage contract must not discard a successfully paid image.
        throw new Error("OpenAI image-tool accounting is not available");
      }
      await set(failJob$, { job, error: generation.body.error }, signal);
      return;
    }
    const pricing = await get(imagePricing$);
    signal.throwIfAborted();
    const result = await set(
      storeGeneratedImage$,
      {
        orgId: job.orgId,
        userId: job.userId,
        runId: job.runId ?? undefined,
        billingRunId: job.billingRunId,
        billingContext: job.billingContext,
        privateArtifacts: builtInGenerationIsPrivate(job.request),
        pricing,
        generation,
        generationId: job.id,
      },
      signal,
    );
    // The image and exact usage become one durable checkpoint. The next invocation
    // settles it without downloading the response or allocating a new artifact.
    const settlement = {
      billing: generation.billing,
      mainModelUsage: response.mainModelUsage,
    };
    await writeDb
      .update(builtInGenerationJobs)
      .set({
        result,
        request: sql`${builtInGenerationJobs.request} || ${JSON.stringify({ __openAiImageSettlement: settlement })}::jsonb`,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, job.id),
          inArray(builtInGenerationJobs.status, ["queued", "running"]),
          isNull(builtInGenerationJobs.result),
        ),
      );
    signal.throwIfAborted();
  },
);

const recoverOpenAiImageReceipt$ = command(
  async (
    { set },
    receipt: { eventId: string; responseId: string },
    signal: AbortSignal,
  ) => {
    const apiKey = env("OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error("OpenAI image generation is not configured");
    }
    const writeDb = set(writeDb$);
    const [known] = await writeDb
      .select({ id: builtInGenerationJobs.id })
      .from(builtInGenerationJobs)
      .where(
        sql`${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerJobId' = ${receipt.responseId}`,
      )
      .limit(1);
    signal.throwIfAborted();
    const response = known
      ? null
      : await retrieveOpenAiImageResponse(receipt.responseId, apiKey, signal);
    if (response && "body" in response) {
      throw new Error(response.body.error.code);
    }
    const generationId = response?.metadata.generation_id;
    if (generationId) {
      // Bind only to our own Responses image job, never overwrite an established identity.
      await writeDb
        .update(builtInGenerationJobs)
        .set({
          request: sql`jsonb_set(${builtInGenerationJobs.request}, '{__builtInGeneration,providerJobId}', ${JSON.stringify(receipt.responseId)}::jsonb)`,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(builtInGenerationJobs.id, generationId),
            sql`${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerTask' = 'image-response'`,
            sql`(${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerJobId' is null or ${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerJobId' = ${receipt.responseId})`,
          ),
        );
      signal.throwIfAborted();
    }
    await writeDb
      .update(openaiImageWebhookReceipts)
      .set({ processedAt: nowDate() })
      .where(eq(openaiImageWebhookReceipts.eventId, receipt.eventId));
    signal.throwIfAborted();
  },
);

// The authenticated caller can drive the same short task in previews and while
// explicitly waiting. Ownership is checked before any provider or storage I/O.
export const reconcileOwnedOpenAiImageJob$ = command(
  async (
    { set },
    args: { generationId: string; orgId: string; userId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const owned = await set(getBuiltInGenerationJob$, args, signal);
    if (!owned) {
      return false;
    }
    const job = await set(
      getBuiltInGenerationWebhookJob$,
      args.generationId,
      signal,
    );
    if (!job) {
      return true;
    }
    if (job.orgId !== args.orgId || job.userId !== args.userId) {
      return false;
    }
    const internal = readBuiltInGenerationRequestInternal(job.request);
    if (
      internal.providerTask === "image-response" &&
      (job.status === "queued" || job.status === "running")
    ) {
      const advanced = await settle(
        set(advanceOpenAiImageJob$, job, signal),
        signal,
      );
      signal.throwIfAborted();
      if (!advanced.ok) {
        L.warn("OpenAI image recovery deferred", { generationId: job.id });
      }
    }
    return true;
  },
);

// Fixed small batches; each job makes at most one provider request per invocation.
// No polling loop, sleep, provider resubmission, or webhook-owned completion work.
export const reconcileOpenAiImageJobs$ = command(
  async ({ set }, signal: AbortSignal) => {
    const writeDb = set(writeDb$);
    const receipts = await writeDb
      .select({
        eventId: openaiImageWebhookReceipts.eventId,
        responseId: openaiImageWebhookReceipts.responseId,
      })
      .from(openaiImageWebhookReceipts)
      .where(isNull(openaiImageWebhookReceipts.processedAt))
      .orderBy(asc(openaiImageWebhookReceipts.updatedAt))
      .limit(2);
    signal.throwIfAborted();
    for (const receipt of receipts) {
      // Rotate attempted receipts before provider I/O, including after a lost
      // retrieval, so an unavailable response never starves later deliveries.
      await writeDb
        .update(openaiImageWebhookReceipts)
        .set({ updatedAt: nowDate() })
        .where(eq(openaiImageWebhookReceipts.eventId, receipt.eventId));
      signal.throwIfAborted();
      const recovered = await settle(
        set(recoverOpenAiImageReceipt$, receipt, signal),
        signal,
      );
      signal.throwIfAborted();
      if (!recovered.ok) {
        L.warn("OpenAI image receipt recovery deferred", {
          eventId: receipt.eventId,
        });
      }
    }
    const jobs = await writeDb
      .select({ id: builtInGenerationJobs.id })
      .from(builtInGenerationJobs)
      .where(
        and(
          inArray(builtInGenerationJobs.status, ["queued", "running"]),
          eq(builtInGenerationJobs.type, "image"),
          sql`${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerTask' = 'image-response'`,
        ),
      )
      .orderBy(asc(builtInGenerationJobs.updatedAt))
      .limit(2);
    signal.throwIfAborted();
    for (const { id } of jobs) {
      const job = await set(getBuiltInGenerationWebhookJob$, id, signal);
      if (!job) {
        continue;
      }
      const internal = readBuiltInGenerationRequestInternal(job.request);
      if (
        receipts.some((receipt) => {
          return receipt.responseId === internal.providerJobId;
        })
      ) {
        continue;
      }
      const advanced = await settle(
        set(advanceOpenAiImageJob$, job, signal),
        signal,
      );
      signal.throwIfAborted();
      if (!advanced.ok) {
        L.warn("OpenAI image recovery deferred", { generationId: id });
      }
      // Rotate candidates even while the provider is still running or temporarily
      // unavailable, so one slow job cannot starve the rest of the fixed batch.
      await writeDb
        .update(builtInGenerationJobs)
        .set({ updatedAt: nowDate() })
        .where(eq(builtInGenerationJobs.id, id));
      signal.throwIfAborted();
    }
    const [terminal] = await writeDb
      .select({
        id: builtInGenerationJobs.id,
        request: builtInGenerationJobs.request,
      })
      .from(builtInGenerationJobs)
      .where(
        and(
          inArray(builtInGenerationJobs.status, ["completed", "failed"]),
          jobs.length > 0
            ? notInArray(
                builtInGenerationJobs.id,
                jobs.map((job) => {
                  return job.id;
                }),
              )
            : undefined,
          sql`${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerTask' = 'image-response'`,
        ),
      )
      .orderBy(asc(builtInGenerationJobs.updatedAt))
      .limit(1);
    signal.throwIfAborted();
    if (terminal) {
      const cleanup = await settle(
        set(cleanupOpenAiImageResponse$, terminal, signal),
        signal,
      );
      signal.throwIfAborted();
      if (!cleanup.ok) {
        L.warn("OpenAI image response cleanup deferred", {
          generationId: terminal.id,
        });
        await writeDb
          .update(builtInGenerationJobs)
          .set({ updatedAt: nowDate() })
          .where(eq(builtInGenerationJobs.id, terminal.id));
        signal.throwIfAborted();
      }
    }
    return { processed: jobs.length, receipts: receipts.length };
  },
);

const cleanupOpenAiImageResponse$ = command(
  async (
    { set },
    job: { id: string; request: unknown },
    signal: AbortSignal,
  ) => {
    const internal = readBuiltInGenerationRequestInternal(job.request);
    const apiKey = env("OPENAI_API_KEY");
    if (internal.providerJobId) {
      if (!apiKey) {
        throw new Error("OpenAI image generation is not configured");
      }
      await deleteOpenAiImageResponse(internal.providerJobId, apiKey, signal);
    }
    await set(
      mergeBuiltInGenerationJobInternal$,
      {
        generationId: job.id,
        internal: { providerTask: "image-response-cleaned" },
      },
      signal,
    );
  },
);
