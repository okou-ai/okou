import { z } from "zod";

import type {
  DataSearchJsonValue,
  DataSearchProviderPlan,
} from "./data-search-catalog";
import { DataSearchProviderError } from "./data-search-provider-error";

const objectSchema = z.record(z.string(), z.unknown());
function object(value: unknown): Record<string, unknown> {
  const parsed = objectSchema.safeParse(value);
  if (!parsed.success) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_RESULT",
      "The data source returned an unsupported result.",
    );
  }
  return parsed.data;
}
function pick(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, DataSearchJsonValue> {
  const result: Record<string, DataSearchJsonValue> = {};
  for (const key of fields) {
    const parsed = z.json().safeParse(value[key]);
    if (parsed.success) {
      result[key] = parsed.data;
    }
  }
  return result;
}
const personFields = Object.freeze([
  "id",
  "first_name",
  "last_name",
  "name",
  "title",
  "headline",
  "linkedin_url",
  "city",
  "state",
  "country",
  "seniority",
  "departments",
  "employment_history",
]);
const companyFields = Object.freeze([
  "id",
  "name",
  "website_url",
  "primary_domain",
  "linkedin_url",
  "industry",
  "industries",
  "keywords",
  "estimated_num_employees",
  "founded_year",
  "city",
  "state",
  "country",
  "short_description",
  "annual_revenue",
  "annual_revenue_printed",
  "total_funding",
]);
function company(value: unknown): Record<string, DataSearchJsonValue> {
  const record = object(value);
  if (!(
    (typeof record.id === "string" && record.id.length > 0) ||
    (typeof record.name === "string" && record.name.length > 0)
  )) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_RESULT",
      "The data source returned an unsupported company.",
    );
  }
  return pick(record, companyFields);
}
function source(
  plan: DataSearchProviderPlan,
): Record<string, DataSearchJsonValue> {
  return { provider: plan.provider, capability: plan.capability };
}
function person(
  plan: DataSearchProviderPlan,
  raw: unknown,
  preview: boolean,
): DataSearchJsonValue {
  const value = object(raw);
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_RESULT",
      "The data source returned an unsupported person.",
    );
  }
  const result = pick(
    value,
    personFields.filter((key) => {
      return key !== "employment_history";
    }),
  );
  // Employment entries are projected independently: upstream nested contacts must not bypass field selection.
  if (Array.isArray(value.employment_history)) {
    result.employment_history = value.employment_history
      .slice(0, 100)
      .map((entry) => {
        return pick(object(entry), [
          "id",
          "organization_id",
          "organization_name",
          "title",
          "start_date",
          "end_date",
          "current",
        ]);
      });
  }
  if (value.organization !== null && value.organization !== undefined) {
    result.organization = company(value.organization);
  }
  if (preview) {
    delete result.last_name;
    delete result.name;
    Object.assign(
      result,
      pick(value, [
        "last_name_obfuscated",
        "has_email",
        "has_city",
        "has_state",
        "has_country",
        "has_direct_phone",
      ]),
    );
  }
  return { ...result, preview, source: source(plan) };
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_RESULT",
      "The data source returned an unsupported result.",
    );
  }
  return value;
}

function projectPeopleSearch(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  return {
    items: array(value.people)
      .slice(0, plan.limit)
      .map((entry) => {
        return person(plan, entry, true);
      }),
  };
}

function projectPeopleEnrich(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  if (plan.provider === "apollo") {
    return {
      items: value.person === null ? [] : [person(plan, value.person, false)],
    };
  }
  const data = object(value.data);
  if (data.email === null) {
    return { items: [] };
  }
  const email = z.email().safeParse(data.email);
  if (
    !email.success ||
    /[＊*•]/.test(email.data) ||
    email.data.split("@")[1]?.toLowerCase() !==
      String(plan.request.input.domain).trim().toLowerCase()
  ) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_RESULT",
      "The data source returned an unsupported contact.",
    );
  }
  const result = pick(data, [
    "email",
    "score",
    "first_name",
    "last_name",
    "position",
    "company",
    "linkedin_url",
    "twitter",
  ]);
  if (data.verification !== undefined && data.verification !== null) {
    result.verification = pick(object(data.verification), ["status", "date"]);
  }
  if (Array.isArray(data.sources)) {
    result.sources = data.sources.slice(0, 20).map((entry) => {
      return pick(object(entry), [
        "domain",
        "uri",
        "extracted_on",
        "last_seen_on",
        "still_on_page",
      ]);
    });
  }
  return {
    items: [
      {
        ...result,
        domain: String(plan.request.input.domain),
        source: source(plan),
      },
    ],
  };
}

function projectCompanySearch(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  return {
    items: array(value.organizations)
      .slice(0, plan.limit)
      .map((entry) => {
        return { ...company(entry), source: source(plan) };
      }),
  };
}

function projectCompanyInspect(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  return {
    items:
      value.organization === null
        ? []
        : [{ ...company(value.organization), source: source(plan) }],
  };
}

function projectTrafficOverview(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  return {
    items:
      value.data === null
        ? []
        : array(value.data)
            .slice(0, 1)
            .map((entry) => {
              return {
                ...pick(object(entry), [
                  "date",
                  "visits",
                  "average_visit_duration",
                  "pages_per_visit",
                  "bounce_rate",
                  "unique_visitors",
                ]),
                domain: String(plan.request.input.domain),
                source: source(plan),
              };
            }),
  };
}

function projectAdsSearch(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  return {
    items: array(value.data)
      .slice(0, plan.limit)
      .map((entry) => {
        return {
          ...pick(object(entry), [
            "id",
            "advertiser",
            "media_type",
            "is_active",
            "started_at",
            "dimensions",
            "one_line",
            "hook_text",
            "strength",
            "ad_library_url",
          ]),
          source: source(plan),
        };
      }),
  };
}

function projectCreatorsSearch(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  return {
    items: array(value.data)
      .slice(0, plan.limit)
      .map((entry) => {
        return {
          ...pick(object(entry), [
            "id",
            "platform",
            "handle",
            "displayName",
            "bio",
            "bioLink",
            "language",
            "isPrivate",
            "isVerified",
            "postsCount",
            "followersCount",
            "followingCount",
            "profileUrl",
          ]),
          source: source(plan),
        };
      }),
  };
}

function projectAffiliateSearch(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  return {
    items: array(value.data)
      .slice(0, plan.limit)
      .map((entry) => {
        return {
          ...pick(object(entry), [
            "id",
            "object_id",
            "slug",
            "origin_id",
            "name",
            "description",
            "domains",
            "home_url",
            "logo_url",
            "product_count",
            "cookie_duration",
            "supports_deeplinking",
            "categories",
            "countries",
            "currencies",
            "providers",
            "network",
            "canonical",
            "supports",
          ]),
          source: source(plan),
        };
      }),
  };
}

function projectPodcastsSearch(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  return {
    items: array(value.data)
      .slice(0, plan.limit)
      .map((entry) => {
        return {
          ...pick(object(entry), [
            "id",
            "slug",
            "title",
            "description",
            "language",
            "explicit",
            "episode_count",
            "popularity",
            "image_url",
            "url",
            "publisher",
            "topics",
            "format",
            "suitability_tier",
            "match_quality",
          ]),
          source: source(plan),
        };
      }),
  };
}

function projectWebHistory(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  return {
    items: array(value.captures)
      .slice(0, plan.limit)
      .map((entry) => {
        return {
          ...pick(object(entry), ["archive_url", "status", "timestamp"]),
          url: String(plan.request.input.url),
          source: source(plan),
        };
      }),
  };
}

function projectTrendsRelated(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  const rows = [
    ...array(value.top).map((entry) => {
      return {
        ...pick(object(entry), [
          "query",
          "value",
          "formatted_value",
          "explore_url",
        ]),
        kind: "top",
      };
    }),
    ...array(value.rising).map((entry) => {
      return {
        ...pick(object(entry), [
          "query",
          "value",
          "formatted_value",
          "explore_url",
          "breakout",
        ]),
        kind: "rising",
      };
    }),
  ];
  return {
    items: rows.slice(0, plan.limit).map((entry) => {
      return {
        ...entry,
        keyword: String(plan.request.input.keyword),
        source: source(plan),
      };
    }),
  };
}

function projectAppsProfile(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  if (
    typeof value.package !== "string" ||
    value.package !== plan.request.input.package ||
    typeof value.title !== "string"
  ) {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_RESULT",
      "The data source returned an unsupported app listing.",
    );
  }
  return {
    items: [
      {
        ...pick(value, [
          "package",
          "title",
          "url",
          "developer_id",
          "developer_name",
          "developer_url",
          "developer_website",
          "description_html",
          "categories",
          "free",
          "currency",
          "price_micros",
          "price_display",
          "installs_display",
          "installs_estimate",
          "installs_min",
          "rating",
          "released",
          "updated",
          "version",
          "observed_at_ms",
        ]),
        source: source(plan),
      },
    ],
  };
}

function projectFinanceCompanyProfile(
  plan: DataSearchProviderPlan,
  value: Record<string, unknown>,
): { items: DataSearchJsonValue[] } {
  if (typeof value.companyFiscalIdentifier !== "string") {
    throw new DataSearchProviderError(
      "DATA_SEARCH_INVALID_RESULT",
      "The data source returned an unsupported company profile.",
    );
  }
  return {
    items: [
      {
        ...pick(value, [
          "companyFiscalIdentifier",
          "companyKey",
          "displayNameEnglish",
          "legalNameEnglish",
          "tradeNameEnglish",
          "companyType",
          "companyStatus",
          "headquartersCountryCode",
          "headquartersCountryName",
          "headquartersRegion",
          "legalDomicileCountryCode",
          "descriptionShort",
          "descriptionLong",
          "chiefExecutiveOfficer",
          "foundingYear",
          "ipoYear",
          "sector",
          "industryGroup",
          "industry",
          "subIndustry",
          "cik",
          "marketCapUsd",
          "primaryListing",
          "secondaryListings",
          "peers",
          "companyId",
          "reportingCurrency",
          "updatedAt",
        ]),
        source: source(plan),
      },
    ],
  };
}

/** Deliberately excludes raw envelopes, phone numbers, private emails and provider error text. */
export function projectDataSearchProviderOutput(
  plan: DataSearchProviderPlan,
  raw: unknown,
): { items: DataSearchJsonValue[] } {
  const value = object(raw);
  switch (plan.capability) {
    case "people.search": {
      return projectPeopleSearch(plan, value);
    }
    case "people.enrich": {
      return projectPeopleEnrich(plan, value);
    }
    case "company.search": {
      return projectCompanySearch(plan, value);
    }
    case "company.inspect": {
      return projectCompanyInspect(plan, value);
    }
    case "traffic.overview": {
      return projectTrafficOverview(plan, value);
    }
    case "ads.search": {
      return projectAdsSearch(plan, value);
    }
    case "creators.search": {
      return projectCreatorsSearch(plan, value);
    }
    case "affiliate.search": {
      return projectAffiliateSearch(plan, value);
    }
    case "podcasts.search": {
      return projectPodcastsSearch(plan, value);
    }
    case "web.history": {
      return projectWebHistory(plan, value);
    }
    case "trends.related": {
      return projectTrendsRelated(plan, value);
    }
    case "apps.profile": {
      return projectAppsProfile(plan, value);
    }
    case "finance.company-profile": {
      return projectFinanceCompanyProfile(plan, value);
    }
    default: {
      throw new DataSearchProviderError(
        "DATA_SEARCH_INVALID_RESULT",
        "This data source has no reviewed result projection.",
      );
    }
  }
}
