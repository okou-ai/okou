import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/** Explicit Amazon marketplace, country and locale pairs; never provider URLs. */
export const AMAZON_MARKETPLACES = {
  "amazon.com": { country: "US", locationCode: 2840, languageCode: "en_US" },
  "amazon.co.uk": { country: "GB", locationCode: 2826, languageCode: "en_GB" },
  "amazon.de": { country: "DE", locationCode: 2276, languageCode: "de_DE" },
  "amazon.fr": { country: "FR", locationCode: 2250, languageCode: "fr_FR" },
  "amazon.it": { country: "IT", locationCode: 2380, languageCode: "it_IT" },
  "amazon.es": { country: "ES", locationCode: 2724, languageCode: "es_ES" },
  // DataForSEO lists en_US, not en_CA; location and domain remain Canadian.
  "amazon.ca": { country: "CA", locationCode: 2124, languageCode: "en_US" },
  "amazon.co.jp": { country: "JP", locationCode: 2392, languageCode: "ja_JP" },
  "amazon.in": { country: "IN", locationCode: 2356, languageCode: "en_IN" },
} as const;

export const amazonMarketplaceSchema = z.enum([
  "amazon.com",
  "amazon.co.uk",
  "amazon.de",
  "amazon.fr",
  "amazon.it",
  "amazon.es",
  "amazon.ca",
  "amazon.co.jp",
  "amazon.in",
]);
export type AmazonMarketplace = z.infer<typeof amazonMarketplaceSchema>;

/** Parse only recognized HTTPS product paths; URLs are never fetched directly. */
export function parseAmazonProductTarget(target: string): {
  asin: string;
  marketplace?: AmazonMarketplace;
} | null {
  if (/^[A-Za-z0-9]{10}$/.test(target)) {
    return { asin: target.toUpperCase() };
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  const marketplace = amazonMarketplaceSchema.safeParse(
    url.hostname.replace(/^www\./, ""),
  );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !marketplace.success
  ) {
    return null;
  }
  const asin =
    /^(?:\/[^/]+)?\/dp\/([A-Za-z0-9]{10})(?:\/|$)/.exec(url.pathname)?.[1] ??
    /^\/gp\/product\/([A-Za-z0-9]{10})(?:\/|$)/.exec(url.pathname)?.[1];
  return asin
    ? { asin: asin.toUpperCase(), marketplace: marketplace.data }
    : null;
}

export const commerceSearchRequestSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine((value) => {
        return (
          !/https?:\/\//i.test(value) &&
          !/^(?:www\.)?amazon\.[^\s/]+\//i.test(value)
        );
      }, "Use commerce inspect for Amazon product URLs, not keyword search"),
    marketplace: amazonMarketplaceSchema.default("amazon.com"),
    limit: z.number().int().min(1).max(48).default(48),
    // Ignored: every submission is asynchronous. Accepted while supported
    // Runners still bundle CLIs that send it.
    async: z.boolean().optional(),
    requestId: z.uuid().optional(),
  })
  .strict();

export const commerceInspectRequestSchema = z
  .object({
    target: z.string().trim().min(1).max(2048),
    marketplace: amazonMarketplaceSchema.optional(),
    // Ignored: every submission is asynchronous. Accepted while supported
    // Runners still bundle CLIs that send it.
    async: z.boolean().optional(),
    requestId: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const product = parseAmazonProductTarget(value.target);
    if (!product) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "Expected an ASIN or a supported HTTPS Amazon product URL",
      });
    } else if (
      product.marketplace &&
      value.marketplace &&
      product.marketplace !== value.marketplace
    ) {
      context.addIssue({
        code: "custom",
        path: ["marketplace"],
        message: "Marketplace must match the Amazon product URL",
      });
    }
  });

export const commerceResponseSchema = z.object({
  operation: z.enum(["search", "inspect"]),
  provider: z.literal("dataforseo"),
  marketplace: amazonMarketplaceSchema,
  billingCategory: z.literal("provider_cost_usd_micros"),
  billingQuantity: z.number().int().nonnegative(),
  providerCostUsd: z.number().nonnegative(),
  creditsCharged: z.number().int().nonnegative().nullable(),
  result: z.object({
    items: z.array(z.unknown()).max(48),
    source: z.unknown(),
  }),
});

export const commerceJobSchema = z.object({
  id: z.uuid(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  operation: z.enum(["search", "inspect"]),
  provider: z.literal("dataforseo"),
  marketplace: amazonMarketplaceSchema,
  result: commerceResponseSchema.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type CommerceJob = z.infer<typeof commerceJobSchema>;

export type CommerceSearchRequest = z.infer<typeof commerceSearchRequestSchema>;
export type CommerceInspectRequest = z.infer<
  typeof commerceInspectRequestSchema
>;
export type CommerceResponse = z.infer<typeof commerceResponseSchema>;

const responses = {
  202: commerceJobSchema,
  400: apiErrorSchema,
  401: apiErrorSchema,
  402: apiErrorSchema,
  403: apiErrorSchema,
  409: apiErrorSchema,
  502: apiErrorSchema,
  503: apiErrorSchema,
} as const;

export const commerceContract = c.router({
  getJob: {
    method: "GET",
    path: "/api/commerce/jobs/:id",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.uuid() }),
    responses: {
      200: commerceJobSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Read a Commerce job without starting another paid operation",
  },
  search: {
    method: "POST",
    path: "/api/commerce/search",
    headers: authHeadersSchema,
    body: commerceSearchRequestSchema,
    responses,
    summary: "Search one page of Amazon products through managed Commerce",
  },
  inspect: {
    method: "POST",
    path: "/api/commerce/inspect",
    headers: authHeadersSchema,
    body: commerceInspectRequestSchema,
    responses,
    summary: "Inspect an Amazon product by ASIN or marketplace product URL",
  },
});
export type CommerceContract = typeof commerceContract;
