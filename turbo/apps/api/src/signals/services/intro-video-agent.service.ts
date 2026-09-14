import { createHash, randomUUID } from "node:crypto";

import { command } from "ccstate";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  introVideoAgentGenerateRequestSchema,
  introVideoAgentResponseSchema,
  type IntroVideoAgentGenerateRequest,
  type IntroVideoAgentResponse,
} from "@okouai/api-contracts/contracts/intro-video-agent";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { builtInGenerationJobs } from "@okouai/db/schema/built-in-generation-job";
import { usageEvent } from "@okouai/db/schema/usage-event";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { onRejection, settle, settleIncludingAbort } from "../utils";
import { writeDb$ } from "../external/db";
import { generatePresignedGetUrl, s3ObjectHead } from "../external/s3";
import {
  resolveOwnedPublicArtifactKey$,
  storeGeneratedArtifactObject$,
} from "./artifact-storage.service";
import {
  builtInGenerationPublicBrand,
  builtInGenerationIsPrivate,
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
  downloadHeyGenVideoAgentVideo,
  getHeyGenAvatarVideoStatus,
  getHeyGenVideoAgentSession,
  isHeyGenErrorResponse,
  submitHeyGenVideoAgent,
  type HeyGenErrorResponse,
  type HeyGenVideoAgentSession,
} from "./heygen.service";
import { introVideoAgentPricing$ } from "./intro-video-agent-pricing.service";
import {
  artifactFileReference,
  privateArtifactCreationEnabled,
} from "./private-artifact-storage.service";
import { uploadedArtifactObject } from "./uploaded-artifact.service";
import { recordWebUploadedFile$ } from "./run-uploaded-files.service";
import {
  completeRunBuiltInAdmission$,
  isRunBuiltInAdmissionError,
  startRunBuiltInAdmission$,
  type RunBuiltInAdmission,
} from "./run-built-in-admission.service";

const PROVIDER_TASK = "intro-video-agent";
const REFERENCE_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "application/pdf",
]);
const MAX_REFERENCE_BYTES = 32_000_000;
const COMPLETION_LEASE_MS = 5 * 60 * 1000;
const SUBMISSION_NOTICE =
  "Submission is pending or unconfirmed. Resume this generation ID; do not submit another paid generation or switch routes.";

export function introVideoAgentError(message: string, code = "BAD_REQUEST") {
  return { error: { message, code } };
}

export function introVideoAgentRequestHash(
  input: IntroVideoAgentGenerateRequest,
): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export const loadIntroVideoAgentJob$ = command(
  async ({ set }, generationId: string, signal: AbortSignal) => {
    const [job] = await set(writeDb$)
      .select()
      .from(builtInGenerationJobs)
      .where(eq(builtInGenerationJobs.id, generationId))
      .limit(1);
    signal.throwIfAborted();
    return job ?? null;
  },
);

type IntroVideoAgentJob = typeof builtInGenerationJobs.$inferSelect;

export function serializeIntroVideoAgentJob(
  job: IntroVideoAgentJob,
): IntroVideoAgentResponse {
  const internal = readBuiltInGenerationRequestInternal(job.request);
  const options = introVideoAgentGenerateRequestSchema.parse(job.request);
  const result =
    job.status === "completed"
      ? introVideoAgentResponseSchema.parse(job.result)
      : {};
  return {
    ...result,
    generationId: job.id,
    status: job.status,
    sessionId: internal.providerSessionId ?? null,
    videoId: internal.providerJobId ?? null,
    ...(internal.providerStatus
      ? {
          providerStatus:
            job.status === "completed" || job.status === "failed"
              ? job.status
              : internal.providerStatus,
        }
      : {}),
    ...(internal.providerNotice &&
    (job.status === "queued" || job.status === "running")
      ? { notice: internal.providerNotice }
      : {}),
    ...(job.error ? { error: job.error } : {}),
    styleId: options.styleId,
    avatarId: options.avatarId,
    voiceId: options.voiceId,
    orientation: options.orientation,
  };
}

export const resolveIntroVideoAgentReferences$ = command(
  async (
    { get, set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly urls: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<
    | readonly string[]
    | { readonly error: { readonly message: string; readonly code: string } }
  > => {
    const urls: string[] = [];
    for (const url of args.urls) {
      const reference = artifactFileReference(url);
      const object = reference
        ? await get(
            uploadedArtifactObject({
              id: reference.id,
              userId: args.userId,
              orgId: args.orgId,
            }),
          )
        : null;
      signal.throwIfAborted();
      const bucket = object?.bucket ?? env("R2_USER_ARTIFACTS_BUCKET_NAME");
      const key = reference
        ? object?.key
        : await set(
            resolveOwnedPublicArtifactKey$,
            { userId: args.userId, url },
            signal,
          );
      if (!key) {
        return introVideoAgentError(
          "Reference files must be uploaded to Okou by the current user. Use okou web upload-file for prepared files.",
        );
      }
      const head = await get(s3ObjectHead(bucket, key));
      signal.throwIfAborted();
      if (
        head.kind !== "found" ||
        !head.contentType ||
        !REFERENCE_TYPES.includes(head.contentType.toLowerCase()) ||
        !head.contentLength ||
        head.contentLength > MAX_REFERENCE_BYTES
      ) {
        return introVideoAgentError(
          "Use PNG/JPEG, MP4/WebM, MP3/WAV or PDF reference files up to 32 MB each. Prepare PPT as PDF and include document text in the prompt or a PDF.",
        );
      }
      urls.push(
        await get(
          generatePresignedGetUrl(bucket, key, 24 * 60 * 60, undefined, true),
        ),
      );
      signal.throwIfAborted();
    }
    return urls;
  },
);

export const createIntroVideoAgentJob$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string;
      readonly publicBrand: PublicBrand;
      readonly input: IntroVideoAgentGenerateRequest;
      readonly options: IntroVideoAgentGenerateRequest;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const privateArtifacts = await get(
      privateArtifactCreationEnabled(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    const [created] = await set(writeDb$)
      .insert(builtInGenerationJobs)
      .values({
        id: args.input.requestId,
        type: "video",
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId,
        request: builtInGenerationRequestWithInternal(
          {
            ...args.options,
            purpose: PROVIDER_TASK,
            inputHash: introVideoAgentRequestHash(args.input),
          },
          {
            publicBrand: args.publicBrand,
            privateArtifacts,
            provider: "heygen",
            providerTask: PROVIDER_TASK,
            providerStatus: "submitting",
            providerNotice: SUBMISSION_NOTICE,
          },
        ),
      })
      .onConflictDoNothing({ target: builtInGenerationJobs.id })
      .returning({ id: builtInGenerationJobs.id });
    signal.throwIfAborted();
    return created !== undefined;
  },
);

export const recordIntroVideoAgentIdentity$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly sessionId?: string;
      readonly videoId?: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const ids = {
      ...(args.sessionId ? { providerSessionId: args.sessionId } : {}),
      ...(args.videoId ? { providerJobId: args.videoId } : {}),
    };
    const storedSession = sql`${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerSessionId'`;
    const storedVideo = sql`${builtInGenerationJobs.request}->'__builtInGeneration'->>'providerJobId'`;
    const [recorded] = await set(writeDb$)
      .update(builtInGenerationJobs)
      .set({
        request: sql`jsonb_set(${builtInGenerationJobs.request}, '{__builtInGeneration}', ${builtInGenerationJobs.request}->'__builtInGeneration' || ${JSON.stringify(ids)}::jsonb)`,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, args.generationId),
          args.sessionId
            ? or(isNull(storedSession), eq(storedSession, args.sessionId))
            : undefined,
          args.videoId
            ? or(isNull(storedVideo), eq(storedVideo, args.videoId))
            : undefined,
        ),
      )
      .returning({ id: builtInGenerationJobs.id });
    signal.throwIfAborted();
    return recorded !== undefined;
  },
);

const completeAgentAdmission$ = command(
  async (
    { set },
    args: {
      readonly job: IntroVideoAgentJob;
      readonly status: "completed" | "failed";
    },
  ): Promise<void> => {
    const admissionId = readBuiltInGenerationRequestInternal(
      args.job.request,
    ).admissionId;
    await set(completeRunBuiltInAdmission$, {
      admission: admissionId ? { id: admissionId } : null,
      status: args.status,
    });
  },
);

const markAgentSubmissionUnknown$ = command(
  async ({ set }, generationId: string, signal: AbortSignal): Promise<void> => {
    await set(
      mergeBuiltInGenerationJobInternal$,
      {
        generationId,
        internal: {
          providerStatus: "submission_unknown",
          providerNotice: SUBMISSION_NOTICE,
        },
      },
      signal,
    );
  },
);

const rejectAgentSubmission$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly error: { readonly message: string; readonly code: string };
      readonly admission: RunBuiltInAdmission | null;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    // A confirmed rejection stays terminal after caller cancellation too.
    const releaseAdmission = () => {
      return set(completeRunBuiltInAdmission$, {
        admission: args.admission,
        status: "failed",
      });
    };
    await onRejection(
      (async () => {
        await set(
          failBuiltInGenerationJob$,
          { generationId: args.generationId, error: args.error },
          signal,
        );
        await releaseAdmission();
      })(),
      releaseAdmission,
    );
    signal.throwIfAborted();
  },
);

function isRejectedAgentSubmission(
  response: HeyGenVideoAgentSession | HeyGenErrorResponse,
): response is HeyGenErrorResponse & { readonly status: 400 } {
  return isHeyGenErrorResponse(response) && response.status === 400;
}

export const submitIntroVideoAgentJob$ = command(
  async (
    { set },
    args: {
      readonly job: IntroVideoAgentJob;
      readonly fileUrls: readonly string[];
      readonly apiKey: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const options = introVideoAgentGenerateRequestSchema.parse(
      args.job.request,
    );
    const admission = await set(
      startRunBuiltInAdmission$,
      { runId: args.job.runId ?? undefined, kind: "video" },
      signal,
    );
    if (isRunBuiltInAdmissionError(admission)) {
      await set(
        failBuiltInGenerationJob$,
        { generationId: args.job.id, error: admission.body.error },
        signal,
      );
      return;
    }
    await set(
      mergeBuiltInGenerationJobInternal$,
      { generationId: args.job.id, internal: { admissionId: admission?.id } },
      signal,
    );
    await set(markBuiltInGenerationRunning$, args.job.id, signal);
    // The job is committed before this sole billed POST. An uncertain response
    // never authorizes resubmission: the caller can only reconcile this job.
    const submitted = await settleIncludingAbort(
      submitHeyGenVideoAgent(
        { ...options, fileUrls: args.fileUrls },
        {
          generationId: args.job.id,
          callbackUrl: heyGenBuiltInGenerationWebhookUrl({
            generationId: args.job.id,
          }),
        },
        args.apiKey,
        signal,
      ),
    );
    if (signal.aborted) {
      // Cancellation after the paid POST must retain any returned identifiers
      // before propagating abort. These writes commit before checking signal.
      if (submitted.ok && isRejectedAgentSubmission(submitted.value)) {
        await set(
          rejectAgentSubmission$,
          {
            generationId: args.job.id,
            error: submitted.value.body.error,
            admission,
          },
          signal,
        );
      } else if (submitted.ok && !isHeyGenErrorResponse(submitted.value)) {
        await set(
          recordIntroVideoAgentIdentity$,
          {
            generationId: args.job.id,
            sessionId: submitted.value.sessionId,
            ...(submitted.value.videoId
              ? { videoId: submitted.value.videoId }
              : {}),
          },
          signal,
        );
      } else {
        await set(markAgentSubmissionUnknown$, args.job.id, signal);
      }
      signal.throwIfAborted();
    }
    if (submitted.ok && isRejectedAgentSubmission(submitted.value)) {
      await set(
        rejectAgentSubmission$,
        {
          generationId: args.job.id,
          error: submitted.value.body.error,
          admission,
        },
        signal,
      );
      return;
    }
    if (!submitted.ok) {
      await set(markAgentSubmissionUnknown$, args.job.id, signal);
      return;
    }
    const session = submitted.value;
    if (isHeyGenErrorResponse(session)) {
      await set(markAgentSubmissionUnknown$, args.job.id, signal);
      return;
    }
    const recorded = await set(
      recordIntroVideoAgentIdentity$,
      {
        generationId: args.job.id,
        sessionId: session.sessionId,
        ...(session.videoId ? { videoId: session.videoId } : {}),
      },
      signal,
    );
    if (!recorded) {
      throw new Error("HeyGen returned conflicting Video Agent identifiers");
    }
    const latest = await set(loadIntroVideoAgentJob$, args.job.id, signal);
    if (latest?.status === "running" || latest?.status === "queued") {
      await set(
        mergeBuiltInGenerationJobInternal$,
        {
          generationId: args.job.id,
          internal: { providerStatus: session.status, providerNotice: "" },
        },
        signal,
      );
    }
  },
);

const claimAgentReconciliation$ = command(
  async (
    { set },
    generationId: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const token = randomUUID();
    const cutoff = new Date(
      nowDate().getTime() - COMPLETION_LEASE_MS,
    ).toISOString();
    const [claimed] = await set(writeDb$)
      .update(builtInGenerationJobs)
      .set({
        request: sql`${builtInGenerationJobs.request} || ${JSON.stringify({ completionLease: { token, claimedAt: nowDate().toISOString() } })}::jsonb`,
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, generationId),
          inArray(builtInGenerationJobs.status, ["queued", "running"]),
          sql`(${builtInGenerationJobs.request}->'completionLease' IS NULL OR ${builtInGenerationJobs.request}->'completionLease'->>'claimedAt' < ${cutoff})`,
        ),
      )
      .returning({ id: builtInGenerationJobs.id });
    signal.throwIfAborted();
    return claimed ? token : null;
  },
);

const finishAgentCompletion$ = command(
  async (
    { set },
    args: {
      readonly job: IntroVideoAgentJob;
      readonly result: IntroVideoAgentResponse;
      readonly videoId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      mergeBuiltInGenerationJobInternal$,
      {
        generationId: args.job.id,
        internal: {
          providerStatus: "completed",
          providerNotice: "",
          providerJobId: args.videoId,
        },
      },
      signal,
    );
    const releaseAdmission = () => {
      return set(completeAgentAdmission$, {
        job: args.job,
        status: "completed",
      });
    };
    await onRejection(
      (async () => {
        await set(
          completeBuiltInGenerationJob$,
          { generationId: args.job.id, result: args.result },
          signal,
        );
        await releaseAdmission();
      })(),
      releaseAdmission,
    );
    signal.throwIfAborted();
  },
);

const persistAgentCompletion$ = command(
  async (
    { get, set },
    args: {
      readonly job: IntroVideoAgentJob;
      readonly status: Extract<
        Awaited<ReturnType<typeof getHeyGenAvatarVideoStatus>>,
        { readonly kind: "completed" }
      >;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const pricing = await get(introVideoAgentPricing$);
    signal.throwIfAborted();
    if (!pricing) {
      throw new Error("HeyGen Video Agent pricing is not configured");
    }
    const downloaded = await downloadHeyGenVideoAgentVideo(args.status, signal);
    if (isHeyGenErrorResponse(downloaded)) {
      throw new Error(downloaded.body.error.message);
    }
    const artifact = await set(
      storeGeneratedArtifactObject$,
      {
        userId: args.job.userId,
        orgId: args.job.orgId,
        privateArtifacts: builtInGenerationIsPrivate(args.job.request),
        identity: { id: args.job.id, variant: PROVIDER_TASK },
        filenamePrefix: "intro-video",
        extension: "mp4",
        body: downloaded.videoBytes,
        contentType: "video/mp4",
        publicBrand: builtInGenerationPublicBrand(args.job.request),
      },
      signal,
    );
    const options = introVideoAgentGenerateRequestSchema.parse(
      args.job.request,
    );
    const quantity = Math.max(1, Math.ceil(downloaded.durationSeconds));
    const result: IntroVideoAgentResponse = {
      generationId: args.job.id,
      status: "completed",
      sessionId:
        readBuiltInGenerationRequestInternal(args.job.request)
          .providerSessionId ?? null,
      videoId: downloaded.providerVideoId,
      styleId: options.styleId,
      avatarId: options.avatarId,
      voiceId: options.voiceId,
      orientation: options.orientation,
      providerStatus: "completed",
      filename: artifact.filename,
      contentType: "video/mp4",
      size: downloaded.videoBytes.byteLength,
      url: artifact.url,
      durationSeconds: downloaded.durationSeconds,
      creditsCharged: Math.ceil(
        (quantity * pricing.unitPrice) / pricing.unitSize,
      ),
    };
    await set(
      recordWebUploadedFile$,
      {
        runId: args.job.runId ?? undefined,
        externalId: artifact.id,
        userId: args.job.userId,
        orgId: args.job.orgId,
        filename: artifact.filename,
        contentType: "video/mp4",
        sizeBytes: downloaded.videoBytes.byteLength,
        url: artifact.url,
        s3Key: artifact.key,
        publicBrand: builtInGenerationPublicBrand(args.job.request),
        metadata: {
          generatedBy: "zero-internal-intro-video-agent",
          provider: "heygen",
          model: "heygen-video-agent",
          providerSessionId: result.sessionId,
          providerVideoId: result.videoId,
          styleId: options.styleId,
          avatarId: options.avatarId,
          voiceId: options.voiceId,
          orientation: options.orientation,
          durationSeconds: downloaded.durationSeconds,
          billingQuantity: quantity,
        },
      },
      signal,
    );
    await db
      .insert(usageEvent)
      .values({
        runId: args.job.runId,
        billingRunId: args.job.billingRunId,
        billingContext: args.job.billingContext,
        idempotencyKey: builtInGenerationUsageIdempotencyKey({
          generationId: args.job.id,
          scope: PROVIDER_TASK,
          category: pricing.category,
        }),
        orgId: args.job.orgId,
        userId: args.job.userId,
        kind: "video",
        provider: pricing.provider,
        category: pricing.category,
        quantity,
      })
      .onConflictDoNothing({ target: usageEvent.idempotencyKey });
    signal.throwIfAborted();
    await set(processOrgUsageEvents$, args.job.orgId, signal);
    await set(
      finishAgentCompletion$,
      { job: args.job, result, videoId: downloaded.providerVideoId },
      signal,
    );
  },
);

function agentSessionProgress(session: HeyGenVideoAgentSession): {
  readonly known: boolean;
  readonly notice: string;
} {
  const known = [
    "thinking",
    "waiting_for_input",
    "reviewing",
    "generating",
    "completed",
    "failed",
  ].includes(session.status);
  let notice = "";
  if (!known) {
    notice = `Unexpected HeyGen session state: ${session.status}. Keep this generation ID; do not resubmit.`;
  } else if (session.status === "waiting_for_input") {
    notice =
      "HeyGen requires input in this generate-mode session. Keep this generation ID and report the blocked session; do not resubmit or switch routes.";
  } else if (session.status === "completed" && !session.videoId) {
    notice =
      "HeyGen reports a completed session without a video ID. Resume this generation to reconcile; do not resubmit.";
  }
  return { known, notice };
}

const failAgentGeneration$ = command(
  async (
    { set },
    args: { readonly job: IntroVideoAgentJob; readonly message: string },
    signal: AbortSignal,
  ): Promise<void> => {
    const releaseAdmission = () => {
      return set(completeAgentAdmission$, { job: args.job, status: "failed" });
    };
    await onRejection(
      (async () => {
        await set(
          failBuiltInGenerationJob$,
          {
            generationId: args.job.id,
            error: { code: "HEYGEN_GENERATION_FAILED", message: args.message },
          },
          signal,
        );
        await releaseAdmission();
      })(),
      releaseAdmission,
    );
    signal.throwIfAborted();
  },
);

const reconcileAgentSession$ = command(
  async (
    { set },
    args: { readonly job: IntroVideoAgentJob; readonly apiKey: string },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const { job, apiKey } = args;
    const generationId = job.id;
    const internal = readBuiltInGenerationRequestInternal(job.request);
    const videoId = internal.providerJobId;
    // Once assigned, the video endpoint owns rendering progress.
    if (videoId) {
      return videoId;
    }
    if (!internal.providerSessionId) {
      return null;
    }
    const sessionResult = await settle(
      getHeyGenVideoAgentSession(internal.providerSessionId, apiKey, signal),
      signal,
    );
    if (!sessionResult.ok || isHeyGenErrorResponse(sessionResult.value)) {
      const message =
        sessionResult.ok && isHeyGenErrorResponse(sessionResult.value)
          ? sessionResult.value.body.error.message
          : "Provider status is temporarily unavailable.";
      await set(
        mergeBuiltInGenerationJobInternal$,
        {
          generationId,
          internal: {
            providerNotice: `${message} Resume this generation; do not submit again.`,
          },
        },
        signal,
      );
      return null;
    }
    const session = sessionResult.value;
    const { known, notice } = agentSessionProgress(session);
    if (session.videoId) {
      const recorded = await set(
        recordIntroVideoAgentIdentity$,
        { generationId, videoId: session.videoId },
        signal,
      );
      if (!recorded) {
        throw new Error(
          "HeyGen returned conflicting Video Agent video identifiers",
        );
      }
    }
    await set(
      mergeBuiltInGenerationJobInternal$,
      {
        generationId,
        internal: { providerStatus: session.status, providerNotice: notice },
      },
      signal,
    );
    if (session.status === "failed") {
      await set(
        failAgentGeneration$,
        {
          job,
          message:
            "HeyGen Video Agent generation failed. No replacement video was submitted.",
        },
        signal,
      );
      return null;
    }
    return known ? session.videoId : null;
  },
);

const reconcileClaimedIntroVideoAgentJob$ = command(
  async ({ set }, generationId: string, signal: AbortSignal): Promise<void> => {
    const job = await set(loadIntroVideoAgentJob$, generationId, signal);
    if (!job || job.status === "completed" || job.status === "failed") {
      return;
    }
    if (
      readBuiltInGenerationRequestInternal(job.request).providerTask !==
      PROVIDER_TASK
    ) {
      throw new Error("Expected a native Intro Video Agent job");
    }
    const apiKey = env("HEYGEN_API_KEY");
    if (!apiKey) {
      throw new Error("HeyGen Video Agent is not configured");
    }
    const videoId = await set(reconcileAgentSession$, { job, apiKey }, signal);
    if (!videoId) {
      return;
    }
    const videoResult = await settle(
      getHeyGenAvatarVideoStatus(videoId, apiKey, signal),
      signal,
    );
    if (!videoResult.ok || isHeyGenErrorResponse(videoResult.value)) {
      const message =
        videoResult.ok && isHeyGenErrorResponse(videoResult.value)
          ? videoResult.value.body.error.message
          : "Video status is temporarily unavailable.";
      await set(
        mergeBuiltInGenerationJobInternal$,
        {
          generationId,
          internal: {
            providerNotice: `${message} Resume this generation; do not submit again.`,
          },
        },
        signal,
      );
      return;
    }
    const status = videoResult.value;
    if (status.kind === "failed") {
      await set(
        failAgentGeneration$,
        {
          job,
          message:
            "HeyGen Video Agent rendering failed. No replacement video was submitted.",
        },
        signal,
      );
    } else if (status.kind === "completed") {
      const latest = await set(loadIntroVideoAgentJob$, generationId, signal);
      if (latest) {
        await set(persistAgentCompletion$, { job: latest, status }, signal);
      }
    }
  },
);

// A short, renewable-by-retry lease serializes callback and poll reconciliation.
// If a worker disappears, the same job is recoverable after the lease expires;
// the usage event remains independently idempotent across recovery attempts.
export const reconcileIntroVideoAgentJob$ = command(
  async ({ set }, generationId: string, signal: AbortSignal): Promise<void> => {
    const lease = await set(claimAgentReconciliation$, generationId, signal);
    if (!lease) {
      return;
    }
    const db = set(writeDb$);
    const release = async () => {
      await db
        .update(builtInGenerationJobs)
        .set({
          request: sql`${builtInGenerationJobs.request} - 'completionLease'`,
        })
        .where(
          and(
            eq(builtInGenerationJobs.id, generationId),
            eq(
              sql`${builtInGenerationJobs.request}->'completionLease'->>'token'`,
              lease,
            ),
          ),
        );
    };
    const reconciliationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(COMPLETION_LEASE_MS - 60_000),
    ]);
    await onRejection(
      (async () => {
        await set(
          reconcileClaimedIntroVideoAgentJob$,
          generationId,
          reconciliationSignal,
        );
        await release();
      })(),
      release,
    );
    signal.throwIfAborted();
  },
);
