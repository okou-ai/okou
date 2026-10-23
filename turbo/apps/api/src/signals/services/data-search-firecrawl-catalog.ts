import * as z from "zod";
import { nowDate } from "../../lib/time";

import type { DataSearchRequest } from "@okouai/api-contracts/contracts/data-search";
import type {
  DataSearchJsonValue,
  ReviewedDataSearchCapability,
} from "./data-search-catalog";

const text = z.string().trim().min(1).max(500);
const country = z.string().regex(/^[A-Z]{2}$/);
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const month = z
  .string()
  .regex(/^20\d{2}-(?:0[1-9]|1[0-2])$/)
  .refine((value) => {
    return value < nowDate().toISOString().slice(0, 7);
  }, "Choose a complete month.");

function capability<T extends z.ZodType>(definition: {
  id: string;
  description: string;
  provider: string;
  endpoint: string;
  schema: T;
  maxLimit: number;
  credits: number;
  unit?: "request" | "metric";
  options: (
    value: z.output<T>,
    limit: number,
  ) => Record<string, DataSearchJsonValue>;
}): ReviewedDataSearchCapability {
  return {
    ...definition,
    vendor: "firecrawl",
    defaultLimit: Math.min(10, definition.maxLimit),
    price: { credits: definition.credits, unit: definition.unit ?? "request" },
    input(request: DataSearchRequest) {
      return definition.options(
        definition.schema.parse(request.input),
        request.limit,
      );
    },
  };
}

/** Reviewed public source: https://firecrawl.dev/alexandria/agents/providers/{provider}/openapi.json.
 * Only these fixed tools and option mappings are executable. Prose-only limits are tightened here.
 */
export const firecrawlDataSearchCapabilities: readonly ReviewedDataSearchCapability[] =
  [
    capability({
      id: "traffic.overview",
      description:
        "Monthly website visits and engagement from Similarweb. One complete month; subscription availability applies.",
      provider: "similarweb",
      endpoint: "web/traffic",
      credits: 110,
      unit: "metric",
      maxLimit: 1,
      schema: z
        .object({
          domain,
          month,
          country: z
            .string()
            .regex(/^[a-z]{2}$/)
            .optional(),
          device: z.enum(["desktop", "mobile_web", "total"]).optional(),
          metrics: z
            .array(
              z.enum([
                "visits",
                "average_visit_duration",
                "pages_per_visit",
                "bounce_rate",
                "unique_visitors",
              ]),
            )
            .min(1)
            .max(5)
            .refine((value) => {
              return new Set(value).size === value.length;
            })
            .optional(),
        })
        .strict(),
      options(value) {
        return {
          domain: value.domain,
          start_date: value.month,
          end_date: value.month,
          granularity: "monthly",
          country: value.country ?? "ww",
          web_source: value.device ?? "total",
          metrics: (value.metrics ?? ["visits"]).join(","),
        };
      },
    }),
    capability({
      id: "ads.search",
      description:
        "Search one bounded page of indexed ad creatives by brief. No automatic pagination or descriptor expansion.",
      provider: "upspring",
      endpoint: "ads/search",
      credits: 50,
      maxLimit: 100,
      schema: z
        .object({
          query: text,
          active: z.boolean().optional(),
          recencyDays: z.number().int().min(1).max(365).optional(),
        })
        .strict(),
      options(value, limit) {
        return {
          q: value.query,
          limit,
          ...(value.active === undefined
            ? {}
            : { is_active: value.active ? "true" : "false" }),
          ...(value.recencyDays === undefined
            ? {}
            : { recency_days: value.recencyDays }),
        };
      },
    }),
    capability({
      id: "trends.related",
      description:
        "Related and rising queries for one search term and time range. One fixed-cost call; limit bounds displayed rows, not source billing.",
      provider: "firecrawl-trends",
      endpoint: "trends/related_queries",
      credits: 5,
      maxLimit: 100,
      schema: z
        .object({
          keyword: text.refine((value) => {
            return !value.includes(",");
          }),
          geo: z
            .string()
            .regex(/^([A-Z]{2}(-[A-Z0-9]{1,3}(-[0-9]{3})?)?)?$/)
            .optional(),
          time: z
            .enum([
              "now 1-H",
              "now 4-H",
              "now 1-d",
              "now 7-d",
              "today 1-m",
              "today 3-m",
              "today 12-m",
              "today 5-y",
              "all",
            ])
            .optional(),
          property: z
            .enum(["web", "images", "news", "youtube", "shopping"])
            .optional(),
        })
        .strict(),
      options(value) {
        return {
          keyword: value.keyword,
          geo: value.geo ?? "",
          time: value.time ?? "today 3-m",
          property: value.property ?? "web",
        };
      },
    }),
    capability({
      id: "creators.search",
      description:
        "Search indexed Instagram creator profiles by handle, display name or bio. Basic public profile projection; no private contact enrichment.",
      provider: "oriane",
      endpoint: "instagram/profiles-search",
      credits: 20,
      maxLimit: 100,
      schema: z
        .object({
          handle: text.optional(),
          name: text.optional(),
          bio: text.optional(),
        })
        .strict()
        .refine((value) => {
          return Object.keys(value).length > 0;
        }),
      options(value, limit) {
        return {
          ...(value.handle === undefined ? {} : { handle: value.handle }),
          ...(value.name === undefined ? {} : { displayName: value.name }),
          ...(value.bio === undefined ? {} : { bio: value.bio }),
          limit,
          offset: 0,
          projection: "basic",
        };
      },
    }),
    capability({
      id: "web.history",
      description:
        "List a bounded set of archived captures for one public URL. Does not fetch archived content or crawl a domain.",
      provider: "web-archive-org",
      endpoint: "captures/history",
      credits: 5,
      maxLimit: 20,
      schema: z
        .object({
          url: z
            .url()
            .max(2000)
            .refine((value) => {
              const url = new URL(value);
              return (
                ["http:", "https:"].includes(url.protocol) &&
                !url.username &&
                !url.password
              );
            }),
          date: z
            .string()
            .regex(/^\d{8}$/)
            .optional(),
        })
        .strict(),
      options(value, limit) {
        return {
          url: value.url,
          limit,
          ...(value.date === undefined ? {} : { date: value.date }),
        };
      },
    }),
    capability({
      id: "affiliate.search",
      description:
        "Search one page of merchant affiliate-program metadata. Returned templates do not establish commission eligibility.",
      provider: "affiliate-com",
      endpoint: "merchants/search",
      credits: 25,
      maxLimit: 50,
      schema: z
        .object({
          query: text,
          country: country.optional(),
          category: text.optional(),
        })
        .strict(),
      options(value, limit) {
        return {
          search: value.query,
          per_page: limit,
          page: 1,
          ...(value.country === undefined ? {} : { countries: value.country }),
          ...(value.category === undefined
            ? {}
            : { category_name: value.category }),
        };
      },
    }),
    capability({
      id: "apps.profile",
      description:
        "Read one Android app's Google Play store listing and aggregate ratings. Does not fetch written reviews.",
      provider: "play-google-com",
      endpoint: "media/app",
      credits: 5,
      maxLimit: 1,
      schema: z
        .object({
          package: z
            .string()
            .max(255)
            .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/),
          country: country.optional(),
          language: z
            .string()
            .regex(/^[A-Za-z]{2}([_-][A-Za-z]{2,4})?$/)
            .optional(),
        })
        .strict(),
      options(value) {
        return {
          package: value.package,
          country: value.country ?? "US",
          language: value.language ?? "en_US",
        };
      },
    }),
    capability({
      id: "podcasts.search",
      description:
        "Search podcast show metadata by name with optional language and topic. No transcripts, implicit enrichment or cursor follow-up.",
      provider: "particle",
      endpoint: "podcasts/search",
      credits: 5,
      maxLimit: 100,
      schema: z
        .object({
          query: text,
          language: z
            .string()
            .regex(/^[a-z]{2}$/)
            .optional(),
          topic: text.optional(),
        })
        .strict(),
      options(value, limit) {
        return {
          q: value.query,
          limit,
          ...(value.language === undefined ? {} : { language: value.language }),
          ...(value.topic === undefined ? {} : { topic_id: value.topic }),
        };
      },
    }),
    capability({
      id: "finance.company-profile",
      description:
        "Read one public company's Fiscal.ai profile by stable identifier or exchange-qualified ticker. No licensed identifier search or financial-statement expansion.",
      provider: "fiscal-ai",
      endpoint: "company/profile",
      credits: 30,
      maxLimit: 1,
      schema: z
        .object({
          companyKey: text.optional(),
          fscl: text.optional(),
          ticker: text.optional(),
          exchange: text.optional(),
        })
        .strict()
        .refine((value) => {
          return Boolean(
            value.companyKey || value.fscl || (value.ticker && value.exchange),
          );
        }),
      options(value) {
        return {
          ...(value.companyKey === undefined
            ? {}
            : { companyKey: value.companyKey }),
          ...(value.fscl === undefined ? {} : { fscl: value.fscl }),
          ...(value.ticker === undefined ? {} : { ticker: value.ticker }),
          ...(value.exchange === undefined ? {} : { exchange: value.exchange }),
        };
      },
    }),
  ];
