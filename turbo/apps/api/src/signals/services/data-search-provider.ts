import type { DataSearchRequest } from "@okouai/api-contracts/contracts/data-search";
import * as z from "zod";

import { env } from "../../lib/env";
import {
  readBoundedResponseText,
  safeJsonParse,
  settle,
  settleIncludingAbort,
} from "../utils";
import {
  checkedDataSearchProviderPlan,
  prepareDataSearchProviderPlan,
  reviewedDataSearchCapability,
  type DataSearchJsonValue,
  type DataSearchProviderPlan,
} from "./data-search-catalog";
import { DataSearchProviderError } from "./data-search-provider-error";
import { projectDataSearchProviderOutput } from "./data-search-provider-output";
import { matchesDataSearchSourceSchema } from "./data-search-provider-schema";

export interface DataSearchProviderQuote {
  readonly plan: DataSearchProviderPlan;
  readonly estimatedCostUsdMicros: number;
  readonly quantity: number;
  readonly unit: "request" | "result" | "metric" | "channel";
}
export type DataSearchProviderRun = {
  readonly upstreamRunId?: string;
  readonly state:
    "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  readonly data?: { items: DataSearchJsonValue[] };
  readonly actualCostUsdMicros?: number;
  readonly requiresActionUrl?: string;
  readonly stoppable?: boolean;
} & (
  | { readonly errorCode: string; readonly errorMessage: string }
  | { readonly errorCode?: never; readonly errorMessage?: never }
);
const MONID = "https://api.monid.ai/v1";
const FIRECRAWL = "https://api.firecrawl.dev/v2";
const amountSchema = z.object({
  value: z.number().finite().nonnegative(),
  currency: z.literal("USD"),
  unit: z.enum(["USD", "MICRO_DOLLAR"]).optional(),
});
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
});
function invalidResponse(): never {
  throw new DataSearchProviderError(
    "DATA_SEARCH_INVALID_RESPONSE",
    "The data source returned an invalid response.",
  );
}
function unavailable(): never {
  throw new DataSearchProviderError(
    "DATA_SEARCH_UNAVAILABLE",
    "This data source is temporarily unavailable.",
    503,
  );
}
function key(vendor: DataSearchProviderPlan["vendor"]): string {
  const value = env(
    vendor === "monid"
      ? "OKOU_SOCIAL_MONID_API_KEY"
      : "OKOU_SCRAPE_FIRECRAWL_TOKEN",
  );
  return value || unavailable();
}
function firecrawlRate(plan: DataSearchProviderPlan): number {
  const value = plan.sourceCostUsdMicrosPerCredit;
  if (!value) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_PRICING_UNAVAILABLE",
      "This data source has no configured source-cost conversion rate.",
      503,
    );
  }
  return value;
}
function safeCost(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_BILLING",
      "The data source returned an invalid settlement amount.",
    );
  }
  return value;
}
/** Round once upward in decimal arithmetic, including exponent notation; never truncate source costs. */
function usdToMicros(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return invalidResponse();
  }
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(value));
  if (!match?.[1]) {
    return invalidResponse();
  }
  const fraction = match[2] ?? "";
  const digits = BigInt(`${match[1]}${fraction}`);
  const scale = 6 + Number(match[3] ?? 0) - fraction.length;
  const divisor = scale < 0 ? 10n ** BigInt(-scale) : 1n;
  const micros =
    scale < 0
      ? (digits + divisor - 1n) / divisor
      : digits * 10n ** BigInt(scale);
  return safeCost(Number(micros));
}
function amount(value: unknown, microOnly = false): number {
  const parsed = amountSchema.safeParse(value);
  if (!parsed.success || (microOnly && parsed.data.unit !== "MICRO_DOLLAR")) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_BILLING",
      "The data source returned an invalid settlement amount.",
    );
  }
  return parsed.data.unit === "MICRO_DOLLAR"
    ? safeCost(parsed.data.value)
    : usdToMicros(parsed.data.value);
}
type MonidReceiptSource =
  | { readonly kind: "submission" }
  | { readonly kind: "saved-run"; readonly runId: string };

function settledCost(
  run: z.infer<typeof runSchema>,
  source: MonidReceiptSource,
): number | undefined {
  // Current Monid contracts use different fields by endpoint:
  // POST /run -> billing.actualCost (MICRO_DOLLAR); GET /runs/:id -> cost.
  const cost =
    source.kind === "submission" ? run.billing?.actualCost : run.cost;
  if (cost === undefined || cost === null) {
    return undefined;
  }
  return amount(cost, source.kind === "submission");
}

async function request(
  url: string,
  method: "GET" | "POST",
  body: unknown,
  signal: AbortSignal,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const fetched = await settle(
    fetch(url, {
      method,
      redirect: "error",
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    }),
    signal,
  );
  if (!fetched.ok) {
    return unavailable();
  }
  const response = fetched.value;
  const read = await settle(
    readBoundedResponseText(response, 8 * 1024 * 1024),
    signal,
  );
  if (!read.ok) {
    return unavailable();
  }
  signal.throwIfAborted();
  if (read.value.kind !== "text") {
    return invalidResponse();
  }
  const parsed = safeJsonParse(read.value.text);
  if (parsed === undefined) {
    return invalidResponse();
  }
  return { status: response.status, body: parsed };
}
function monidRequest(
  path: string,
  method: "GET" | "POST",
  body: unknown,
  signal: AbortSignal,
) {
  return request(`${MONID}${path}`, method, body, signal, {
    Authorization: `Bearer ${key("monid")}`,
  });
}

function isReviewedMonidTier(tier: {
  when: Record<string, unknown>;
  price: { amount: z.infer<typeof amountSchema> };
}): boolean {
  const conditions = Object.entries(tier.when);
  if (conditions.length !== 1) {
    return false;
  }
  const condition = conditions[0];
  if (!condition || condition[1] !== "true") {
    return false;
  }
  return (
    (condition[0] === "reveal_personal_emails" &&
      amount(tier.price.amount) === 26_000) ||
    (condition[0] === "reveal_phone_number" &&
      amount(tier.price.amount) === 208_000)
  );
}

function hasReviewedMonidTiers(price: {
  type: string;
  tiers?: Parameters<typeof isReviewedMonidTier>[0][];
}): boolean {
  return (
    price.type !== "TIERED" ||
    (price.tiers !== undefined && price.tiers.every(isReviewedMonidTier))
  );
}

async function inspectMonid(
  plan: DataSearchProviderPlan,
  signal: AbortSignal,
): Promise<DataSearchProviderQuote> {
  const reviewed = reviewedDataSearchCapability(
    plan.capability,
    plan.request.input,
  );
  if (!("usdMicros" in reviewed.price)) {
    return invalidResponse();
  }
  const response = await monidRequest(
    "/inspect",
    "POST",
    { provider: plan.provider, endpoint: plan.endpoint },
    signal,
  );
  if (response.status !== 200) {
    return unavailable();
  }
  const inspected = z
    .object({
      provider: z.string(),
      endpoint: z.string(),
      input: z.record(z.string(), z.unknown()),
      price: z.object({
        type: z.string(),
        amount: amountSchema,
        default: z
          .object({ type: z.literal("PER_CALL"), amount: amountSchema })
          .optional(),
        flatFee: amountSchema.optional(),
        tiers: z
          .array(
            z.object({
              when: z.record(z.string(), z.unknown()),
              price: z.object({
                type: z.literal("PER_CALL"),
                amount: amountSchema,
              }),
            }),
          )
          .optional(),
      }),
    })
    .safeParse(response.body);
  if (
    !inspected.success ||
    inspected.data.provider !== plan.provider ||
    inspected.data.endpoint !== plan.endpoint
  ) {
    return invalidResponse();
  }
  const inspection = inspected.data;
  const price =
    inspection.price.type === "TIERED" &&
    plan.provider === "apollo" &&
    plan.endpoint === "/people/match"
      ? inspection.price.default
      : inspection.price;
  const expectedType = reviewed.price.blockSize ? "PER_RESULT" : "PER_CALL";
  const reviewedTiers = hasReviewedMonidTiers(inspection.price);
  if (
    !reviewedTiers ||
    !price ||
    price.type !== expectedType ||
    amount(price.amount) !== reviewed.price.usdMicros ||
    (inspection.price.flatFee && amount(inspection.price.flatFee) !== 0) ||
    !Object.entries(plan.input).every(([part, value]) => {
      return matchesDataSearchSourceSchema(value, inspection.input[part]);
    }) ||
    Object.entries(inspection.input).some(([part, sourceSchema]) => {
      const required = z
        .object({ required: z.array(z.string()).optional() })
        .safeParse(sourceSchema);
      return (
        required.success &&
        Boolean(required.data.required?.length) &&
        plan.input[part] === undefined
      );
    })
  ) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_CONTRACT_CHANGED",
      "This source's schema or pricing needs review before execution.",
      422,
    );
  }
  const quantity = reviewed.price.blockSize
    ? Math.ceil(plan.limit / reviewed.price.blockSize)
    : 1;
  return {
    plan,
    estimatedCostUsdMicros: safeCost(reviewed.price.usdMicros * quantity),
    quantity,
    unit: reviewed.price.blockSize ? "result" : "request",
  };
}

function reviewedFirecrawlCreditCeiling(
  raw: unknown,
  expectedUnitCredits: number,
): number {
  const credits = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const billing = z.object({ maxCredits: credits });
  const price = z
    .union([
      z.object({
        credits_per_call: credits,
        credits_per_unit: z.never().optional(),
        billing: billing.optional(),
      }),
      z.object({
        credits_per_unit: credits,
        credits_per_call: z.never().optional(),
        billing,
      }),
    ])
    .safeParse(raw);
  if (price.success) {
    const terms = price.data;
    if (terms.credits_per_call !== undefined) {
      if (
        terms.credits_per_call === expectedUnitCredits &&
        (terms.billing === undefined ||
          terms.billing.maxCredits === terms.credits_per_call)
      ) {
        return terms.credits_per_call;
      }
    } else if (terms.credits_per_unit === expectedUnitCredits) {
      return terms.billing.maxCredits;
    }
  }
  throw new DataSearchProviderError(
    "DATA_SEARCH_CONTRACT_CHANGED",
    "This source's pricing needs review before execution.",
    422,
  );
}

async function inspectFirecrawl(
  plan: DataSearchProviderPlan,
  signal: AbortSignal,
): Promise<DataSearchProviderQuote> {
  key("firecrawl");
  const rate = firecrawlRate(plan);
  const reviewed = reviewedDataSearchCapability(
    plan.capability,
    plan.request.input,
  );
  if (!("credits" in reviewed.price)) {
    return invalidResponse();
  }
  // Public, free provider contract GET. Never execute discovery as a paid data scrape.
  const response = await request(
    `https://www.firecrawl.dev/alexandria/agents/providers/${plan.provider}/openapi.json`,
    "GET",
    undefined,
    signal,
  );
  const contract = z
    .object({
      "x-firecrawl-capabilities": z.array(
        z.object({ key: z.string() }).passthrough(),
      ),
      paths: z.record(z.string(), z.unknown()),
    })
    .safeParse(response.body);
  if (response.status !== 200 || !contract.success) {
    return unavailable();
  }
  const capability = contract.data["x-firecrawl-capabilities"].find((entry) => {
    return entry.key === plan.endpoint;
  });
  const expectedUnitCredits =
    plan.provider === "oriane" ? 30 : reviewed.price.credits;
  const maximumCredits = reviewedFirecrawlCreditCeiling(
    capability,
    expectedUnitCredits,
  );
  const path = z
    .object({
      post: z.object({
        requestBody: z.object({
          content: z.object({
            "application/json": z.object({
              schema: z.object({
                properties: z.object({
                  alexandria: z.object({
                    oneOf: z.array(
                      z.object({
                        properties: z.object({
                          capability: z.object({ const: z.string() }),
                          options: z.unknown(),
                        }),
                      }),
                    ),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    })
    .safeParse(contract.data.paths["/v2/scrape"]);
  const sourceOptions = path.success
    ? path.data.post.requestBody.content[
        "application/json"
      ].schema.properties.alexandria.oneOf.find((entry) => {
        return entry.properties.capability.const === plan.endpoint;
      })?.properties.options
    : undefined;
  if (!matchesDataSearchSourceSchema(plan.input, sourceOptions)) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_CONTRACT_CHANGED",
      "This source's input schema needs review before execution.",
      422,
    );
  }
  const quantity =
    reviewed.price.unit === "metric" && typeof plan.input.metrics === "string"
      ? plan.input.metrics.split(",").length
      : 1;
  // Oriane basic costs 20; reserve the published 40-credit ceiling until settlement.
  const credits =
    plan.provider === "oriane"
      ? maximumCredits
      : reviewed.price.credits * quantity;
  if (credits > maximumCredits) {
    return invalidResponse();
  }
  return {
    plan,
    estimatedCostUsdMicros: safeCost(credits * rate),
    quantity,
    unit: reviewed.price.unit,
  };
}

export function quoteDataSearchProvider(
  input: DataSearchRequest,
  signal: AbortSignal,
): Promise<DataSearchProviderQuote> {
  const plan = prepareDataSearchProviderPlan(input);
  return plan.vendor === "monid"
    ? inspectMonid(plan, signal)
    : inspectFirecrawl(plan, signal);
}

async function normalizeMonid(
  plan: DataSearchProviderPlan,
  raw: unknown,
  source: MonidReceiptSource,
): Promise<DataSearchProviderRun> {
  const parsed = runSchema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.provider !== plan.provider ||
    parsed.data.endpoint !== plan.endpoint ||
    (source.kind === "saved-run" && parsed.data.runId !== source.runId)
  ) {
    return invalidResponse();
  }
  const run = parsed.data;
  const base = { upstreamRunId: run.runId, stoppable: run.stoppable };
  if (run.status === "READY") {
    return { ...base, state: "pending" };
  }
  if (run.status === "RUNNING" || run.status === "STOPPING") {
    return { ...base, state: "running" };
  }
  const actualCostUsdMicros = settledCost(run, source);
  if (run.status === "STOPPED") {
    return { ...base, state: "cancelled", actualCostUsdMicros };
  }
  if (
    run.status !== "COMPLETED" ||
    !run.providerResponse ||
    run.providerResponse.httpStatus < 200 ||
    run.providerResponse.httpStatus >= 300 ||
    (run.providerResponse.error !== undefined &&
      run.providerResponse.error !== null)
  ) {
    return {
      ...base,
      state: "failed",
      actualCostUsdMicros,
      errorCode: "DATA_SEARCH_SOURCE_FAILED",
      errorMessage: "The data source could not complete this operation.",
    };
  }
  const projected = await settleIncludingAbort(() => {
    return projectDataSearchProviderOutput(plan, run.output);
  });
  if (!projected.ok) {
    return {
      ...base,
      state: "failed",
      actualCostUsdMicros,
      errorCode: "DATA_SEARCH_INVALID_RESULT",
      errorMessage: "The data source could not deliver a valid result.",
    };
  }
  return {
    ...base,
    state: "completed",
    actualCostUsdMicros,
    data: projected.value,
  };
}

async function normalizeFirecrawl(
  plan: DataSearchProviderPlan,
  raw: unknown,
): Promise<DataSearchProviderRun> {
  const envelope = z
    .object({
      success: z.literal(true),
      data: z.object({
        alexandria: z
          .array(
            z.object({
              success: z.boolean().optional(),
              provider: z.string(),
              capability: z.string(),
              creditsCost: z
                .number()
                .int()
                .nonnegative()
                .max(Number.MAX_SAFE_INTEGER),
              data: z.unknown().optional(),
              error: z.unknown().optional(),
            }),
          )
          .length(1),
      }),
    })
    .safeParse(raw);
  if (!envelope.success) {
    return invalidResponse();
  }
  const result = envelope.data.data.alexandria[0];
  if (
    !result ||
    result.provider !== plan.provider ||
    result.capability !== plan.endpoint
  ) {
    return invalidResponse();
  }
  const actualCostUsdMicros = safeCost(
    result.creditsCost * firecrawlRate(plan),
  );
  if (
    result.success === false ||
    (result.error !== undefined && result.error !== null)
  ) {
    return {
      state: "failed",
      actualCostUsdMicros,
      stoppable: false,
      errorCode: "DATA_SEARCH_SOURCE_FAILED",
      errorMessage: "The data source could not complete this operation.",
    };
  }
  const projected = await settleIncludingAbort(() => {
    return projectDataSearchProviderOutput(plan, result.data);
  });
  if (!projected.ok) {
    return {
      state: "failed",
      actualCostUsdMicros,
      stoppable: false,
      errorCode: "DATA_SEARCH_INVALID_RESULT",
      errorMessage: "The data source could not deliver a valid result.",
    };
  }
  return {
    state: "completed",
    actualCostUsdMicros,
    data: projected.value,
    stoppable: false,
  };
}

/** The durable job owner claims each requestId once. Never replay an uncertain paid POST. */
export async function startDataSearchProvider(
  plan: DataSearchProviderPlan,
  requestId: string,
  signal: AbortSignal,
): Promise<DataSearchProviderRun> {
  const checked = checkedDataSearchProviderPlan(plan);
  if (!z.uuid().safeParse(requestId).success) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_REQUEST_ID",
      "A valid request identifier is required.",
      422,
    );
  }
  key(checked.vendor);
  if (checked.vendor === "firecrawl") {
    firecrawlRate(checked);
  }
  signal.throwIfAborted();
  const started = await settleIncludingAbort(
    checked.vendor === "monid"
      ? monidRequest(
          "/run",
          "POST",
          {
            provider: checked.provider,
            endpoint: checked.endpoint,
            input: checked.input,
          },
          signal,
        )
      : request(
          `${FIRECRAWL}/scrape`,
          "POST",
          {
            alexandria: {
              provider: checked.provider,
              capability: checked.endpoint,
              options: checked.input,
            },
          },
          signal,
          {
            Authorization: `Bearer ${key("firecrawl")}`,
            "x-request-id": requestId,
          },
        ),
  );
  if (!started.ok) {
    return {
      state: "unknown",
      errorCode: "DATA_SEARCH_START_UNKNOWN",
      errorMessage:
        "Execution could not be confirmed. Do not start this request again.",
    };
  }
  const normalized = await settleIncludingAbort(
    checked.vendor === "monid"
      ? normalizeMonid(checked, started.value.body, { kind: "submission" })
      : normalizeFirecrawl(checked, started.value.body),
  );
  if (!normalized.ok) {
    const run = runSchema.safeParse(started.value.body);
    return {
      state: "unknown",
      ...(run.success &&
      run.data.provider === checked.provider &&
      run.data.endpoint === checked.endpoint
        ? { upstreamRunId: run.data.runId }
        : {}),
      errorCode: "DATA_SEARCH_START_UNKNOWN",
      errorMessage:
        "Execution could not be confirmed. Read the saved job before starting another request.",
    };
  }
  if (started.value.status < 200 || started.value.status >= 300) {
    return {
      ...normalized.value,
      data: undefined,
      state: "unknown",
      errorCode: "DATA_SEARCH_START_UNKNOWN",
      errorMessage:
        "Execution could not be confirmed. Read the saved job before starting another request.",
    };
  }
  return normalized.value;
}

export async function readDataSearchProvider(
  plan: DataSearchProviderPlan,
  runId: string,
  signal: AbortSignal,
): Promise<DataSearchProviderRun> {
  const checked = checkedDataSearchProviderPlan(plan);
  if (checked.vendor === "firecrawl") {
    throw new Error("A synchronous data source cannot have a saved run ID");
  }
  if (!runIdSchema.safeParse(runId).success) {
    throw new Error("Invalid saved Data Search source run ID");
  }
  const response = await monidRequest(
    `/runs/${encodeURIComponent(runId)}`,
    "GET",
    undefined,
    signal,
  );
  if (response.status !== 200) {
    return unavailable();
  }
  return normalizeMonid(checked, response.body, { kind: "saved-run", runId });
}
export async function stopDataSearchProvider(
  plan: DataSearchProviderPlan,
  runId: string,
  signal: AbortSignal,
): Promise<DataSearchProviderRun> {
  const checked = checkedDataSearchProviderPlan(plan);
  if (checked.vendor === "firecrawl") {
    throw new Error("A synchronous data source cannot have a saved run ID");
  }
  if (!runIdSchema.safeParse(runId).success) {
    throw new Error("Invalid saved Data Search source run ID");
  }
  const response = await monidRequest(
    `/runs/${encodeURIComponent(runId)}/stop`,
    "POST",
    undefined,
    signal,
  );
  if (response.status === 409) {
    return readDataSearchProvider(checked, runId, signal);
  }
  const parsed = z
    .object({ runId: runIdSchema, status: z.literal("STOPPING") })
    .safeParse(response.body);
  if (
    response.status !== 202 ||
    !parsed.success ||
    parsed.data.runId !== runId
  ) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_CANCEL_UNKNOWN",
      "Cancellation could not be confirmed. Read the saved job to check its status.",
    );
  }
  return { upstreamRunId: runId, state: "running", stoppable: true };
}
