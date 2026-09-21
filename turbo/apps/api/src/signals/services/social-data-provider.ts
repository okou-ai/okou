import type { SocialDataResult } from "@okouai/api-contracts/contracts/social-data";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { env } from "../../lib/env";
import {
  readBoundedResponseText,
  safeJsonParse,
  settle,
  settleIncludingAbort,
} from "../utils";
import {
  prepareSocialDataProviderPlan,
  SocialDataProviderError,
  type SocialDataProviderPlan,
} from "./social-data-provider-catalog";
import { projectSocialDataProviderOutput } from "./social-data-provider-output";

const API_BASE = "https://api.monid.ai/v1";
const RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;

const amountSchema = z.object({
  value: z.number().finite().nonnegative(),
  currency: z.literal("USD"),
});

const priceSchema = z
  .object({
    type: z.enum(["PER_CALL", "PER_RESULT"]),
    amount: amountSchema.strict(),
    flatFee: amountSchema.strict().optional(),
    notes: z.array(z.string()).optional(),
  })
  .strict();

const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const runSchema = z.object({
  runId: runIdSchema,
  provider: z.string(),
  endpoint: z.string(),
  status: z.enum([
    "READY",
    "RUNNING",
    "STOPPING",
    "COMPLETED",
    "FAILED",
    "BLOCKED",
    "STOPPED",
    "TIMED_OUT",
  ]),
  stoppable: z.boolean().optional(),
  output: z.unknown().optional(),
  providerResponse: z
    .object({ httpStatus: z.number().int(), error: z.unknown().optional() })
    .optional(),
  cost: z.unknown().optional(),
  billing: z.object({ actualCost: z.unknown().optional() }).optional(),
  billedUnits: z.number().finite().nonnegative().optional(),
});

const parameterSchema = z.object({
  type: z.string().optional(),
  enum: z.array(z.unknown()).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});

const inspectionSchema = z.object({
  provider: z.literal("apify"),
  endpoint: z.string(),
  input: z.object({
    body: z.object({
      type: z.literal("object"),
      properties: z.record(z.string(), parameterSchema),
      required: z.array(z.string()).optional(),
    }),
  }),
  price: priceSchema,
});

export interface SocialDataProviderQuote {
  readonly estimatedCostUsdMicros: number;
  readonly quantity: number;
  readonly unit: "request" | "result";
}

export interface SocialDataProviderRun {
  readonly upstreamRunId?: string;
  readonly state:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "unknown";
  readonly data?: SocialDataResult;
  readonly actualCostUsdMicros?: number;
  readonly billedUnits?: number;
  readonly stoppable?: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

function invalidResponse(): never {
  throw new SocialDataProviderError(
    "SOCIAL_DATA_INVALID_RESPONSE",
    "The Social data service returned an invalid response.",
  );
}

function accessKey(): string {
  const key = env("OKOU_SOCIAL_MONID_API_KEY");
  if (!key) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_UNAVAILABLE",
      "Social data jobs are temporarily unavailable.",
      503,
    );
  }
  return key;
}

function usdToMicros(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_INVALID_BILLING",
      "The Social data service returned an invalid settlement amount.",
    );
  }
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(value.toString());
  const whole = match?.[1];
  if (!whole) {
    return invalidResponse();
  }
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0);
  const digits = BigInt(`${whole}${fraction}`);
  const scale = 6 + exponent - fraction.length;
  const divisor = scale < 0 ? 10n ** BigInt(-scale) : 1n;
  const micros =
    scale < 0
      ? (digits + divisor - 1n) / divisor
      : digits * 10n ** BigInt(scale);
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_INVALID_BILLING",
      "The Social data service returned an invalid settlement amount.",
    );
  }
  return Number(micros);
}

function settledCost(value: z.infer<typeof runSchema>): number | undefined {
  let runCost: number | undefined;
  let billingCost: number | undefined;
  if (value.cost !== undefined && value.cost !== null) {
    const cost = amountSchema
      .extend({ unit: z.enum(["MICRO_DOLLAR", "USD"]).optional() })
      .safeParse(value.cost);
    if (!cost.success) {
      throw new SocialDataProviderError(
        "SOCIAL_DATA_INVALID_BILLING",
        "The Social data service returned an invalid settlement amount.",
      );
    }
    if (cost.data.unit === "MICRO_DOLLAR") {
      if (!Number.isSafeInteger(cost.data.value)) {
        return invalidResponse();
      }
      runCost = cost.data.value;
    } else {
      runCost = usdToMicros(cost.data.value);
    }
  }
  if (
    value.billing?.actualCost !== undefined &&
    value.billing.actualCost !== null
  ) {
    const cost = amountSchema
      .extend({
        unit: z.literal("MICRO_DOLLAR"),
        value: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .safeParse(value.billing.actualCost);
    if (!cost.success) {
      throw new SocialDataProviderError(
        "SOCIAL_DATA_INVALID_BILLING",
        "The Social data service returned an invalid settlement amount.",
      );
    }
    billingCost = cost.data.value;
  }
  if (
    runCost !== undefined &&
    billingCost !== undefined &&
    runCost !== billingCost
  ) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_INVALID_BILLING",
      "The Social data service returned inconsistent settlement amounts.",
    );
  }
  return runCost ?? billingCost;
}

async function request(
  path: string,
  method: "GET" | "POST",
  body: unknown,
  signal: AbortSignal,
): Promise<{ readonly httpStatus: number; readonly body: unknown }> {
  const fetched = await settle(
    fetch(`${API_BASE}${path}`, {
      method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${accessKey()}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    }),
    signal,
  );
  if (!fetched.ok) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_UNAVAILABLE",
      "The Social data service is temporarily unavailable.",
      503,
    );
  }
  const response = fetched.value;
  const read = await settle(
    readBoundedResponseText(response, RESPONSE_LIMIT_BYTES),
    signal,
  );
  if (!read.ok) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_UNAVAILABLE",
      "The Social data response could not be read.",
      503,
    );
  }
  const text = read.value;
  signal.throwIfAborted();
  if (text.kind !== "text") {
    return invalidResponse();
  }
  const parsed = safeJsonParse(text.text);
  if (parsed === undefined) {
    return invalidResponse();
  }
  return { httpStatus: response.status, body: parsed };
}

function checkedPlan(plan: SocialDataProviderPlan): SocialDataProviderPlan {
  const checked = prepareSocialDataProviderPlan(plan.request);
  if (!isDeepStrictEqual(checked, plan)) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_INVALID_PLAN",
      "The saved Social data request requires a new quote.",
      422,
    );
  }
  return checked;
}

function inspectionMatchesInput(
  body: SocialDataProviderPlan["input"]["body"],
  schema: z.infer<typeof inspectionSchema>["input"]["body"],
): boolean {
  if (
    schema.required?.some((name) => {
      return body[name] === undefined;
    })
  ) {
    return false;
  }
  return Object.entries(body).every(([name, value]) => {
    const parameter = schema.properties[name];
    if (!parameter) {
      return false;
    }
    if (parameter.enum && !parameter.enum.includes(value)) {
      return false;
    }
    switch (parameter.type) {
      case "string": {
        return typeof value === "string";
      }
      case "boolean": {
        return typeof value === "boolean";
      }
      case "array": {
        return Array.isArray(value);
      }
      case "integer":
      case "number": {
        return (
          typeof value === "number" &&
          Number.isFinite(value) &&
          (parameter.type !== "integer" || Number.isInteger(value)) &&
          (parameter.minimum === undefined || value >= parameter.minimum) &&
          (parameter.maximum === undefined || value <= parameter.maximum)
        );
      }
      default: {
        return false;
      }
    }
  });
}

export async function inspectSocialDataProviderPlan(
  plan: SocialDataProviderPlan,
  signal: AbortSignal,
): Promise<SocialDataProviderQuote> {
  const checked = checkedPlan(plan);
  const response = await request(
    "/inspect",
    "POST",
    { provider: checked.provider, endpoint: checked.endpoint },
    signal,
  );
  if (response.httpStatus !== 200) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_QUOTE_UNAVAILABLE",
      "The Social data quote is temporarily unavailable.",
      503,
    );
  }
  const parsed = inspectionSchema.safeParse(response.body);
  if (
    !parsed.success ||
    parsed.data.endpoint !== checked.endpoint ||
    !inspectionMatchesInput(checked.input.body, parsed.data.input.body)
  ) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_UNBOUNDED_PRICE",
      "This Social data operation cannot currently provide a bounded quote.",
      422,
    );
  }
  const quantity =
    parsed.data.price.type === "PER_CALL" ? 1 : checked.maxBillableUnits;
  const estimatedCostUsdMicros = usdToMicros(
    parsed.data.price.amount.value * quantity +
      (parsed.data.price.flatFee?.value ?? 0),
  );
  return {
    estimatedCostUsdMicros,
    quantity,
    unit: parsed.data.price.type === "PER_CALL" ? "request" : "result",
  };
}

async function normalizeRun(
  plan: SocialDataProviderPlan,
  value: unknown,
  expectedRunId?: string,
): Promise<SocialDataProviderRun> {
  const parsed = runSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.provider !== plan.provider ||
    parsed.data.endpoint !== plan.endpoint ||
    (expectedRunId !== undefined && expectedRunId !== parsed.data.runId)
  ) {
    return invalidResponse();
  }
  const run = parsed.data;
  const base = {
    upstreamRunId: run.runId,
    stoppable: run.stoppable,
    billedUnits: run.billedUnits,
  };
  switch (run.status) {
    case "READY": {
      return { ...base, state: "pending" };
    }
    case "RUNNING":
    case "STOPPING": {
      return { ...base, state: "running" };
    }
    case "STOPPED": {
      return {
        ...base,
        state: "cancelled",
        actualCostUsdMicros: settledCost(run),
      };
    }
    case "FAILED":
    case "BLOCKED":
    case "TIMED_OUT": {
      return {
        ...base,
        state: "failed",
        actualCostUsdMicros: settledCost(run),
        errorCode: "SOCIAL_DATA_EXECUTION_FAILED",
        errorMessage: "The Social data operation could not be completed.",
      };
    }
    case "COMPLETED": {
      const actualCostUsdMicros = settledCost(run);
      if (!run.providerResponse) {
        return invalidResponse();
      }
      if (
        run.providerResponse.httpStatus < 200 ||
        run.providerResponse.httpStatus >= 300 ||
        (run.providerResponse.error !== undefined &&
          run.providerResponse.error !== null)
      ) {
        return {
          ...base,
          state: "failed",
          actualCostUsdMicros,
          errorCode: "SOCIAL_DATA_SOURCE_ERROR",
          errorMessage:
            "The source platform could not complete this operation.",
        };
      }
      const output = await settleIncludingAbort(() => {
        return projectSocialDataProviderOutput(plan, run.output);
      });
      if (!output.ok) {
        return {
          ...base,
          state: "failed",
          actualCostUsdMicros,
          errorCode: "SOCIAL_DATA_INVALID_RESULT",
          errorMessage:
            "The Social data service could not deliver a valid result.",
        };
      }
      return {
        ...base,
        state: "completed",
        actualCostUsdMicros,
        data: output.value,
      };
    }
  }
}

export async function startSocialDataProviderRun(
  plan: SocialDataProviderPlan,
  signal: AbortSignal,
): Promise<SocialDataProviderRun> {
  const checked = checkedPlan(plan);
  accessKey();
  signal.throwIfAborted();
  const result = await settleIncludingAbort(
    request(
      "/run",
      "POST",
      {
        provider: checked.provider,
        endpoint: checked.endpoint,
        input: checked.input,
      },
      signal,
    ),
  );
  if (!result.ok) {
    return {
      state: "unknown",
      errorCode: "SOCIAL_DATA_START_UNKNOWN",
      errorMessage:
        "Execution could not be confirmed. Do not start this request again.",
    };
  }
  const normalized = await settleIncludingAbort(
    normalizeRun(checked, result.value.body),
  );
  if (!normalized.ok) {
    const run = runSchema.safeParse(result.value.body);
    return {
      state: "unknown",
      ...(run.success &&
      run.data.provider === checked.provider &&
      run.data.endpoint === checked.endpoint
        ? { upstreamRunId: run.data.runId }
        : {}),
      errorCode: "SOCIAL_DATA_START_UNKNOWN",
      errorMessage:
        "Execution could not be confirmed. Read this job again before starting another request.",
    };
  }
  if (
    (normalized.value.state === "completed" &&
      (result.value.httpStatus < 200 || result.value.httpStatus >= 300)) ||
    (result.value.httpStatus !== 202 &&
      normalized.value.state !== "completed" &&
      normalized.value.state !== "failed" &&
      normalized.value.state !== "cancelled")
  ) {
    return {
      ...normalized.value,
      state: "unknown",
      errorCode: "SOCIAL_DATA_START_UNKNOWN",
      errorMessage:
        "Execution could not be confirmed. Read this job again before starting another request.",
    };
  }
  return normalized.value;
}

export async function readSocialDataProviderRun(
  plan: SocialDataProviderPlan,
  upstreamRunId: string,
  signal: AbortSignal,
): Promise<SocialDataProviderRun> {
  const checked = checkedPlan(plan);
  if (!runIdSchema.safeParse(upstreamRunId).success) {
    return invalidResponse();
  }
  const response = await request(
    `/runs/${encodeURIComponent(upstreamRunId)}`,
    "GET",
    undefined,
    signal,
  );
  if (response.httpStatus !== 200) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_STATUS_UNAVAILABLE",
      "The Social data job status is temporarily unavailable.",
      503,
    );
  }
  return normalizeRun(checked, response.body, upstreamRunId);
}

export async function stopSocialDataProviderRun(
  upstreamRunId: string,
  signal: AbortSignal,
): Promise<{ readonly acknowledged: boolean }> {
  if (!runIdSchema.safeParse(upstreamRunId).success) {
    return invalidResponse();
  }
  const response = await request(
    `/runs/${encodeURIComponent(upstreamRunId)}/stop`,
    "POST",
    undefined,
    signal,
  );
  if (response.httpStatus === 409) {
    return { acknowledged: false };
  }
  const parsed = z
    .object({ runId: runIdSchema, status: z.literal("STOPPING") })
    .safeParse(response.body);
  if (
    response.httpStatus !== 202 ||
    !parsed.success ||
    parsed.data.runId !== upstreamRunId
  ) {
    throw new SocialDataProviderError(
      "SOCIAL_DATA_CANCEL_UNKNOWN",
      "Cancellation could not be confirmed. Read the saved job to check its status.",
    );
  }
  return { acknowledged: true };
}
