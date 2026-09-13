import { command } from "ccstate";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import {
  builtInGenerationJobs,
  type BuiltInGenerationError,
  type BuiltInGenerationStatus,
  type BuiltInGenerationType,
} from "@okouai/db/schema/built-in-generation-job";
import type { BuiltInGenerationResponse } from "@okouai/api-contracts/contracts/built-in-generation";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishBuiltInGenerationChanged } from "../external/realtime";
import {
  privateArtifactCreationEnabled,
  artifactFileReference,
} from "./private-artifact-storage.service";

const ACTIVE_BUILT_IN_GENERATION_STATUSES = ["queued", "running"] as const;

const BUILT_IN_GENERATION_TIMEOUT_MS_BY_TYPE = {
  image: 15 * 60 * 1000,
  video: 30 * 60 * 1000,
  presentation: 60 * 60 * 1000,
  website: 60 * 60 * 1000,
} as const satisfies Record<BuiltInGenerationType, number>;

const BUILT_IN_GENERATION_TIMEOUT_ERROR: BuiltInGenerationError = Object.freeze(
  {
    message: "Generation timed out. Please try again.",
    code: "GENERATION_TIMEOUT",
  },
);

interface CreateBuiltInGenerationJobArgs {
  readonly generationId: string;
  readonly type: BuiltInGenerationType;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly request: Record<string, unknown>;
}

interface BuiltInGenerationRequestInternal {
  readonly privateArtifacts?: boolean;
  readonly admissionId?: string;
  readonly publicBrand?: PublicBrand;
  readonly provider?:
    | "openai"
    | "fal"
    | "byteplus"
    | "minimax"
    | "joggai"
    | "heygen";
  readonly providerJobId?: string;
  readonly providerSessionId?: string;
  readonly providerStatus?: string;
  readonly providerNotice?: string;
  readonly providerStatusUrl?: string;
  readonly providerResponseUrl?: string;
  readonly providerTask?: string;
  readonly presentation?: unknown;
}

export interface BuiltInGenerationWebhookJob {
  readonly id: string;
  readonly type: BuiltInGenerationType;
  readonly status: BuiltInGenerationStatus;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | null;
  readonly request: Record<string, unknown>;
}

interface BuiltInGenerationJobRow {
  readonly id: string;
  readonly type: BuiltInGenerationType;
  readonly status: BuiltInGenerationStatus;
  readonly userId: string;
  readonly result: unknown;
  readonly request: unknown;
  readonly error: BuiltInGenerationError | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

const BUILT_IN_GENERATION_INTERNAL_REQUEST_KEY = "__builtInGeneration";

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      return entry !== undefined;
    }),
  );
}

export function builtInGenerationRequestWithInternal(
  request: Record<string, unknown>,
  internal: BuiltInGenerationRequestInternal,
): Record<string, unknown> {
  return {
    ...request,
    [BUILT_IN_GENERATION_INTERNAL_REQUEST_KEY]: compactObject({
      admissionId: internal.admissionId,
      privateArtifacts: internal.privateArtifacts,
      publicBrand: internal.publicBrand,
      provider: internal.provider,
      providerJobId: internal.providerJobId,
      providerSessionId: internal.providerSessionId,
      providerStatus: internal.providerStatus,
      providerNotice: internal.providerNotice,
      providerStatusUrl: internal.providerStatusUrl,
      providerResponseUrl: internal.providerResponseUrl,
      providerTask: internal.providerTask,
      presentation: internal.presentation,
    }),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parsePrivateArtifactsPolicy(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error("Invalid built-in generation artifact storage policy");
  }
  return value;
}

export function readBuiltInGenerationRequestInternal(
  request: unknown,
): BuiltInGenerationRequestInternal {
  if (!isRecord(request)) {
    return {};
  }
  const value = request[BUILT_IN_GENERATION_INTERNAL_REQUEST_KEY];
  if (!isRecord(value)) {
    return {};
  }
  const publicBrand = value.publicBrand;
  if (
    Object.hasOwn(value, "publicBrand") &&
    publicBrand !== "vm0" &&
    publicBrand !== "okou"
  ) {
    throw new Error(
      `Invalid built-in generation public brand: ${String(publicBrand)}`,
    );
  }
  return {
    privateArtifacts: parsePrivateArtifactsPolicy(value.privateArtifacts),
    admissionId:
      typeof value.admissionId === "string" ? value.admissionId : undefined,
    publicBrand:
      publicBrand === "vm0" || publicBrand === "okou" ? publicBrand : undefined,
    provider:
      value.provider === "openai" ||
      value.provider === "fal" ||
      value.provider === "byteplus" ||
      value.provider === "minimax" ||
      value.provider === "joggai" ||
      value.provider === "heygen"
        ? value.provider
        : undefined,
    providerJobId:
      typeof value.providerJobId === "string" ? value.providerJobId : undefined,
    providerSessionId: optionalString(value.providerSessionId),
    providerStatus: optionalString(value.providerStatus),
    providerNotice: optionalString(value.providerNotice),
    providerStatusUrl:
      typeof value.providerStatusUrl === "string"
        ? value.providerStatusUrl
        : undefined,
    providerResponseUrl:
      typeof value.providerResponseUrl === "string"
        ? value.providerResponseUrl
        : undefined,
    providerTask:
      typeof value.providerTask === "string" ? value.providerTask : undefined,
    presentation: value.presentation,
  };
}

export function builtInGenerationPublicBrand(request: unknown): PublicBrand {
  // Historical pre-brand requests retain their VM0 artifact identity. This
  // is permanent read compatibility per #28449; current writers set publicBrand.
  // Invalid present values throw above.
  return readBuiltInGenerationRequestInternal(request).publicBrand ?? "vm0";
}

export function builtInGenerationIsPrivate(request: unknown): boolean {
  // Unmarked historical jobs retain their original public storage policy.
  return (
    readBuiltInGenerationRequestInternal(request).privateArtifacts === true
  );
}

const PRIVATE_RESULT_FIELDS = [
  "id",
  "filename",
  "contentType",
  "size",
  "url",
  "creditsCharged",
  "model",
  "provider",
  "imageSize",
  "quality",
  "background",
  "outputFormat",
  "outputCompression",
  "moderation",
  "safetyTolerance",
  "revisedPrompt",
  "billingCategory",
  "billingQuantity",
  "seed",
  "sourceImageUrls",
  "maskImageUrl",
  "inputFidelity",
  "imagePromptStrength",
  "durationSeconds",
  "aspectRatio",
  "duration",
  "resolution",
  "generateAudio",
  "requestId",
  "providerVideoId",
  "avatarId",
  "voiceId",
  "inputType",
  "screenStyle",
  "caption",
  "generationId",
  "status",
  "sessionId",
  "videoId",
  "styleId",
  "orientation",
  "providerStatus",
] as const;

function privateGenerationResult(result: unknown): Record<string, unknown> {
  if (
    !isRecord(result) ||
    typeof result.url !== "string" ||
    !artifactFileReference(result.url)?.id
  ) {
    throw new Error(
      "Private generation result must reference an authenticated artifact",
    );
  }
  return Object.fromEntries(
    PRIVATE_RESULT_FIELDS.flatMap((key) => {
      return Object.hasOwn(result, key) ? [[key, result[key]]] : [];
    }),
  );
}

function serializeBuiltInGenerationJob(
  job: BuiltInGenerationJobRow,
): BuiltInGenerationResponse {
  return {
    generationId: job.id,
    type: job.type,
    status: job.status,
    ...(isRecord(job.result)
      ? {
          result: builtInGenerationIsPrivate(job.request)
            ? privateGenerationResult(job.result)
            : job.result,
        }
      : {}),
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt.toISOString(),
    startedAt: iso(job.startedAt),
    completedAt: iso(job.completedAt),
  };
}

function isActiveBuiltInGenerationStatus(
  status: BuiltInGenerationStatus,
): status is (typeof ACTIVE_BUILT_IN_GENERATION_STATUSES)[number] {
  return ACTIVE_BUILT_IN_GENERATION_STATUSES.some((activeStatus) => {
    return activeStatus === status;
  });
}

function builtInGenerationTimeoutCutoff(
  type: BuiltInGenerationType,
  referenceTime: Date,
): Date {
  return new Date(
    referenceTime.getTime() - BUILT_IN_GENERATION_TIMEOUT_MS_BY_TYPE[type],
  );
}

function isStuckBuiltInGenerationJob(
  job: BuiltInGenerationJobRow & {
    readonly updatedAt: Date;
    readonly request: unknown;
  },
  referenceTime: Date,
): boolean {
  // Managed HeyGen jobs can remain active beyond the generic video timeout.
  // Only an authoritative provider failure ends these resumable jobs.
  if (
    ["intro-video-agent", "intro-video-render"].includes(
      readBuiltInGenerationRequestInternal(job.request).providerTask ?? "",
    )
  ) {
    return false;
  }
  if (!isActiveBuiltInGenerationStatus(job.status)) {
    return false;
  }
  return (
    job.updatedAt <= builtInGenerationTimeoutCutoff(job.type, referenceTime)
  );
}

async function publishJobSafely(job: BuiltInGenerationJobRow): Promise<void> {
  const payload = serializeBuiltInGenerationJob(job);
  await publishBuiltInGenerationChanged(job.userId, job.id, payload);
}

export const createBuiltInGenerationJob$ = command(
  async (
    { get, set },
    args: CreateBuiltInGenerationJobArgs,
    signal: AbortSignal,
  ) => {
    const privateArtifacts =
      (args.type === "image" || args.type === "video") &&
      (await get(privateArtifactCreationEnabled(args.orgId, args.userId)));
    signal.throwIfAborted();
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .insert(builtInGenerationJobs)
      .values({
        id: args.generationId,
        type: args.type,
        orgId: args.orgId,
        userId: args.userId,
        runId: args.runId ?? null,
        request: builtInGenerationRequestWithInternal(args.request, {
          ...readBuiltInGenerationRequestInternal(args.request),
          privateArtifacts,
        }),
      })
      .returning({ id: builtInGenerationJobs.id });
    signal.throwIfAborted();
    if (!job) {
      throw new Error("Failed to create built-in generation job");
    }
    return { id: job.id, privateArtifacts };
  },
);

export const getBuiltInGenerationJob$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<BuiltInGenerationResponse | null> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .select({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        userId: builtInGenerationJobs.userId,
        result: builtInGenerationJobs.result,
        request: builtInGenerationJobs.request,
        error: builtInGenerationJobs.error,
        createdAt: builtInGenerationJobs.createdAt,
        updatedAt: builtInGenerationJobs.updatedAt,
        startedAt: builtInGenerationJobs.startedAt,
        completedAt: builtInGenerationJobs.completedAt,
      })
      .from(builtInGenerationJobs)
      .where(
        and(
          eq(builtInGenerationJobs.id, args.generationId),
          eq(builtInGenerationJobs.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!job) {
      return null;
    }
    if (builtInGenerationIsPrivate(job.request) && job.userId !== args.userId) {
      return null;
    }

    const currentTime = nowDate();
    if (!isStuckBuiltInGenerationJob(job, currentTime)) {
      return serializeBuiltInGenerationJob(job);
    }

    const cutoff = builtInGenerationTimeoutCutoff(job.type, currentTime);
    const [expiredJob] = await writeDb
      .update(builtInGenerationJobs)
      .set({
        status: "failed",
        error: BUILT_IN_GENERATION_TIMEOUT_ERROR,
        completedAt: currentTime,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, args.generationId),
          eq(builtInGenerationJobs.orgId, args.orgId),
          inArray(builtInGenerationJobs.status, [
            ...ACTIVE_BUILT_IN_GENERATION_STATUSES,
          ]),
          lte(builtInGenerationJobs.updatedAt, cutoff),
        ),
      )
      .returning({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        userId: builtInGenerationJobs.userId,
        result: builtInGenerationJobs.result,
        request: builtInGenerationJobs.request,
        error: builtInGenerationJobs.error,
        createdAt: builtInGenerationJobs.createdAt,
        startedAt: builtInGenerationJobs.startedAt,
        completedAt: builtInGenerationJobs.completedAt,
      });
    signal.throwIfAborted();
    if (expiredJob) {
      await publishJobSafely(expiredJob);
      signal.throwIfAborted();
      return serializeBuiltInGenerationJob(expiredJob);
    }

    const [latestJob] = await writeDb
      .select({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        userId: builtInGenerationJobs.userId,
        result: builtInGenerationJobs.result,
        request: builtInGenerationJobs.request,
        error: builtInGenerationJobs.error,
        createdAt: builtInGenerationJobs.createdAt,
        startedAt: builtInGenerationJobs.startedAt,
        completedAt: builtInGenerationJobs.completedAt,
      })
      .from(builtInGenerationJobs)
      .where(
        and(
          eq(builtInGenerationJobs.id, args.generationId),
          eq(builtInGenerationJobs.orgId, args.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return latestJob ? serializeBuiltInGenerationJob(latestJob) : null;
  },
);

export const markBuiltInGenerationRunning$ = command(
  async ({ set }, generationId: string, signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .update(builtInGenerationJobs)
      .set({
        status: "running",
        startedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, generationId),
          eq(builtInGenerationJobs.status, "queued"),
        ),
      );
    signal.throwIfAborted();
  },
);

export const mergeBuiltInGenerationJobInternal$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly internal: BuiltInGenerationRequestInternal;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const patch = compactObject({ ...args.internal });
    // Merge in SQL so callbacks and submission/status persistence cannot erase
    // each other's session ID, video ID, or admission metadata.
    await writeDb
      .update(builtInGenerationJobs)
      .set({
        request: sql`jsonb_set(${builtInGenerationJobs.request}, '{__builtInGeneration}', coalesce(${builtInGenerationJobs.request}->'__builtInGeneration', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
        updatedAt: nowDate(),
      })
      .where(eq(builtInGenerationJobs.id, args.generationId));
    signal.throwIfAborted();
  },
);

export const getBuiltInGenerationWebhookJob$ = command(
  async (
    { set },
    generationId: string,
    signal: AbortSignal,
  ): Promise<BuiltInGenerationWebhookJob | null> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .select({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        orgId: builtInGenerationJobs.orgId,
        userId: builtInGenerationJobs.userId,
        runId: builtInGenerationJobs.runId,
        request: builtInGenerationJobs.request,
      })
      .from(builtInGenerationJobs)
      .where(
        and(
          eq(builtInGenerationJobs.id, generationId),
          inArray(builtInGenerationJobs.status, [
            ...ACTIVE_BUILT_IN_GENERATION_STATUSES,
          ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!job || !isRecord(job.request)) {
      return null;
    }
    return { ...job, request: job.request };
  },
);

export const getBuiltInGenerationWebhookJobByProviderJobId$ = command(
  async (
    { set },
    args: {
      readonly provider: NonNullable<
        BuiltInGenerationRequestInternal["provider"]
      >;
      readonly providerJobId: string;
    },
    signal: AbortSignal,
  ): Promise<BuiltInGenerationWebhookJob | null> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .select({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        orgId: builtInGenerationJobs.orgId,
        userId: builtInGenerationJobs.userId,
        runId: builtInGenerationJobs.runId,
        request: builtInGenerationJobs.request,
      })
      .from(builtInGenerationJobs)
      .where(
        and(
          inArray(builtInGenerationJobs.status, [
            ...ACTIVE_BUILT_IN_GENERATION_STATUSES,
          ]),
          eq(
            sql`${builtInGenerationJobs.request}->${BUILT_IN_GENERATION_INTERNAL_REQUEST_KEY}->>'provider'`,
            args.provider,
          ),
          eq(
            sql`${builtInGenerationJobs.request}->${BUILT_IN_GENERATION_INTERNAL_REQUEST_KEY}->>'providerJobId'`,
            args.providerJobId,
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!job || !isRecord(job.request)) {
      return null;
    }
    return { ...job, request: job.request };
  },
);

export const completeBuiltInGenerationJob$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly result: object;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    const [policy] = await writeDb
      .select({ request: builtInGenerationJobs.request })
      .from(builtInGenerationJobs)
      .where(eq(builtInGenerationJobs.id, args.generationId))
      .limit(1);
    signal.throwIfAborted();
    if (!policy) {
      return;
    }
    // Apply the same external contract before persistence and realtime/polling
    // serialization; provider fields must not become durable result identities.
    const result = builtInGenerationIsPrivate(policy.request)
      ? privateGenerationResult(args.result)
      : args.result;
    const [job] = await writeDb
      .update(builtInGenerationJobs)
      .set({
        status: "completed",
        result,
        error: null,
        completedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, args.generationId),
          inArray(builtInGenerationJobs.status, [
            ...ACTIVE_BUILT_IN_GENERATION_STATUSES,
          ]),
        ),
      )
      .returning({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        userId: builtInGenerationJobs.userId,
        result: builtInGenerationJobs.result,
        request: builtInGenerationJobs.request,
        error: builtInGenerationJobs.error,
        createdAt: builtInGenerationJobs.createdAt,
        startedAt: builtInGenerationJobs.startedAt,
        completedAt: builtInGenerationJobs.completedAt,
      });
    signal.throwIfAborted();
    if (job) {
      await publishJobSafely(job);
    }
  },
);

export const failBuiltInGenerationJob$ = command(
  async (
    { set },
    args: {
      readonly generationId: string;
      readonly error: BuiltInGenerationError;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const writeDb = set(writeDb$);
    const [job] = await writeDb
      .update(builtInGenerationJobs)
      .set({
        status: "failed",
        error: args.error,
        completedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(builtInGenerationJobs.id, args.generationId),
          inArray(builtInGenerationJobs.status, [
            ...ACTIVE_BUILT_IN_GENERATION_STATUSES,
          ]),
        ),
      )
      .returning({
        id: builtInGenerationJobs.id,
        type: builtInGenerationJobs.type,
        status: builtInGenerationJobs.status,
        userId: builtInGenerationJobs.userId,
        result: builtInGenerationJobs.result,
        request: builtInGenerationJobs.request,
        error: builtInGenerationJobs.error,
        createdAt: builtInGenerationJobs.createdAt,
        startedAt: builtInGenerationJobs.startedAt,
        completedAt: builtInGenerationJobs.completedAt,
      });
    signal.throwIfAborted();
    if (!job) {
      return false;
    }
    await publishJobSafely(job);
    signal.throwIfAborted();
    return true;
  },
);
