import type {
  DataSearchCapability,
  DataSearchRequest,
} from "@okouai/api-contracts/contracts/data-search";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { env } from "../../lib/env";
import { firecrawlDataSearchCapabilities } from "./data-search-firecrawl-catalog";
import { DataSearchProviderError } from "./data-search-provider-error";

export type DataSearchJsonValue = z.infer<ReturnType<typeof z.json>>;
export interface DataSearchProviderPlan {
  readonly capability: string;
  readonly vendor: "monid" | "firecrawl";
  readonly provider: string;
  readonly endpoint: string;
  readonly input: Record<string, DataSearchJsonValue>;
  readonly limit: number;
  readonly request: DataSearchRequest;
  /** Frozen at quote time so a later configuration change cannot alter settlement. */
  readonly sourceCostUsdMicrosPerCredit?: number;
}

export interface ReviewedDataSearchCapability {
  readonly id: string;
  readonly description: string;
  readonly vendor: "monid" | "firecrawl";
  readonly provider: string;
  readonly endpoint: string;
  readonly schema: z.ZodType;
  readonly maxLimit: number;
  readonly defaultLimit: number;
  readonly price:
    | { readonly usdMicros: number; readonly blockSize?: number }
    | {
        readonly credits: number;
        readonly unit: "request" | "result" | "metric" | "channel";
      };
  readonly input: (
    request: DataSearchRequest,
  ) => Record<string, DataSearchJsonValue>;
}

const text = z.string().trim().min(1).max(500);
const texts = z.array(text).min(1).max(20);
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
const domains = z.array(domain).min(1).max(20);
const sizes = z
  .array(
    z
      .string()
      .regex(/^\d{1,8},\d{1,8}$/)
      .refine((value) => {
        const [minimum, maximum] = value.split(",").map(Number);
        return (
          minimum !== undefined && maximum !== undefined && minimum <= maximum
        );
      }),
  )
  .min(1)
  .max(20);
const seniority = z.enum([
  "owner",
  "founder",
  "c_suite",
  "partner",
  "vp",
  "head",
  "director",
  "manager",
  "senior",
  "entry",
  "intern",
]);
const searchSchema = z
  .object({
    query: text.optional(),
    titles: texts.optional(),
    locations: texts.optional(),
    seniorities: z.array(seniority).min(1).max(11).optional(),
    companyDomains: domains.optional(),
    companyLocations: texts.optional(),
    companySizes: sizes.optional(),
  })
  .strict()
  .refine((value) => {
    return Object.keys(value).length > 0;
  }, "Supply a query or at least one search filter.");
const enrichSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,128}$/)
      .optional(),
    linkedinUrl: z
      .url()
      .max(500)
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          (url.hostname === "linkedin.com" ||
            url.hostname === "www.linkedin.com") &&
          /^\/in\/[^/]+\/?$/.test(url.pathname) &&
          !url.search &&
          !url.hash
        );
      })
      .optional(),
    name: text.optional(),
    domain: domain.optional(),
    fields: z.tuple([z.literal("profile")]).optional(),
  })
  .strict()
  .refine((value) => {
    return Boolean(
      value.id || value.linkedinUrl || (value.name && value.domain),
    );
  }, "Supply an Apollo id, LinkedIn URL, or name and employer domain.");
const workEmailSchema = z
  .object({
    fields: z.tuple([z.literal("work-email")]),
    domain,
    name: text.optional(),
    firstName: text.optional(),
    lastName: text.optional(),
  })
  .strict()
  .refine((value) => {
    return Boolean(value.name || (value.firstName && value.lastName));
  }, "Supply name or firstName and lastName, plus the employer domain.");
const companySchema = z
  .object({
    name: text.optional(),
    domains: domains.optional(),
    locations: texts.optional(),
    sizes: sizes.optional(),
    keywords: texts.optional(),
  })
  .strict()
  .refine((value) => {
    return Object.keys(value).length > 0;
  }, "Supply at least one company filter.");

/** Map only explicitly reviewed public fields; never forward a user-supplied upstream payload. */
function mapped(
  input: Record<string, unknown>,
  keys: Readonly<Record<string, string>>,
): Record<string, DataSearchJsonValue> {
  const result: Record<string, DataSearchJsonValue> = {};
  for (const [publicKey, sourceKey] of Object.entries(keys)) {
    const value = input[publicKey];
    if (value !== undefined) {
      result[sourceKey] = z.json().parse(value);
    }
  }
  return result;
}

const monidCapabilities: readonly ReviewedDataSearchCapability[] = [
  {
    id: "people.search",
    description:
      "Find professional prospects by job title, seniority, location and employer. Search records are previews, not revealed contacts.",
    vendor: "monid",
    provider: "apollo",
    endpoint: "/mixed_people/api_search",
    schema: searchSchema,
    maxLimit: 100,
    defaultLimit: 10,
    price: { usdMicros: 0 },
    input(request) {
      const value = searchSchema.parse(request.input);
      return {
        queryParams: {
          ...mapped(value, {
            query: "q_keywords",
            titles: "person_titles[]",
            locations: "person_locations[]",
            seniorities: "person_seniorities[]",
            companyDomains: "q_organization_domains_list[]",
            companyLocations: "organization_locations[]",
            companySizes: "organization_num_employees_ranges[]",
          }),
          page: 1,
          per_page: request.limit,
        },
      };
    },
  },
  {
    id: "people.enrich",
    description:
      "Resolve one professional profile (default), or explicitly select fields:[work-email] with name and employer domain to find one business email. No phone or private-email reveal.",
    vendor: "monid",
    provider: "apollo",
    endpoint: "/people/match",
    schema: enrichSchema,
    maxLimit: 1,
    defaultLimit: 1,
    price: { usdMicros: 26_000 },
    input(request) {
      const value = enrichSchema.parse(request.input);
      return {
        queryParams: {
          ...mapped(value, {
            id: "id",
            linkedinUrl: "linkedin_url",
            name: "name",
            domain: "domain",
          }),
          reveal_personal_emails: false,
          reveal_phone_number: false,
        },
      };
    },
  },
  {
    id: "people.enrich",
    description:
      "Find one professional work email from a person's name and employer domain, with source provenance and confidence.",
    vendor: "monid",
    provider: "hunterio",
    endpoint: "/email-finder",
    schema: workEmailSchema,
    maxLimit: 1,
    defaultLimit: 1,
    price: { usdMicros: 24_500, blockSize: 1 },
    input(request) {
      const value = workEmailSchema.parse(request.input);
      return {
        queryParams: {
          ...mapped(value, {
            domain: "domain",
            name: "full_name",
            firstName: "first_name",
            lastName: "last_name",
          }),
          max_duration: 10,
        },
      };
    },
  },
  {
    id: "company.search",
    description:
      "Find companies by name, domain, headquarters, headcount and keywords.",
    vendor: "monid",
    provider: "apollo",
    endpoint: "/mixed_companies/search",
    schema: companySchema,
    maxLimit: 100,
    defaultLimit: 10,
    price: { usdMicros: 26_000 },
    input(request) {
      const value = companySchema.parse(request.input);
      return {
        queryParams: {
          ...mapped(value, {
            name: "q_organization_name",
            domains: "q_organization_domains_list[]",
            locations: "organization_locations[]",
            sizes: "organization_num_employees_ranges[]",
            keywords: "q_organization_keyword_tags[]",
          }),
          page: 1,
          per_page: request.limit,
        },
      };
    },
  },
];

const companyInspectSchema = z.object({ domain }).strict();
const companyInspectCapability = Object.freeze<ReviewedDataSearchCapability>({
  id: "company.inspect",
  description:
    "Resolve one company domain into a firmographic profile with industry, headcount, revenue and funding details.",
  vendor: "monid",
  provider: "apollo",
  endpoint: "/organizations/enrich",
  schema: companyInspectSchema,
  maxLimit: 1,
  defaultLimit: 1,
  price: { usdMicros: 26_000 },
  input(request: DataSearchRequest) {
    const value = companyInspectSchema.parse(request.input);
    return { queryParams: { domain: value.domain } };
  },
});

// Public provider guides are reviewed before adding a tool. Discovery is never a runtime routing authority.
const capabilities: readonly ReviewedDataSearchCapability[] = [
  ...monidCapabilities,
  companyInspectCapability,
  ...firecrawlDataSearchCapabilities,
];

export function reviewedDataSearchCapability(
  id: string,
  input?: Record<string, DataSearchJsonValue>,
): ReviewedDataSearchCapability {
  const workEmail =
    id === "people.enrich" &&
    Array.isArray(input?.fields) &&
    input.fields.includes("work-email");
  const capability = capabilities.find((candidate) => {
    return (
      candidate.id === id &&
      (id !== "people.enrich" ||
        candidate.provider === (workEmail ? "hunterio" : "apollo"))
    );
  });
  if (!capability) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_UNSUPPORTED_CAPABILITY",
      "This data capability is not available.",
      422,
    );
  }
  return capability;
}

export function prepareDataSearchProviderPlan(
  request: DataSearchRequest,
  sourceRate: number | undefined,
): DataSearchProviderPlan {
  const capability = reviewedDataSearchCapability(
    request.capability,
    request.input,
  );
  // The shared wire default is ten; a single-profile operation always requests one record.
  const limit =
    capability.maxLimit === 1 && request.limit === 10 ? 1 : request.limit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > capability.maxLimit
  ) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_INPUT",
      `This capability supports a limit between 1 and ${capability.maxLimit}.`,
      422,
    );
  }
  const parsed = capability.schema.safeParse(request.input);
  if (!parsed.success) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_INPUT",
      "The capability input does not match its reviewed schema. Consult data capabilities for supported fields.",
      422,
    );
  }
  const checkedRequest = { ...request, limit };
  if (
    capability.vendor === "firecrawl" &&
    (!sourceRate || !Number.isSafeInteger(sourceRate) || sourceRate < 1)
  ) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_PRICING_UNAVAILABLE",
      "This data source has no configured source-cost conversion rate.",
      503,
    );
  }
  return {
    capability: capability.id,
    vendor: capability.vendor,
    provider: capability.provider,
    endpoint: capability.endpoint,
    input: capability.input(checkedRequest),
    limit,
    request: checkedRequest,
    ...(capability.vendor === "monid"
      ? {}
      : { sourceCostUsdMicrosPerCredit: sourceRate }),
  };
}

export function checkedDataSearchProviderPlan(
  plan: DataSearchProviderPlan,
): DataSearchProviderPlan {
  const checked = prepareDataSearchProviderPlan(
    plan.request,
    plan.sourceCostUsdMicrosPerCredit,
  );
  if (!isDeepStrictEqual(checked, plan)) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_PLAN",
      "The saved data operation requires a new quote.",
      422,
    );
  }
  return checked;
}

export function dataSearchLedgerProvider(plan: {
  readonly vendor: "monid" | "firecrawl";
  readonly provider: string;
}) {
  return plan.vendor === "monid"
    ? `monid/${plan.provider}`
    : `firecrawl/alexandria/${plan.provider}`;
}

export function listDataSearchCapabilities(
  pricedProviders: ReadonlySet<string>,
): DataSearchCapability[] {
  return capabilities
    .filter((capability) => {
      return !(
        capability.id === "people.enrich" && capability.provider === "hunterio"
      );
    })
    .map((capability) => {
      return {
        id: capability.id,
        description: capability.description,
        inputSchema: z
          .record(z.string(), z.json())
          .parse(
            z.toJSONSchema(
              capability.id === "people.enrich"
                ? z.union([enrichSchema, workEmailSchema])
                : capability.schema,
            ),
          ),
        limits: { default: capability.defaultLimit, max: capability.maxLimit },
        status:
          capability.vendor === "firecrawl"
            ? env("OKOU_SCRAPE_FIRECRAWL_TOKEN") &&
              pricedProviders.has(dataSearchLedgerProvider(capability))
              ? "available"
              : "unavailable"
            : env("OKOU_SOCIAL_MONID_API_KEY")
              ? "available"
              : "unavailable",
      };
    });
}
