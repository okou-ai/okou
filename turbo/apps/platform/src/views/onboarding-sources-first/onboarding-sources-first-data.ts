import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";

/**
 * Source-first onboarding data. Ids are connector slugs so every screen, the
 * starting-prompt match, and the live connector catalog share one vocabulary.
 */
export const FEATURED_SOURCE_SLUGS = [
  "gmail",
  "google-docs",
  "google-drive",
  "google-sheets",
  "github",
  "quickbooks",
  "hubspot",
  "linear",
  "notion",
  "google-calendar",
  "outlook-mail",
] as const satisfies readonly ConnectorSlug[];

export const SOURCE_FAMILIES = {
  documents: [
    "google-docs",
    "google-drive",
    "notion",
    "box",
    "dropbox",
    "microsoft-365",
  ],
  email: ["gmail", "outlook-mail"],
  sheets: ["google-sheets"],
  calendar: ["google-calendar", "outlook-calendar"],
  projects: ["github", "linear", "asana", "monday", "todoist"],
} as const satisfies Readonly<Record<string, readonly ConnectorSlug[]>>;

export type SourceFamily = keyof typeof SOURCE_FAMILIES;

export const INDUSTRY_IDS = [
  "marketing",
  "design",
  "consulting",
  "coaching",
  "finance",
  "operations",
  "sales",
  "software",
  "research",
  "investing",
  "other",
] as const;

export type IndustryId = (typeof INDUSTRY_IDS)[number];

/** Sources the prototype prefers first when several are connected. */
export const INDUSTRY_RECOMMENDED_SOURCES: Readonly<
  Record<IndustryId, readonly ConnectorSlug[]>
> = {
  marketing: ["google-docs", "google-sheets"],
  design: ["google-drive"],
  consulting: ["gmail", "google-docs"],
  coaching: ["google-calendar", "google-docs"],
  finance: ["quickbooks", "google-sheets"],
  operations: ["gmail"],
  sales: ["hubspot", "gmail"],
  software: ["github", "linear"],
  research: ["notion", "google-drive"],
  investing: ["google-sheets", "notion"],
  other: ["gmail", "google-docs"],
};
