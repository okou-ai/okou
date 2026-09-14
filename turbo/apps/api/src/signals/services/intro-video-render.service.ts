import { createHash, randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { builtInGenerationJobs } from "@okouai/db/schema/built-in-generation-job";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import {
  introVideoRenderPhaseSchema,
  introVideoRenderRequestSchema,
  introVideoRenderResponseSchema,
  introVideoRenderResultSchema,
  type IntroVideoRenderRequest,
  type IntroVideoRenderResponse,
} from "@okouai/api-contracts/contracts/intro-video-render";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { generatePrivatePresignedGetUrl } from "../external/s3";
import { onRejection, settleIncludingAbort } from "../utils";
import { storeGeneratedArtifactObject$ } from "./artifact-storage.service";
import {
  builtInGenerationIsPrivate,
  builtInGenerationPublicBrand,
  builtInGenerationRequestWithInternal,
  completeBuiltInGenerationJob$,
  failBuiltInGenerationJob$,
  markBuiltInGenerationRunning$,
  mergeBuiltInGenerationJobInternal$,
  readBuiltInGenerationRequestInternal,
} from "./built-in-generation.service";
import { builtInGenerationUsageIdempotencyKey } from "./built-in-generation-usage-idempotency";
import { heyGenBuiltInGenerationWebhookUrl } from "./built-in-generation-provider-webhooks.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import {
  downloadHyperframesVideo,
  getHyperframesRender,
  HeyGenHyperframesError,
  hyperframesPayload,
  submitHyperframesRender,
  type HeyGenHyperframesDetail,
} from "./heygen-hyperframes.service";
import {
  INTRO_VIDEO_RENDER_CATEGORY,
  INTRO_VIDEO_RENDER_PROVIDER,
  introVideoRenderPricing$,
} from "./intro-video-render-pricing.service";
import { privateArtifactCreationEnabled } from "./private-artifact-storage.service";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import {
  completeRunBuiltInAdmission$,
  isRunBuiltInAdmissionError,
  startRunBuiltInAdmission$,
} from "./run-built-in-admission.service";

const L = logger("intro-video-render");
export const INTRO_VIDEO_RENDER_TASK = "intro-video-render";
const LEASE_MS = 5 * 60 * 1000;
const REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
const stateSchema = z.object({
  phase: introVideoRenderPhaseSchema,
  projectDigest: z.string(),
  projectStorage: z.object({
    bucket: z.string().min(1),
    key: z.string().min(1),
  }),
  projectUrl: z.url(),
  callbackUrl: z.url(),
  submittedAt: z.iso.datetime().optional(),
  notice: z.string().optional(),
  artifact: introVideoRenderResultSchema.optional(),
  lease: z.object({ token: z.uuid(), claimedAt: z.iso.datetime() }).optional(),
  phaseTimes: z.record(z.string(), z.iso.datetime()),
});
type RenderState = z.infer<typeof stateSchema>;
type RenderJob = typeof builtInGenerationJobs.$inferSelect;

export function introVideoRenderHash(input: IntroVideoRenderRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(introVideoRenderRequestSchema.parse(input)))
    .digest("hex");
}

export const loadIntroVideoRenderJob$ = command(
  async ({ set }, id: string, signal: AbortSignal) => {
    const [job] = await set(writeDb$)
      .select()
      .from(builtInGenerationJobs)
      .where(eq(builtInGenerationJobs.id, id))
      .limit(1);
    signal.throwIfAborted();
    return job ?? null;
  },
);

export function isOwnedIntroVideoRender(
  job: RenderJob | null,
  owner: { readonly orgId: string; readonly userId: string },
): job is RenderJob {
  return (
    job !== null &&
    job.orgId === owner.orgId &&
    job.userId === owner.userId &&
    readBuiltInGenerationRequestInternal(job.request).providerTask ===
      INTRO_VIDEO_RENDER_TASK
  );
}

function renderNotice(
  action: string,
  notice: string | undefined,
): string | undefined {
  return action === "manual_check"
    ? "The safe submission replay window has expired. Keep this generation ID for provider reconciliation; do not submit a replacement automatically."
    : notice || undefined;
}

function recoveryAction(
  status: RenderJob["status"],
  canPoll: boolean,
  expired: boolean,
): IntroVideoRenderResponse["recovery"]["action"] {
  if (status === "failed") {
    return "none";
  }
  if (canPoll) {
    return "poll";
  }
  return expired ? "manual_check" : "replay_submission";
}

export function serializeIntroVideoRender(
  job: RenderJob,
): IntroVideoRenderResponse {
  if (job.status === "completed") {
    return introVideoRenderResponseSchema.parse(job.result);
  }
  const state = stateSchema.parse(job.request.renderState);
  const renderId =
    readBuiltInGenerationRequestInternal(job.request).providerJobId ?? null;
  const replayBefore = state.submittedAt
    ? new Date(Date.parse(state.submittedAt) + REPLAY_WINDOW_MS).toISOString()
    : undefined;
  const expired = !!replayBefore && replayBefore <= nowDate().toISOString();
  const leased =
    state.lease &&
    Date.parse(state.lease.claimedAt) + LEASE_MS > nowDate().getTime();
  const action = recoveryAction(job.status, !!renderId || !!leased, expired);
  return {
    generationId: job.id,
    type: "video",
    status: job.status,
    phase:
      job.status === "failed"
        ? "failed"
        : !renderId && expired
          ? "needs_attention"
          : state.phase,
    providerRenderId: renderId,
    input: introVideoRenderRequestSchema.parse(job.request.input),
    recovery: {
      action,
      ...(action === "poll" || action === "replay_submission"
        ? { retryAfterSeconds: 10 }
        : {}),
      ...(replayBefore ? { replayBefore } : {}),
    },
    billing: { status: "pending", creditsCharged: null },
    result: null,
    notice: renderNotice(action, state.notice),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

export const createIntroVideoRenderJob$ = command(
  async (
    { get, set },
    args: {
      readonly input: IntroVideoRenderRequest;
      readonly userId: string;
      readonly orgId: string;
      readonly runId: string;
      readonly project: {
        readonly digest: string;
        readonly bucket: string;
        readonly key: string;
        readonly url: string;
      };
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const privateArtifacts = await get(
      privateArtifactCreationEnabled(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    await set(writeDb$)
      .insert(builtInGenerationJobs)
      .values({
        id: args.input.requestId,
        type: "video",
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        request: builtInGenerationRequestWithInternal(
          {
            input: args.input,
            inputHash: introVideoRenderHash(args.input),
            renderState: {
              phase: "preparing",
              projectDigest: args.project.digest,
              projectStorage: {
                bucket: args.project.bucket,
                key: args.project.key,
              },
              projectUrl: args.project.url,
              callbackUrl: heyGenBuiltInGenerationWebhookUrl({
                generationId: args.input.requestId,
              }),
              phaseTimes: { preparing: nowDate().toISOString() },
            } satisfies RenderState,
          },
          {
            provider: "heygen",
            providerTask: INTRO_VIDEO_RENDER_TASK,
            privateArtifacts,
            publicBrand: PUBLIC_BRAND,
          },
        ),
      })
      .onConflictDoNothing({ target: builtInGenerationJobs.id });
    signal.throwIfAborted();
  },
);

const updateRenderState$ = command(
  async (
    { set },
    id: string,
    patch: Partial<RenderState>,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    if (patch.phase) {
      const [job] = await db
        .select({ request: builtInGenerationJobs.request })
        .from(builtInGenerationJobs)
        .where(eq(builtInGenerationJobs.id, id));
      signal.throwIfAborted();
      if (!job) {
        throw new Error("Cloud render disappeared");
      }
      const previous = stateSchema.parse(job.request.renderState);
      if (previous.phase !== patch.phase) {
        patch = {
          ...patch,
          phaseTimes: {
            ...previous.phaseTimes,
            [patch.phase]: nowDate().toISOString(),
          },
        };
        L.debug("Cloud render phase changed", {
          generationId: id,
          phase: patch.phase,
        });
      }
    }
    await db
      .update(builtInGenerationJobs)
      .set({
        request: sql`jsonb_set(${builtInGenerationJobs.request}, '{renderState}', ${builtInGenerationJobs.request}->'renderState' || ${JSON.stringify(patch)}::jsonb)`,
        updatedAt: nowDate(),
      })
      .where(eq(builtInGenerationJobs.id, id));
    signal.throwIfAborted();
  },
);

const releaseRenderAdmission$ = command(
  async (
    { set },
    job: RenderJob,
    status: "completed" | "failed",
  ): Promise<void> => {
    const id = readBuiltInGenerationRequestInternal(job.request).admissionId;
    if (id) {
      await set(completeRunBuiltInAdmission$, { admission: { id }, status });
    }
  },
);

const failRender$ = command(
  async (
    { set },
    job: RenderJob,
    error: { readonly code: string; readonly message: string },
    signal: AbortSignal,
  ): Promise<void> => {
    await onRejection(
      set(failBuiltInGenerationJob$, { generationId: job.id, error }, signal),
      () => {
        return set(releaseRenderAdmission$, job, "failed");
      },
    );
    signal.throwIfAborted();
    await set(releaseRenderAdmission$, job, "failed");
  },
);

// A callback can arrive before the submission response. Neither may replace
// a different provider identity that has already been verified and recorded.
const recordRenderIdentity$ = command(
  async ({ set }, id: string, renderId: string, signal: AbortSignal) => {
    const [recorded] = await set(writeDb$)
      .update(builtInGenerationJobs)
      .set({
        request: sql`jsonb_set(${builtInGenerationJobs.request}, '{__builtInGeneration,providerJobId}', ${JSON.stringify(renderId)}::jsonb)`,
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, id),
          sql`${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerTask' = ${INTRO_VIDEO_RENDER_TASK}`,
          sql`(${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerJobId' IS NULL OR ${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerJobId' = ${renderId})`,
        ),
      )
      .returning({ id: builtInGenerationJobs.id });
    signal.throwIfAborted();
    return !!recorded;
  },
);

const submitClaimedRender$ = command(
  async (
    { get, set },
    job: RenderJob,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const internal = readBuiltInGenerationRequestInternal(job.request);
    if (internal.providerJobId) {
      return;
    }
    let state = stateSchema.parse(job.request.renderState);
    if (
      state.submittedAt &&
      Date.parse(state.submittedAt) + REPLAY_WINDOW_MS <= nowDate().getTime()
    ) {
      return;
    }
    if (!internal.admissionId) {
      const admission = await set(
        startRunBuiltInAdmission$,
        { runId: job.runId ?? undefined, kind: "video" },
        signal,
      );
      if (isRunBuiltInAdmissionError(admission)) {
        await set(
          updateRenderState$,
          job.id,
          { notice: admission.body.error.message },
          signal,
        );
        return;
      }
      if (admission) {
        await set(
          mergeBuiltInGenerationJobInternal$,
          { generationId: job.id, internal: { admissionId: admission.id } },
          signal,
        );
      }
    }
    if (!job.startedAt) {
      await set(markBuiltInGenerationRunning$, job.id, signal);
    }
    if (!state.submittedAt) {
      // An admitted job may wait days before its first provider submission.
      // Renew only before that first attempt; all replays keep the exact body.
      const projectUrl = await get(
        generatePrivatePresignedGetUrl(
          state.projectStorage.bucket,
          state.projectStorage.key,
          26 * 60 * 60,
        ),
      );
      signal.throwIfAborted();
      state = { ...state, projectUrl };
    }
    const submittedAt = state.submittedAt ?? nowDate().toISOString();
    await set(
      updateRenderState$,
      job.id,
      {
        phase: "submitting",
        submittedAt,
        projectUrl: state.projectUrl,
        notice: "",
      },
      signal,
    );
    const input = introVideoRenderRequestSchema.parse(job.request.input);
    const submitted = await settleIncludingAbort(
      submitHyperframesRender(
        hyperframesPayload(input, state.projectUrl, state.callbackUrl),
        apiKey,
        signal,
      ),
    );
    if (signal.aborted) {
      if (submitted.ok) {
        await set(recordRenderIdentity$, job.id, submitted.value, signal);
      }
      signal.throwIfAborted();
    }
    // Persist a returned identity even when the request owner has disconnected.
    if (submitted.ok) {
      if (
        !(await set(recordRenderIdentity$, job.id, submitted.value, signal))
      ) {
        throw new Error("HeyGen returned a conflicting render identity");
      }
      await set(
        updateRenderState$,
        job.id,
        { phase: "queued", notice: "" },
        signal,
      );
    } else {
      const error = submitted.error;
      if (
        error instanceof HeyGenHyperframesError &&
        [400, 401, 402, 403, 422].includes(error.status)
      ) {
        const latest = await set(loadIntroVideoRenderJob$, job.id, signal);
        if (latest) {
          await set(
            failRender$,
            latest,
            { code: error.code, message: error.message },
            signal,
          );
        }
      } else {
        await set(
          updateRenderState$,
          job.id,
          {
            phase: "submission_unknown",
            notice:
              "Submission is not yet confirmed. Resume this generation with the original request ID.",
          },
          signal,
        );
      }
    }
    signal.throwIfAborted();
  },
);

const settleRenderCredits$ = command(
  async (
    { get, set },
    job: RenderJob,
    durationSeconds: number,
    signal: AbortSignal,
  ): Promise<number> => {
    if (!(await get(introVideoRenderPricing$))) {
      throw new Error("Cloud render pricing is not configured");
    }
    signal.throwIfAborted();
    const idempotencyKey = builtInGenerationUsageIdempotencyKey({
      generationId: job.id,
      scope: INTRO_VIDEO_RENDER_TASK,
      category: INTRO_VIDEO_RENDER_CATEGORY,
    });
    const db = set(writeDb$);
    await db
      .insert(usageEvent)
      .values({
        runId: job.runId,
        billingRunId: job.billingRunId,
        billingContext: job.billingContext,
        idempotencyKey,
        orgId: job.orgId,
        userId: job.userId,
        kind: "video",
        provider: INTRO_VIDEO_RENDER_PROVIDER,
        category: INTRO_VIDEO_RENDER_CATEGORY,
        quantity: Math.max(1, Math.ceil(durationSeconds)),
      })
      .onConflictDoNothing({ target: usageEvent.idempotencyKey });
    signal.throwIfAborted();
    await set(processOrgUsageEvents$, job.orgId, signal);
    const [usage] = await db
      .select({
        status: usageEvent.status,
        creditsCharged: usageEvent.creditsCharged,
        billingError: usageEvent.billingError,
      })
      .from(usageEvent)
      .where(eq(usageEvent.idempotencyKey, idempotencyKey));
    signal.throwIfAborted();
    if (
      !usage ||
      usage.status !== "processed" ||
      usage.creditsCharged === null ||
      usage.billingError
    ) {
      throw new Error("Cloud render settlement needs reconciliation");
    }
    return usage.creditsCharged;
  },
);

const persistRender$ = command(
  async (
    { set },
    job: RenderJob,
    detail: HeyGenHyperframesDetail,
    signal: AbortSignal,
  ): Promise<void> => {
    const state = stateSchema.parse(job.request.renderState);
    let artifact = state.artifact;
    if (!artifact) {
      if (!detail.video_url || !detail.duration) {
        throw new Error("HeyGen returned incomplete render output");
      }
      await set(
        updateRenderState$,
        job.id,
        { phase: "persisting", notice: "" },
        signal,
      );
      const bytes = await downloadHyperframesVideo(detail.video_url, signal);
      const stored = await set(
        storeGeneratedArtifactObject$,
        {
          userId: job.userId,
          orgId: job.orgId,
          privateArtifacts: builtInGenerationIsPrivate(job.request),
          identity: { id: job.id, variant: INTRO_VIDEO_RENDER_TASK },
          filenamePrefix: "intro-video",
          extension: "mp4",
          body: bytes,
          contentType: "video/mp4",
          publicBrand: builtInGenerationPublicBrand(job.request),
        },
        signal,
      );
      artifact = {
        url: stored.url,
        filename: stored.filename,
        contentType: "video/mp4",
        size: bytes.length,
        durationSeconds: detail.duration,
        ...(detail.width ? { width: detail.width } : {}),
        ...(detail.height ? { height: detail.height } : {}),
        ...(detail.fps ? { fps: detail.fps } : {}),
      };
      await set(
        recordWebUploadedFile$,
        {
          runId: job.runId ?? undefined,
          externalId: stored.id,
          userId: job.userId,
          orgId: job.orgId,
          filename: stored.filename,
          contentType: "video/mp4",
          sizeBytes: bytes.length,
          url: stored.url,
          s3Key: stored.key,
          publicBrand: builtInGenerationPublicBrand(job.request),
          metadata: {
            generatedBy: INTRO_VIDEO_RENDER_TASK,
            provider: "heygen",
            providerRenderId: readBuiltInGenerationRequestInternal(job.request)
              .providerJobId,
          },
        },
        signal,
      );
      await set(updateRenderState$, job.id, { artifact }, signal);
    }
    await set(
      updateRenderState$,
      job.id,
      { phase: "settling", notice: "" },
      signal,
    );
    const creditsCharged = await set(
      settleRenderCredits$,
      job,
      artifact.durationSeconds,
      signal,
    );
    const result: IntroVideoRenderResponse = {
      ...serializeIntroVideoRender(job),
      status: "completed",
      phase: "completed",
      result: artifact,
      billing: { status: "settled", creditsCharged },
      recovery: { action: "none" },
      completedAt: nowDate().toISOString(),
      notice: undefined,
    };
    await onRejection(
      set(
        completeBuiltInGenerationJob$,
        { generationId: job.id, result },
        signal,
      ),
      () => {
        return set(releaseRenderAdmission$, job, "completed");
      },
    );
    signal.throwIfAborted();
    await set(releaseRenderAdmission$, job, "completed");
  },
);

const reconcileClaimedRender$ = command(
  async (
    { set },
    job: RenderJob,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const id = readBuiltInGenerationRequestInternal(job.request).providerJobId;
    if (!id) {
      return;
    }
    const detail = await getHyperframesRender(id, apiKey, signal);
    if (detail.callback_id && detail.callback_id !== job.id) {
      throw new Error("HeyGen callback identity does not match the render");
    }
    if (detail.status === "failed") {
      await set(
        failRender$,
        job,
        {
          code: "HEYGEN_RENDER_FAILED",
          message: detail.failure_message ?? "HeyGen cloud rendering failed",
        },
        signal,
      );
    } else if (detail.status === "completed") {
      await set(persistRender$, job, detail, signal);
    } else {
      await set(
        updateRenderState$,
        job.id,
        { phase: detail.status, notice: "" },
        signal,
      );
    }
  },
);

const releaseRenderLease$ = command(
  async ({ set }, id: string, token: string): Promise<void> => {
    await set(writeDb$)
      .update(builtInGenerationJobs)
      .set({
        request: sql`${builtInGenerationJobs.request} #- '{renderState,lease}'`,
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, id),
          sql`${builtInGenerationJobs.request}->'renderState'->'lease'->>'token' = ${token}`,
        ),
      );
  },
);

const reconcileLeaseOwner$ = command(
  async (
    { set },
    id: string,
    submit: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    let job = await set(loadIntroVideoRenderJob$, id, signal);
    if (!job) {
      return;
    }
    const apiKey = env("HEYGEN_API_KEY");
    if (!apiKey) {
      throw new Error("Platform HeyGen rendering is not configured");
    }
    if (submit) {
      await set(submitClaimedRender$, job, apiKey, signal);
    }
    job = await set(loadIntroVideoRenderJob$, id, signal);
    if (job && job.status !== "failed" && job.status !== "completed") {
      await set(reconcileClaimedRender$, job, apiKey, signal);
    }
  },
);

/** One lease owns submission and finalization; GET never performs a paid POST. */
export const reconcileIntroVideoRender$ = command(
  async (
    { set },
    id: string,
    submit: boolean,
    signal: AbortSignal,
  ): Promise<void> => {
    const token = randomUUID();
    const claimedAt = nowDate().toISOString();
    const cutoff = new Date(nowDate().getTime() - LEASE_MS).toISOString();
    const db = set(writeDb$);
    const [claimed] = await db
      .update(builtInGenerationJobs)
      .set({
        request: sql`jsonb_set(${builtInGenerationJobs.request}, '{renderState,lease}', ${JSON.stringify({ token, claimedAt })}::jsonb)`,
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, id),
          inArray(builtInGenerationJobs.status, ["queued", "running"]),
          sql`${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerTask' = ${INTRO_VIDEO_RENDER_TASK}`,
          sql`(${builtInGenerationJobs.request}->'renderState'->'lease' IS NULL OR ${builtInGenerationJobs.request}->'renderState'->'lease'->>'claimedAt' < ${cutoff})`,
        ),
      )
      .returning({ id: builtInGenerationJobs.id });
    if (signal.aborted) {
      await set(releaseRenderLease$, id, token);
      signal.throwIfAborted();
    }
    if (!claimed) {
      return;
    }
    const operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(LEASE_MS - 60_000),
    ]);
    const outcome = await settleIncludingAbort(
      set(reconcileLeaseOwner$, id, submit, operationSignal),
    );
    if (signal.aborted) {
      await set(releaseRenderLease$, id, token);
      signal.throwIfAborted();
    }
    await set(releaseRenderLease$, id, token);
    signal.throwIfAborted();
    if (!outcome.ok) {
      const error = outcome.error;
      await set(
        updateRenderState$,
        id,
        {
          notice:
            error instanceof HeyGenHyperframesError
              ? error.message
              : "Cloud render processing was interrupted. Resume this generation ID.",
        },
        signal,
      );
      L.warn("Cloud render needs reconciliation", {
        generationId: id,
        code:
          error instanceof HeyGenHyperframesError
            ? error.code
            : "RECONCILE_INTERRUPTED",
      });
    }
  },
);

export const recordIntroVideoRenderCallback$ = command(
  async (
    { set },
    id: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<void> => {
    const callback = z
      .object({
        event_data: z
          .object({
            render_id: z.string().optional(),
            video_id: z.string().optional(),
            callback_id: z.string().optional(),
          })
          .optional(),
        data: z
          .object({
            render_id: z.string().optional(),
            video_id: z.string().optional(),
            callback_id: z.string().optional(),
          })
          .optional(),
        render_id: z.string().optional(),
        video_id: z.string().optional(),
        callback_id: z.string().optional(),
      })
      .safeParse(body);
    if (callback.success) {
      const data =
        callback.data.event_data ?? callback.data.data ?? callback.data;
      const candidate = data.render_id ?? data.video_id;
      if (candidate && data.callback_id === id) {
        const job = await set(loadIntroVideoRenderJob$, id, signal);
        if (!job || job.status === "completed" || job.status === "failed") {
          return;
        }
        const known = readBuiltInGenerationRequestInternal(
          job.request,
        ).providerJobId;
        if (known && known !== candidate) {
          return;
        }
        const apiKey = env("HEYGEN_API_KEY");
        if (!apiKey) {
          throw new Error("Platform HeyGen rendering is not configured");
        }
        const detail = await getHyperframesRender(candidate, apiKey, signal);
        if (detail.callback_id !== id) {
          throw new Error("HeyGen callback identity could not be verified");
        }
        if (!(await set(recordRenderIdentity$, id, candidate, signal))) {
          return;
        }
      }
    }
    await set(reconcileIntroVideoRender$, id, false, signal);
  },
);
