import type { DataSearchRequest } from "@okouai/api-contracts/contracts/data-search";
import { Command, InvalidArgumentError, Option } from "commander";

import { isPaidToolEnabled } from "../../lib/command/paid-tools";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import type { DataProspectOptions } from "./query";

type Execute = (
  capability: string,
  input: DataSearchRequest["input"],
  options: DataProspectOptions,
  defaultLimit?: number,
) => Promise<void>;
type AddOptions = (
  command: Command,
  includeLimit?: boolean,
  maxLimit?: number,
) => void;

interface SourceOptions extends DataProspectOptions {
  readonly month?: string;
  readonly country?: string;
  readonly device?: string;
  readonly metrics?: string[];
  readonly active?: boolean;
  readonly recencyDays?: number;
  readonly geo?: string;
  readonly time?: string;
  readonly property?: string;
  readonly handle?: string;
  readonly name?: string;
  readonly bio?: string;
  readonly date?: string;
  readonly category?: string;
  readonly language?: string;
  readonly topic?: string;
  readonly companyKey?: string;
  readonly fscl?: string;
  readonly ticker?: string;
  readonly exchange?: string;
}

function group(parent: Command, name: string, description: string): Command {
  return (
    parent.commands.find((command) => {
      return command.name() === name;
    }) ?? parent.command(name).description(description)
  );
}

function pattern(value: string, regex: RegExp, description: string): string {
  if (!regex.test(value)) throw new InvalidArgumentError(description);
  return value;
}

function text(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 500)
    throw new InvalidArgumentError("Expected 1-500 characters");
  return trimmed;
}

function country(value: string): string {
  return pattern(
    value.toUpperCase(),
    /^[A-Z]{2}$/u,
    "Expected a two-letter country code, e.g. US",
  );
}

function month(value: string): string {
  pattern(
    value,
    /^20\d{2}-(?:0[1-9]|1[0-2])$/u,
    "Expected a complete month in YYYY-MM format",
  );
  if (value >= new Date().toISOString().slice(0, 7))
    throw new InvalidArgumentError(
      "Choose a complete month before the current month",
    );
  return value;
}

function publicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("Expected a public HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    value.length > 2000
  )
    throw new InvalidArgumentError(
      "Expected a public HTTP(S) URL without credentials",
    );
  return value;
}

function inputs(
  entries: readonly (readonly [
    string,
    string | boolean | number | string[] | undefined,
  ])[],
): DataSearchRequest["input"] {
  const input: DataSearchRequest["input"] = {};
  for (const [key, value] of entries)
    if (value !== undefined) input[key] = value;
  return input;
}

/** Fixed business fields only. Source routing and billing remain server-owned. */
export function registerDataSourceCommands(
  parent: Command,
  execute: Execute,
  addOptions: AddOptions,
): void {
  const traffic = group(
    parent,
    "traffic",
    "Website traffic and engagement research",
  );
  const overview = traffic
    .command("overview")
    .description(
      "Read one complete month of website traffic; source subscription availability applies",
    )
    .argument("<domain>", "Website domain (not a URL)", (value) => {
      return pattern(
        value.toLowerCase(),
        /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u,
        "Expected a website domain, e.g. example.com",
      );
    })
    .requiredOption("--month <month>", "One complete month (YYYY-MM)", month)
    .option(
      "--country <code>",
      "Two-letter country code or ww for worldwide",
      (value) => {
        return pattern(
          value.toLowerCase(),
          /^[a-z]{2}$/u,
          "Expected a two-letter country code or ww",
        );
      },
    )
    .addOption(
      new Option("--device <device>", "Device segment").choices([
        "desktop",
        "mobile_web",
        "total",
      ]),
    )
    .option(
      "--metrics <metrics>",
      "Comma-separated visits,average_visit_duration,pages_per_visit,bounce_rate,unique_visitors",
      (value) => {
        const values = value.split(",").map((item) => {
          return item.trim();
        });
        const allowed = [
          "visits",
          "average_visit_duration",
          "pages_per_visit",
          "bounce_rate",
          "unique_visitors",
        ];
        if (
          !values.length ||
          values.length > 5 ||
          new Set(values).size !== values.length ||
          values.some((item) => {
            return !allowed.includes(item);
          })
        )
          throw new InvalidArgumentError(
            "Select 1-5 unique supported traffic metrics",
          );
        return values;
      },
    );
  addOptions(overview, false);
  overview.action(
    withErrorHandler(async (domain: string, options: SourceOptions) => {
      await execute(
        "traffic.overview",
        inputs([
          ["domain", domain],
          ["month", options.month],
          ["country", options.country],
          ["device", options.device],
          ["metrics", options.metrics],
        ]),
        options,
        1,
      );
    }),
  );

  const ads = group(parent, "ads", "Indexed advertising creative research");
  const adSearch = ads
    .command("search")
    .description("Search one bounded page of indexed ad creatives")
    .argument("<query>", "Advertising creative brief", text)
    .option("--active", "Only active creatives")
    .option(
      "--recency-days <days>",
      "Creative recency (1-365 days)",
      (value) => {
        const parsed = Number(value);
        if (
          !/^\d+$/u.test(value) ||
          !Number.isInteger(parsed) ||
          parsed < 1 ||
          parsed > 365
        )
          throw new InvalidArgumentError("Expected 1-365 days");
        return parsed;
      },
    );
  addOptions(adSearch);
  adSearch.action(
    withErrorHandler(async (query: string, options: SourceOptions) => {
      await execute(
        "ads.search",
        inputs([
          ["query", query],
          ["active", options.active],
          ["recencyDays", options.recencyDays],
        ]),
        options,
      );
    }),
  );

  const trends = group(
    parent,
    "trends",
    "Search interest and related-query research",
  );
  const related = trends
    .command("related")
    .description(
      "Read related and rising queries for one term; source billing is per call",
    )
    .argument("<keyword>", "One search term (no commas)", (value) => {
      const keyword = text(value);
      if (keyword.includes(","))
        throw new InvalidArgumentError("Provide one keyword without commas");
      return keyword;
    })
    .option(
      "--geo <geo>",
      "Country or supported regional code (e.g. US or US-CA)",
      (value) => {
        return pattern(
          value,
          /^([A-Z]{2}(-[A-Z0-9]{1,3}(-[0-9]{3})?)?)?$/u,
          "Expected an uppercase country or regional code",
        );
      },
    )
    .addOption(
      new Option("--time <range>", "Search-interest time range").choices([
        "now 1-H",
        "now 4-H",
        "now 1-d",
        "now 7-d",
        "today 1-m",
        "today 3-m",
        "today 12-m",
        "today 5-y",
        "all",
      ]),
    )
    .addOption(
      new Option("--property <property>", "Search property").choices([
        "web",
        "images",
        "news",
        "youtube",
        "shopping",
      ]),
    );
  addOptions(related);
  related.action(
    withErrorHandler(async (keyword: string, options: SourceOptions) => {
      await execute(
        "trends.related",
        inputs([
          ["keyword", keyword],
          ["geo", options.geo],
          ["time", options.time],
          ["property", options.property],
        ]),
        options,
      );
    }),
  );

  const creators = group(parent, "creators", "Indexed public creator profiles");
  const creatorSearch = creators
    .command("search")
    .description(
      "Search basic public Instagram creator profiles without contact enrichment",
    )
    .option("--handle <handle>", "Creator handle", text)
    .option("--name <name>", "Creator display name", text)
    .option("--bio <text>", "Creator bio keywords", text);
  addOptions(creatorSearch);
  creatorSearch.action(
    withErrorHandler(async (options: SourceOptions) => {
      if (!options.handle && !options.name && !options.bio)
        throw new InvalidArgumentError("Provide --handle, --name, or --bio");
      await execute(
        "creators.search",
        inputs([
          ["handle", options.handle],
          ["name", options.name],
          ["bio", options.bio],
        ]),
        options,
      );
    }),
  );

  const web = group(parent, "web", "Public web research");
  const history = web
    .command("history")
    .description(
      "List archived captures for one URL; does not fetch captured content",
    )
    .argument("<url>", "Public page URL", publicUrl)
    .option("--date <date>", "Archive date in YYYYMMDD format", (value) => {
      return pattern(value, /^\d{8}$/u, "Expected YYYYMMDD");
    });
  addOptions(history, true, 20);
  history.action(
    withErrorHandler(async (url: string, options: SourceOptions) => {
      await execute(
        "web.history",
        inputs([
          ["url", url],
          ["date", options.date],
        ]),
        options,
      );
    }),
  );

  const affiliate = group(
    parent,
    "affiliate",
    "Merchant affiliate-program research",
  );
  const merchants = affiliate
    .command("search")
    .description(
      "Search one page of merchant metadata; results do not establish commission eligibility",
    )
    .argument("<query>", "Merchant name or domain", text)
    .option("--country <code>", "Two-letter country code", country)
    .option("--category <category>", "Merchant business category", text);
  addOptions(merchants, true, 50);
  merchants.action(
    withErrorHandler(async (query: string, options: SourceOptions) => {
      await execute(
        "affiliate.search",
        inputs([
          ["query", query],
          ["country", options.country],
          ["category", options.category],
        ]),
        options,
      );
    }),
  );

  const apps = group(parent, "apps", "Public app-store listing research");
  const profile = apps
    .command("profile")
    .description(
      "Read one Android store listing and aggregate ratings, not written reviews",
    )
    .argument(
      "<package>",
      "Android package ID, e.g. com.example.app",
      (value) => {
        return pattern(
          value,
          /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/u,
          "Expected an Android package ID",
        );
      },
    )
    .option("--country <code>", "Two-letter store country code", country)
    .option("--language <language>", "Store locale, e.g. en_US", (value) => {
      return pattern(
        value,
        /^[A-Za-z]{2}([_-][A-Za-z]{2,4})?$/u,
        "Expected a store locale such as en_US",
      );
    });
  addOptions(profile, false);
  profile.action(
    withErrorHandler(async (appPackage: string, options: SourceOptions) => {
      await execute(
        "apps.profile",
        inputs([
          ["package", appPackage],
          ["country", options.country],
          ["language", options.language],
        ]),
        options,
        1,
      );
    }),
  );

  const podcasts = group(parent, "podcasts", "Podcast show metadata research");
  const podcastSearch = podcasts
    .command("search")
    .description(
      "Search one bounded page of podcast shows; no episode transcripts or implicit enrichment",
    )
    .argument("<query>", "Podcast show name", text)
    .option(
      "--language <code>",
      "Two-letter lowercase language code",
      (value) => {
        return pattern(
          value,
          /^[a-z]{2}$/u,
          "Expected a lowercase language code, e.g. en",
        );
      },
    )
    .option("--topic <topic>", "Podcast topic identifier", text);
  addOptions(podcastSearch);
  podcastSearch.action(
    withErrorHandler(async (query: string, options: SourceOptions) => {
      await execute(
        "podcasts.search",
        inputs([
          ["query", query],
          ["language", options.language],
          ["topic", options.topic],
        ]),
        options,
      );
    }),
  );

  if (!isPaidToolEnabled("finance")) return;
  const finance = group(parent, "finance", "Public financial data research");
  const company = finance
    .command("company-profile")
    .description(
      "Read one public-company profile by stable ID or exchange-qualified ticker",
    )
    .option("--company-key <key>", "Stable company key", text)
    .option("--fscl <identifier>", "Stable public-company identifier", text)
    .option("--ticker <ticker>", "Ticker (requires --exchange)", text)
    .option("--exchange <exchange>", "Listing exchange", text);
  addOptions(company, false);
  company.action(
    withErrorHandler(async (options: SourceOptions) => {
      if (
        !options.companyKey &&
        !options.fscl &&
        !(options.ticker && options.exchange)
      )
        throw new InvalidArgumentError(
          "Provide --company-key, --fscl, or both --ticker and --exchange",
        );
      await execute(
        "finance.company-profile",
        inputs([
          ["companyKey", options.companyKey],
          ["fscl", options.fscl],
          ["ticker", options.ticker],
          ["exchange", options.exchange],
        ]),
        options,
        1,
      );
    }),
  );
}
