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
  "google-ads",
  "meta-ads",
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

/**
 * The sources a field actually works in. The step shows this set for the
 * answered field rather than the whole featured list, so the grid is six
 * choices that make sense plus the catalog search for anything else. The first
 * entries are also the ones the starting prompt prefers.
 */
export const INDUSTRY_SOURCE_SLUGS: Readonly<
  Record<IndustryId, readonly ConnectorSlug[]>
> = {
  marketing: [
    "google-ads",
    "meta-ads",
    "google-sheets",
    "google-docs",
    "notion",
    "gmail",
  ],
  design: [
    "google-drive",
    "google-docs",
    "notion",
    "google-sheets",
    "gmail",
    "google-calendar",
  ],
  consulting: [
    "gmail",
    "google-docs",
    "google-sheets",
    "google-drive",
    "google-calendar",
    "hubspot",
  ],
  coaching: [
    "google-calendar",
    "google-docs",
    "gmail",
    "google-sheets",
    "notion",
    "outlook-mail",
  ],
  finance: [
    "quickbooks",
    "google-sheets",
    "gmail",
    "google-drive",
    "google-docs",
    "outlook-mail",
  ],
  operations: [
    "gmail",
    "google-calendar",
    "google-sheets",
    "google-docs",
    "notion",
    "outlook-mail",
  ],
  sales: [
    "hubspot",
    "gmail",
    "google-calendar",
    "google-sheets",
    "outlook-mail",
    "google-docs",
  ],
  software: [
    "github",
    "linear",
    "notion",
    "google-docs",
    "gmail",
    "google-sheets",
  ],
  research: [
    "notion",
    "google-drive",
    "google-docs",
    "google-sheets",
    "gmail",
    "google-calendar",
  ],
  investing: [
    "google-sheets",
    "notion",
    "gmail",
    "google-drive",
    "google-docs",
    "quickbooks",
  ],
  other: [
    "gmail",
    "google-docs",
    "google-sheets",
    "google-drive",
    "google-calendar",
    "notion",
  ],
};

/** Sources the prototype prefers first when several are connected. */
export const INDUSTRY_RECOMMENDED_SOURCES: Readonly<
  Record<IndustryId, readonly ConnectorSlug[]>
> = {
  marketing: ["google-ads", "meta-ads", "google-sheets"],
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
