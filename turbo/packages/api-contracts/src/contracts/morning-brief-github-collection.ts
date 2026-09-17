import { z } from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * The GitHub priorities preview for `simple-morning-brief`.
 *
 * It is a developer verification surface: the environment gate answers 404 in
 * production before any authentication work happens, and the caller is an
 * ordinary authenticated member acting only on their own organization and user.
 * The single input is the scheduled anchor. No owner, Agent, connector account,
 * repository, query or URL can be supplied — every one of those is derived from
 * the authenticated caller's live canonical Morning Brief ownership.
 */

/** Why an invocation never reached GitHub at all. */
export const morningBriefGithubSkipReasonSchema = z.enum([
  "feature-disabled",
  "brief-absent",
  "brief-pending",
  "brief-inconsistent",
  "brief-paused",
  "missing-timezone",
  "missing-agent",
  "membership-revoked",
  "connector-not-visible",
  "connector-not-granted",
  "account-missing",
  "account-unavailable",
  "account-needs-reconnect",
  "endpoint-not-authorized",
  /** The owner's authority moved mid-collection; the bundle was discarded. */
  "context-revoked",
]);

/** The terminal classification of one collection. */
export const morningBriefGithubOutcomeSchema = z.enum([
  "complete",
  "empty",
  "partial",
  "rate_limited",
  "permission_denied",
  "provider_failed",
  "cancelled",
]);

/**
 * Which documented budget or refusal bounded the read.
 *
 * Every value here is a coverage limitation: an item the collector knows it did
 * not read. None of them may be reported as a complete or healthy-empty read.
 */
export const morningBriefGithubLimitSchema = z.enum([
  "notification-pages",
  "notification-items",
  "search-pages",
  "search-incomplete",
  "search-total-exceeded",
  "relevant-pull-requests",
  "pull-request-detail",
  "check-runs",
  "commit-status",
  "unsupported-subject",
  "unsafe-link",
  "items",
  "requests",
  "response-bytes",
  "oversized-response",
  "malformed-response",
  "text-characters",
  "deadline",
  "denied-endpoint",
  "rate-limited",
]);

/** Which of the three provider branches contributed an item. */
export const morningBriefGithubReasonSchema = z.object({
  branch: z.enum(["notification", "assigned", "review-requested"]),
  /** GitHub's own notification `reason`, when the branch supplies one. */
  notificationReason: z.string().optional(),
  unread: z.boolean().optional(),
});

/** Observed check state for one pull request head, never branch protection. */
export const morningBriefGithubCheckSummarySchema = z.object({
  headSha: z.string(),
  /**
   * `unknown` covers a denied, truncated or unreadable check surface. It is
   * deliberately not `success`: the collector reports what it saw, and an
   * unread check can never be green.
   */
  state: z.enum(["failing", "pending", "success", "unknown"]),
  failing: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  /** Bounded names of the failing contexts, for the summarization step. */
  failingNames: z.array(z.string()),
  /** True when a page, a branch or a permission stopped the check read. */
  incomplete: z.boolean(),
});

/** One normalized, merged GitHub priority. */
export const morningBriefGithubItemSchema = z.object({
  repository: z.string(),
  number: z.number().int().positive(),
  kind: z.enum(["issue", "pull-request"]),
  title: z.string(),
  excerpt: z.string().optional(),
  state: z.enum(["open", "closed", "unknown"]),
  draft: z.boolean().optional(),
  updatedAt: z.string().datetime(),
  actor: z.string().optional(),
  /** Every branch that contributed, so deduplication never loses a reason. */
  reasons: z.array(morningBriefGithubReasonSchema).min(1),
  /** A validated `https://github.com` display link, never a fetch instruction. */
  url: z.string().url().optional(),
  checks: morningBriefGithubCheckSummarySchema.optional(),
});

/** What one provider branch actually managed to read. */
export const morningBriefGithubBranchCoverageSchema = z.object({
  status: z.enum(["complete", "partial", "denied", "failed", "skipped"]),
  /** The half-open window this branch asked for, when it has one. */
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
  /** When the branch is an outstanding-work snapshot rather than a window. */
  observedAt: z.string().datetime().optional(),
  pages: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
  limits: z.array(morningBriefGithubLimitSchema),
});

export const morningBriefGithubBundleSchema = z.object({
  source: z.literal("github"),
  /** The exact login of the selected token, from `GET /user`. */
  login: z.string(),
  anchor: z.string().datetime(),
  collectedAt: z.string().datetime(),
  observedAt: z.string().datetime(),
  timezone: z.string(),
  coverage: z.enum(["complete", "partial"]),
  outcome: morningBriefGithubOutcomeSchema,
  branches: z.object({
    notifications: morningBriefGithubBranchCoverageSchema,
    assigned: morningBriefGithubBranchCoverageSchema,
    reviewRequested: morningBriefGithubBranchCoverageSchema,
    checks: morningBriefGithubBranchCoverageSchema,
  }),
  limits: z.array(morningBriefGithubLimitSchema),
  items: z.array(morningBriefGithubItemSchema),
  counts: z.object({
    items: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    responseBytes: z.number().int().nonnegative(),
    textCharacters: z.number().int().nonnegative(),
  }),
  /** Bounded provider hint; metadata only, never a sleep or retry budget. */
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});

const collectResponseSchema = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("not-executed"),
    reason: morningBriefGithubSkipReasonSchema,
  }),
  z.object({
    result: z.literal("collected"),
    bundle: morningBriefGithubBundleSchema,
  }),
]);

export const morningBriefGithubCollectionContract = c.router({
  collect: {
    method: "POST",
    path: "/api/morning-brief/preview/github-collection",
    headers: authHeadersSchema,
    body: z.object({
      /**
       * The scheduled anchor. Notifications use `[anchor - 24 hours, anchor)`;
       * assigned work and review requests are current outstanding snapshots
       * with no lower bound.
       */
      scheduledFor: z.string().datetime(),
    }),
    responses: {
      200: collectResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: z.union([apiErrorSchema, z.string()]),
    },
    summary:
      "Collect one bounded GitHub priorities bundle for a Morning Brief anchor",
  },
});

export type MorningBriefGithubSkipReason = z.infer<
  typeof morningBriefGithubSkipReasonSchema
>;
export type MorningBriefGithubOutcome = z.infer<
  typeof morningBriefGithubOutcomeSchema
>;
export type MorningBriefGithubLimit = z.infer<
  typeof morningBriefGithubLimitSchema
>;
export type MorningBriefGithubReason = z.infer<
  typeof morningBriefGithubReasonSchema
>;
export type MorningBriefGithubCheckSummary = z.infer<
  typeof morningBriefGithubCheckSummarySchema
>;
export type MorningBriefGithubItem = z.infer<
  typeof morningBriefGithubItemSchema
>;
export type MorningBriefGithubBranchCoverage = z.infer<
  typeof morningBriefGithubBranchCoverageSchema
>;
export type MorningBriefGithubBundle = z.infer<
  typeof morningBriefGithubBundleSchema
>;
