import {
  AMAZON_MARKETPLACES,
  parseAmazonProductTarget,
  type AmazonMarketplace,
  type CommerceInspectRequest,
  type CommerceResponse,
  type CommerceSearchRequest,
} from "@okouai/api-contracts/contracts/commerce";
import { command } from "ccstate";
import { z } from "zod";

import { env } from "../../lib/env";
import type { AuthContext } from "../../types/auth";
import { requestSignal$ } from "../context/hono";
import { readBoundedResponseText, safeJsonParse, settle } from "../utils";
import {
  recordSuccessfulManagedUsage$,
  type ManagedUsageErrorResponse,
} from "./managed-usage.service";
import { creditPolicyRunId } from "./official-workflow-policy.service";
import { checkCommerceCredits$ } from "./commerce-credit-admission.service";

const PROVIDER = "dataforseo";
const CATEGORY = "provider_cost_usd_micros";
const BASE_URL = "https://api.dataforseo.com/v3/merchant/amazon";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Official Live pricing: https://dataforseo.com/pricing/merchant/amazon-api
// One bounded Products SERP = $0.0033; one ASIN product = $0.005.
// These admission estimates are not reservations or caller-enforced hard caps.
const PREFLIGHT_MICROS = { search: 3300, inspect: 5000 } as const;

export type CommerceRequest =
  | { operation: "search"; body: CommerceSearchRequest }
  | { operation: "inspect"; body: CommerceInspectRequest };

interface CommerceArgs {
  readonly auth: AuthContext & { readonly orgId: string };
  readonly request: CommerceRequest;
}

interface CommerceError {
  readonly status: 400 | 502 | 503;
  readonly body: {
    readonly error: { readonly code: string; readonly message: string };
  };
}
type CommerceResult =
  | { readonly status: 200; readonly body: CommerceResponse }
  | CommerceError
  | ManagedUsageErrorResponse;

function error(
  status: CommerceError["status"],
  code: string,
  message: string,
): CommerceError {
  return { status, body: { error: { code, message } } };
}

const taskSchema = z
  .object({
    status_code: z.number().int(),
    status_message: z.string(),
    cost: z.number().finite().nonnegative(),
    result: z
      .array(
        z
          .object({
            items: z.array(z.object({ type: z.string() }).passthrough()),
          })
          .passthrough(),
      )
      .nullable(),
  })
  .passthrough();
export const commerceProviderResponseSchema = z
  .object({
    status_code: z.number().int(),
    status_message: z.string(),
    cost: z.number().finite().nonnegative(),
    tasks_count: z.literal(1),
    tasks_error: z.number().int().min(0).max(1),
    tasks: z.array(taskSchema).length(1),
  })
  .passthrough();

type ProviderBody = z.infer<typeof commerceProviderResponseSchema>;

export function projectCommerceItems(
  body: ProviderBody,
  request: CommerceRequest,
): unknown[] {
  const pages = body.tasks.flatMap((task) => {
    return task.result ?? [];
  });
  // Auxiliary SERP containers (related searches/recommendations) are retained in
  // source, but are not products and must not consume the requested product limit.
  const items = pages
    .flatMap((page) => {
      return page.items;
    })
    .filter((item) => {
      return request.operation === "search"
        ? item.type === "amazon_serp" || item.type === "amazon_paid"
        : item.type === "amazon_product_info";
    });
  return items.slice(
    0,
    request.operation === "search" ? request.body.limit : 48,
  );
}

async function fetchCommerce(
  login: string,
  password: string,
  operation: CommerceRequest["operation"],
  task: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ body: ProviderBody; quantity: number } | CommerceError> {
  const fetched = await settle(
    (async () => {
      const response = await fetch(
        `${BASE_URL}/${operation === "search" ? "products" : "asin"}/live/advanced`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([task]),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        },
      );
      const text = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
      if (text.kind === "too_large") {
        return error(
          502,
          "COMMERCE_OUTPUT_TOO_LARGE",
          "DataForSEO response exceeds the size limit",
        );
      }
      if (!response.ok) {
        return error(
          502,
          "COMMERCE_PROVIDER_ERROR",
          "DataForSEO commerce request failed",
        );
      }
      const parsed = commerceProviderResponseSchema.safeParse(
        safeJsonParse(text.text),
      );
      if (!parsed.success) {
        return error(
          502,
          "COMMERCE_INVALID_RESPONSE",
          "DataForSEO returned an invalid commerce response",
        );
      }
      const body = parsed.data;
      const taskResult = body.tasks[0];
      if (!taskResult || body.status_code !== 20_000) {
        return error(
          502,
          "COMMERCE_PROVIDER_ERROR",
          "DataForSEO commerce request failed",
        );
      }
      // Documented No Search Results is a completed, possibly billable search.
      const noResults =
        operation === "search" && taskResult.status_code === 40_102;
      if (
        (!noResults &&
          (taskResult.status_code !== 20_000 || body.tasks_error !== 0)) ||
        (!noResults && !taskResult.result)
      ) {
        return error(
          502,
          "COMMERCE_TASK_ERROR",
          "DataForSEO commerce task failed",
        );
      }
      const quantity = Math.ceil(body.cost * 1_000_000);
      if (!Number.isSafeInteger(quantity)) {
        return error(
          502,
          "COMMERCE_INVALID_COST",
          "DataForSEO returned an invalid commerce cost",
        );
      }
      return { body, quantity };
    })(),
  );
  signal.throwIfAborted();
  if (!fetched.ok) {
    return error(
      502,
      "COMMERCE_UPSTREAM_ERROR",
      "DataForSEO commerce request failed or timed out",
    );
  }
  return fetched.value;
}

export const commerce$ = command(
  async (
    { get, set },
    args: CommerceArgs,
    signal: AbortSignal,
  ): Promise<CommerceResult> => {
    const login = env("OKOU_SEO_DATAFORSEO_LOGIN");
    const password = env("OKOU_SEO_DATAFORSEO_PASSWORD");
    if (!login || !password) {
      return error(
        503,
        "NOT_CONFIGURED",
        "Commerce DataForSEO provider is not configured",
      );
    }
    const providerSignal = AbortSignal.any([signal, get(requestSignal$)]);
    providerSignal.throwIfAborted();
    const request = args.request;
    const product =
      request.operation === "inspect"
        ? parseAmazonProductTarget(request.body.target)
        : null;
    if (request.operation === "inspect" && !product) {
      return error(
        400,
        "INVALID_TARGET",
        "Expected an ASIN or an Amazon product URL",
      );
    }
    const marketplace: AmazonMarketplace =
      product?.marketplace ?? request.body.marketplace ?? "amazon.com";
    const market = AMAZON_MARKETPLACES[marketplace];
    const task = {
      se_domain: marketplace,
      location_code: market.locationCode,
      language_code: market.languageCode,
      ...(request.operation === "search"
        ? {
            keyword: request.body.query,
            depth: request.body.limit,
            max_crawl_pages: 1,
          }
        : { asin: product?.asin }),
    };
    const resource = {
      kind: "commerce",
      provider: PROVIDER,
      category: CATEGORY,
    };
    const creditError = await set(
      checkCommerceCredits$,
      {
        runId: creditPolicyRunId(args.auth),
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        resource: {
          ...resource,
          quantity: PREFLIGHT_MICROS[request.operation],
        },
        label: "Commerce DataForSEO",
      },
      providerSignal,
    );
    signal.throwIfAborted();
    providerSignal.throwIfAborted();
    if (creditError) {
      return creditError;
    }
    // No retries: a timeout or uncertain provider outcome may already be billable.
    const result = await fetchCommerce(
      login,
      password,
      request.operation,
      task,
      providerSignal,
    );
    signal.throwIfAborted();
    providerSignal.throwIfAborted();
    if ("status" in result) {
      return result;
    }
    const runId =
      args.auth.tokenType === "agent" || args.auth.tokenType === "sandbox"
        ? args.auth.runId
        : undefined;
    const creditsCharged =
      result.quantity === 0
        ? 0
        : await set(
            recordSuccessfulManagedUsage$,
            {
              actor: {
                orgId: args.auth.orgId,
                userId: args.auth.userId,
                ...(runId ? { runId } : {}),
              },
              resource: { ...resource, quantity: result.quantity },
              label: "Commerce DataForSEO",
            },
            signal,
          );
    return {
      status: 200,
      body: {
        operation: request.operation,
        provider: PROVIDER,
        marketplace,
        billingCategory: CATEGORY,
        billingQuantity: result.quantity,
        providerCostUsd: result.body.cost,
        creditsCharged,
        result: {
          items: projectCommerceItems(result.body, request),
          source: result.body,
        },
      },
    };
  },
);
