import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";

/**
 * How many connectors each category contributes to a keyword-free discovery
 * response. Discovery used to return one global top-100, which meant a
 * category with 1 184 connectors and a category with 47 were both represented
 * by whatever happened to rank highest overall, and eight of the twelve
 * categories were usually absent from the first screen entirely.
 */
export const CONNECTOR_DISCOVERY_PER_CATEGORY = 12;

/** Upper bound on a keyword search response. */
export const CONNECTOR_SEARCH_LIMIT = 100;

/**
 * Connectors Okou operates for itself. They are real catalog entries because
 * our own agents connect them, but they are not products a customer is
 * shopping for, and ranking by connection frequency floats them to the top of
 * discovery. Excluded from discovery and search; still connectable by slug.
 */
const INTERNAL_CONNECTOR_SLUGS = [
  "maskdb",
  "db9",
  "drive9",
  "slock",
  "runtime",
] as const satisfies readonly ConnectorSlug[];

/**
 * Discovery ranking, most-wanted first.
 *
 * This list is a seed, not the destination. The ranking it replaces was
 * derived from connection counts in our own database, which promoted what the
 * Okou team connected — Steam, WeRead, Strava, and our own internal tooling —
 * over the products customers ask for; Stripe sat at position 97 and
 * Salesforce was absent. Until a scheduled job recomputes this from distinct
 * connecting organizations with our own orgs excluded, the order below is
 * curated against the product's stated audience: non-technical business
 * users, then the technical tail.
 *
 * Anything absent from this list is still discoverable. Unranked connectors
 * sort after ranked ones, alphabetically, inside their own category.
 */
const CONNECTOR_POPULARITY_RANKING = [
  // Mail, calendar, and the files people work out of every day.
  "gmail",
  "google-drive",
  "google-calendar",
  "google-sheets",
  "google-docs",
  "outlook-mail",
  "outlook-calendar",
  "notion",
  "dropbox",
  "box",
  "airtable",
  // Where teams talk.
  "slack",
  "microsoft-teams-bot",
  "discord",
  "telegram",
  "zoom-admin",
  "google-meet",
  "lark",
  // Money, customers, and the back office.
  "stripe",
  "shopify",
  "quickbooks",
  "xero",
  "salesforce",
  "hubspot",
  "pipedrive",
  "attio",
  "apollo",
  "clay",
  "gusto",
  "deel",
  "brex",
  "intercom",
  // Marketing and content.
  "mailchimp",
  "klaviyo",
  "sendgrid",
  "google-ads",
  "meta-ads",
  "google-analytics",
  "ahrefs",
  "semrush",
  "typeform",
  "calendly",
  "webflow",
  "wordpress",
  "figma",
  "loom",
  "miro",
  // Social.
  "linkedin",
  "x",
  "youtube",
  "instagram",
  "tiktok",
  // Work tracking.
  "linear",
  "jira",
  "atlassian",
  "asana",
  "trello",
  "clickup",
  "monday",
  "todoist",
  "smartsheet",
  // Models and generation.
  "openai",
  "claude",
  "gemini",
  "deepseek",
  "perplexity",
  "elevenlabs",
  "runway",
  "luma-ai",
  "hugging-face",
  "openrouter",
  "replicate",
  "groq",
  "minimax",
  "heygen",
  "gamma",
  // Engineering.
  "github",
  "gitlab",
  "vercel",
  "supabase",
  "sentry",
  "cloudflare",
  "google-cloud",
  "neon",
  "railway",
  "render",
  "clerk",
  "doppler",
  "posthog",
  "plausible",
  "axiom",
  // Automation, search, and scraping.
  "make",
  "firecrawl",
  "serpapi",
  "tavily",
  "exa",
  "apify",
  "browser-use",
  "browserbase",
  "e2b",
  "google-search-console",
  "google-maps",
  "openweather",
  "resend",
  "twilio",
  "strava",
] as const satisfies readonly ConnectorSlug[];

/**
 * Rank lookup for one request. Built per call rather than at module scope,
 * because a package-level mutable Map is not allowed here, and because a
 * comparator that scanned the ranking for every comparison would turn an
 * ordering pass over the whole catalog into quadratic work.
 */
export function createConnectorPopularityIndex(): ReadonlyMap<string, number> {
  return new Map(
    CONNECTOR_POPULARITY_RANKING.map((slug, index) => {
      return [slug, index];
    }),
  );
}

/** Rank of one connector. Unranked connectors sort after every ranked one. */
export function connectorPopularityRank(
  index: ReadonlyMap<string, number>,
  slug: string,
): number {
  return index.get(slug) ?? Number.MAX_SAFE_INTEGER;
}

export function isInternalConnector(slug: string): boolean {
  return INTERNAL_CONNECTOR_SLUGS.some((internal) => {
    return internal === slug;
  });
}

/** Order by rank, then by label, so the tail is still predictable. */
export function compareConnectorPopularity(
  index: ReadonlyMap<string, number>,
  left: { readonly slug: string; readonly label: string },
  right: { readonly slug: string; readonly label: string },
): number {
  const rankDelta =
    connectorPopularityRank(index, left.slug) -
    connectorPopularityRank(index, right.slug);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  return left.label.localeCompare(right.label);
}
