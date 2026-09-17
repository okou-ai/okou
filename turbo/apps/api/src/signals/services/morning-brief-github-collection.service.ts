import type {
  MorningBriefGithubBranchCoverage,
  MorningBriefGithubBundle,
  MorningBriefGithubCheckSummary,
  MorningBriefGithubItem,
  MorningBriefGithubLimit,
  MorningBriefGithubOutcome,
  MorningBriefGithubReason,
  MorningBriefGithubSkipReason,
} from "@okouai/api-contracts/contracts/morning-brief-github-collection";
import { z } from "zod";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { safeUrlParse } from "../utils";
import type { ClerkClient } from "../external/clerk";
import {
  admitMorningBriefCollection,
  withMorningBriefConnectorReader,
  type MorningBriefCollectionScope,
  type MorningBriefConnectorReader,
  type MorningBriefReadOutcome,
  type MorningBriefResponseMetadata,
} from "./morning-brief-connector-reader.service";

/**
 * The bounded GitHub priorities reader for `simple-morning-brief`.
 *
 * It answers three questions the recipient actually needs: what changed in the
 * last 24 hours, what is still assigned to them, and what still waits for
 * their review. The first is a half-open window; the other two are current
 * outstanding-work snapshots with no lower bound, because an assignment that
 * has been open for a month is exactly the kind of item notifications lose.
 *
 * Everything here is bounded and memory-only. Nothing is written to GitHub, no
 * notification is marked read, and no provider-supplied URL is ever fetched.
 * See [the collection contract](../../../../../../docs/morning-brief-github-collection.md).
 */

const GITHUB_CONNECTOR_SLUG = "github";

/** The GitHub connector's fixed API host, owned by the accepted catalog. */
const GITHUB_API_BASE = "https://api.github.com";

/**
 * The runtime environment name that carries the selected account's token.
 *
 * This is the connector's own per-account binding, resolved from encrypted
 * account storage by the shared reader. It is unrelated to any `GH_TOKEN`
 * process credential, which this path must never use.
 */
const GITHUB_ACCESS_TOKEN_ENVIRONMENT_NAME = "GITHUB_TOKEN";

/** Notifications cover the 24 hours ending at the anchor. */
const MORNING_BRIEF_GITHUB_WINDOW_MS = 24 * 60 * 60 * 1000;

const MORNING_BRIEF_GITHUB_BUDGET = {
  /** `/user`, 2 notification pages, 2 + 2 search pages, 5 × 3 pull reads. */
  maxRequests: 24,
  maxResponseBytes: 256 * 1024,
  maxTotalResponseBytes: 2 * 1024 * 1024,
  deadlineMs: 20_000,
  concurrency: 2,
  notificationPages: 2,
  notificationPerPage: 50,
  searchPages: 2,
  searchPerPage: 25,
  relevantPullRequests: 5,
  checkRunsPerPage: 50,
  maxItems: 50,
  maxExcerptCharacters: 500,
  maxTextCharacters: 40_000,
  maxFailingNames: 10,
} as const;

/**
 * GitHub's own login grammar.
 *
 * The login is interpolated into a server-owned search query, so it is
 * validated before any query exists rather than trusted because it arrived
 * over TLS.
 */
const githubLoginSchema = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/);

const githubUserSchema = z.object({ login: githubLoginSchema });

const notificationSubjectSchema = z.object({
  title: z.string(),
  type: z.string(),
  url: z.string().nullish(),
});

const notificationSchema = z.object({
  id: z.string(),
  reason: z.string(),
  unread: z.boolean(),
  updated_at: z.string(),
  subject: notificationSubjectSchema,
  repository: z.object({ full_name: z.string() }),
});

const notificationsSchema = z.array(notificationSchema);

const searchItemSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
  updated_at: z.string(),
  repository_url: z.string(),
  body: z.string().nullish(),
  draft: z.boolean().nullish(),
  /** Present only on pull requests; its contents are deliberately ignored. */
  pull_request: z.unknown().optional(),
  user: z.object({ login: z.string() }).nullish(),
});

const searchResultSchema = z.object({
  total_count: z.number().int().nonnegative(),
  incomplete_results: z.boolean(),
  items: z.array(searchItemSchema),
});

const pullDetailSchema = z.object({
  number: z.number().int(),
  state: z.string(),
  draft: z.boolean().nullish(),
  updated_at: z.string(),
  head: z.object({ sha: z.string().regex(/^[0-9a-f]{7,64}$/) }),
});

const checkRunsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullish(),
    }),
  ),
});

const commitStatusSchema = z.object({
  state: z.string(),
  total_count: z.number().int().nonnegative(),
  statuses: z.array(z.object({ context: z.string(), state: z.string() })),
});

type SubjectKind = "issue" | "pull-request";

interface RepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

interface SubjectRef extends RepositoryRef {
  readonly kind: SubjectKind;
  readonly number: number;
}

/** A path segment GitHub can actually own: no traversal, no encoding tricks. */
function safeSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= 100 &&
    segment !== "." &&
    segment !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(segment)
  );
}

/**
 * Read a repository out of a provider-supplied API URL without trusting it.
 *
 * The URL is never fetched. It is parsed, required to be exactly the expected
 * HTTPS API origin with no userinfo, port, query or fragment, and reduced to
 * validated segments that this module rebuilds its own paths from.
 */
function repositoryFromApiUrl(value: string): RepositoryRef | null {
  const url = safeUrlParse(value);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.host !== "api.github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== "" ||
    url.pathname.includes("%")
  ) {
    return null;
  }
  const segments = url.pathname.split("/").filter((segment) => {
    return segment.length > 0;
  });
  if (segments.length !== 3 || segments[0] !== "repos") {
    return null;
  }
  const [, owner, repo] = segments;
  return owner !== undefined &&
    repo !== undefined &&
    safeSegment(owner) &&
    safeSegment(repo)
    ? { owner, repo }
    : null;
}

/** The same validation for a notification subject, which also names an item. */
function subjectFromApiUrl(value: string): SubjectRef | null {
  const url = safeUrlParse(value);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.host !== "api.github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== "" ||
    url.pathname.includes("%")
  ) {
    return null;
  }
  const segments = url.pathname.split("/").filter((segment) => {
    return segment.length > 0;
  });
  if (segments.length !== 5 || segments[0] !== "repos") {
    return null;
  }
  const [, owner, repo, collection, rawNumber] = segments;
  if (
    owner === undefined ||
    repo === undefined ||
    rawNumber === undefined ||
    !safeSegment(owner) ||
    !safeSegment(repo) ||
    !/^[1-9][0-9]{0,9}$/.test(rawNumber)
  ) {
    return null;
  }
  const kind: SubjectKind | null =
    collection === "issues"
      ? "issue"
      : collection === "pulls"
        ? "pull-request"
        : null;
  return kind === null
    ? null
    : { owner, repo, kind, number: Number.parseInt(rawNumber, 10) };
}

function repositoryFromFullName(fullName: string): RepositoryRef | null {
  const segments = fullName.split("/");
  if (segments.length !== 2) {
    return null;
  }
  const [owner, repo] = segments;
  return owner !== undefined &&
    repo !== undefined &&
    safeSegment(owner) &&
    safeSegment(repo)
    ? { owner, repo }
    : null;
}

/** A display link rebuilt from validated segments, not the provider's field. */
function displayUrl(ref: SubjectRef): string {
  const collection = ref.kind === "pull-request" ? "pull" : "issues";
  return `https://github.com/${ref.owner}/${ref.repo}/${collection}/${ref.number}`;
}

function itemKey(ref: SubjectRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

function repositoryName(ref: RepositoryRef): string {
  return `${ref.owner}/${ref.repo}`;
}

function boundedText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function isoOrNull(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function itemState(state: string): "open" | "closed" | "unknown" {
  return state === "open" ? "open" : state === "closed" ? "closed" : "unknown";
}

/** Accumulates one branch's coverage as it reads. */
class BranchCoverage {
  private status: MorningBriefGithubBranchCoverage["status"] = "complete";
  private pages = 0;
  private items = 0;
  private readonly limits = new Set<MorningBriefGithubLimit>();

  constructor(
    private readonly window: {
      readonly windowStart?: string;
      readonly windowEnd?: string;
      readonly observedAt?: string;
    },
  ) {}

  page(): void {
    this.pages += 1;
  }

  counted(items: number): void {
    this.items += items;
  }

  limit(limit: MorningBriefGithubLimit): void {
    this.limits.add(limit);
    if (this.status === "complete") {
      this.status = "partial";
    }
  }

  /**
   * The endpoint itself was refused, and the refusal is local to this branch.
   *
   * `policy` is the member's own effective permission and `provider` is
   * GitHub answering `403`. Both are recorded distinctly so the summarization
   * step can tell "you have not granted this" from "GitHub refused this".
   */
  deny(scope: "policy" | "provider"): void {
    this.status = "denied";
    this.limits.add(
      scope === "policy" ? "denied-endpoint" : "provider-forbidden",
    );
  }

  fail(limit: MorningBriefGithubLimit): void {
    this.status = "failed";
    this.limits.add(limit);
  }

  skip(): void {
    this.status = "skipped";
  }

  get denied(): boolean {
    return this.status === "denied";
  }

  get failed(): boolean {
    return this.status === "failed";
  }

  get healthy(): boolean {
    return this.status === "complete";
  }

  /** Nothing to do is not a coverage gap: no relevant work existed. */
  get healthyOrEmpty(): boolean {
    return this.status === "complete" || this.status === "skipped";
  }

  view(): MorningBriefGithubBranchCoverage {
    return {
      status: this.status,
      ...this.window,
      pages: this.pages,
      items: this.items,
      limits: [...this.limits].sort(),
    };
  }
}

/** The mutable item under construction, before it becomes a bundle entry. */
interface DraftItem {
  readonly ref: SubjectRef;
  title: string;
  excerpt?: string;
  state: "open" | "closed" | "unknown";
  draft?: boolean;
  updatedAt: string;
  actor?: string;
  readonly reasons: MorningBriefGithubReason[];
  checks?: MorningBriefGithubCheckSummary;
  /** Branch precedence for the deterministic pull-request selection. */
  reviewRequested: boolean;
  assigned: boolean;
}

/**
 * Turn a read refusal into the branch's own coverage record.
 *
 * Every outcome other than a parsed payload is recorded. A denial, a cap, a
 * malformed body and a rate limit are all distinguishable, and none of them
 * can leave the branch looking complete.
 */
function recordFailure(
  coverage: BranchCoverage,
  result: Exclude<MorningBriefReadOutcome<unknown>, { readonly kind: "ok" }>,
): { readonly retryAfterMs?: number; readonly revoked: boolean } {
  if (result.kind === "denied") {
    // Both scopes are endpoint-local and leave this branch's siblings intact.
    // A provider `403` carrying `Retry-After` is GitHub's secondary rate limit,
    // not a lost credential, so it is recorded as throttling rather than as a
    // permission refusal.
    const retryAfterMs = result.meta.retryAfterMs;
    if (result.scope === "provider" && retryAfterMs !== null) {
      coverage.limit("rate-limited");
      return { retryAfterMs, revoked: false };
    }
    coverage.deny(result.scope);
    return { revoked: false };
  }
  if (result.kind === "not-found") {
    // A deleted or moved item, which is not a permission refusal.
    coverage.limit("missing-item");
    return { revoked: false };
  }
  if (result.kind === "rate-limited") {
    coverage.fail("rate-limited");
    return {
      ...(result.retryAfterMs === null
        ? {}
        : { retryAfterMs: result.retryAfterMs }),
      revoked: false,
    };
  }
  if (result.kind === "budget-exhausted") {
    coverage.limit(
      result.limit === "deadline"
        ? "deadline"
        : result.limit === "total-response-bytes"
          ? "response-bytes"
          : "requests",
    );
    return { revoked: false };
  }
  if (result.kind === "revoked") {
    // The shared reader latched a terminal loss of authority. Nothing this
    // attempt collected may be released.
    coverage.fail("denied-endpoint");
    return { revoked: true };
  }
  coverage.fail(
    result.kind === "too-large" ? "oversized-response" : "malformed-response",
  );
  return { revoked: false };
}

/** The running check tally for one pull request head. */
interface CheckTally {
  failing: number;
  pending: number;
  succeeded: number;
  readonly failingNames: string[];
  incomplete: boolean;
}

/** Count one failing context, keeping only a bounded number of its names. */
function recordFailingName(tally: CheckTally, name: string): void {
  tally.failing += 1;
  if (tally.failingNames.length < MORNING_BRIEF_GITHUB_BUDGET.maxFailingNames) {
    tally.failingNames.push(boundedText(name, 80));
  }
}

/** Run at most `limit` promises at a time, preserving input order. */
async function mapBounded<I, O>(
  inputs: readonly I[],
  limit: number,
  run: (input: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results: O[] = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, inputs.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        const input = inputs[index];
        if (index >= inputs.length || input === undefined) {
          return;
        }
        results[index] = await run(input, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

interface MorningBriefGithubCollectionArgs {
  readonly scope: MorningBriefCollectionScope;
  readonly anchor: Date;
  readonly collectedAt: Date;
  readonly clock: () => number;
}

class GithubPrioritiesCollector {
  private readonly drafts = new Map<string, DraftItem>();
  private readonly limits = new Set<MorningBriefGithubLimit>();
  private readonly notifications: BranchCoverage;
  private readonly assigned: BranchCoverage;
  private readonly reviewRequested: BranchCoverage;
  private readonly checks: BranchCoverage;
  private readonly windowStart: Date;
  private retryAfterMs: number | undefined;
  private rateLimitRemaining: number | undefined;
  private rateLimitResetAt: string | undefined;
  private requests = 0;
  private revoked = false;
  private login: string | null = null;
  private userFailed = false;

  constructor(
    private readonly reader: MorningBriefConnectorReader,
    private readonly args: MorningBriefGithubCollectionArgs,
    private readonly signal: AbortSignal,
  ) {
    this.windowStart = new Date(
      args.anchor.getTime() - MORNING_BRIEF_GITHUB_WINDOW_MS,
    );
    const observedAt = args.collectedAt.toISOString();
    this.notifications = new BranchCoverage({
      windowStart: this.windowStart.toISOString(),
      windowEnd: args.anchor.toISOString(),
    });
    this.assigned = new BranchCoverage({ observedAt });
    this.reviewRequested = new BranchCoverage({ observedAt });
    this.checks = new BranchCoverage({ observedAt });
  }

  private note(outcome: {
    readonly retryAfterMs?: number;
    readonly revoked: boolean;
  }): boolean {
    if (outcome.retryAfterMs !== undefined) {
      this.retryAfterMs = Math.max(
        this.retryAfterMs ?? 0,
        outcome.retryAfterMs,
      );
    }
    this.revoked ||= outcome.revoked;
    return outcome.revoked;
  }

  /**
   * One bounded read through the shared reader, counted for the envelope.
   *
   * The reader owns the host, credential and authorization; this only owns the
   * path and its query, and keeps its own attempt count so the bundle can
   * report what it actually asked for.
   */
  private async read<T>(request: {
    readonly pathname: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly schema: z.ZodType<T>;
  }): Promise<MorningBriefReadOutcome<T>> {
    this.requests += 1;
    return await this.reader.getJson(request);
  }

  /**
   * Retain the provider's bounded rate-limit facts from a successful read.
   *
   * These are validated allowlisted headers the reader already parsed. They
   * are metadata for the summarization step and the next occurrence; nothing
   * here sleeps, retries or reacts to them.
   */
  private observeRateLimit(meta: MorningBriefResponseMetadata): void {
    if (meta.rateLimitRemaining !== null) {
      this.rateLimitRemaining =
        this.rateLimitRemaining === undefined
          ? meta.rateLimitRemaining
          : Math.min(this.rateLimitRemaining, meta.rateLimitRemaining);
    }
    if (meta.rateLimitResetAt !== null) {
      this.rateLimitResetAt = meta.rateLimitResetAt;
    }
  }

  private outOfTime(): boolean {
    return this.signal.aborted || this.revoked;
  }

  /** The exact login of the selected token. Nothing else identifies it. */
  private async resolveLogin(): Promise<void> {
    const result = await this.read({
      pathname: "/user",
      schema: githubUserSchema,
    });
    if (result.kind !== "ok") {
      this.userFailed = true;
      const coverage = new BranchCoverage({});
      this.note(recordFailure(coverage, result));
      for (const limit of coverage.view().limits) {
        this.limits.add(limit);
      }
      if (coverage.denied) {
        this.limits.add("denied-endpoint");
      }
      return;
    }
    this.login = result.value.login;
  }

  private draft(ref: SubjectRef, updatedAt: string): DraftItem {
    const key = itemKey(ref);
    const existing = this.drafts.get(key);
    if (existing) {
      return existing;
    }
    if (this.drafts.size >= MORNING_BRIEF_GITHUB_BUDGET.maxItems) {
      this.limits.add("items");
      const overflow: DraftItem = {
        ref,
        title: "",
        state: "unknown",
        updatedAt,
        reasons: [],
        reviewRequested: false,
        assigned: false,
      };
      return overflow;
    }
    const created: DraftItem = {
      ref,
      title: "",
      state: "unknown",
      updatedAt,
      reasons: [],
      reviewRequested: false,
      assigned: false,
    };
    this.drafts.set(key, created);
    return created;
  }

  /**
   * Notifications inside the exact half-open window.
   *
   * `since` and `before` are second-resolution provider filters, so the
   * response is filtered again against `[anchor - 24h, anchor)`: a
   * notification updated exactly at the anchor belongs to the next occurrence,
   * and one updated exactly at the window start belongs to this one.
   */
  private async collectNotifications(): Promise<void> {
    for (
      let page = 1;
      page <= MORNING_BRIEF_GITHUB_BUDGET.notificationPages;
      page += 1
    ) {
      if (this.outOfTime()) {
        this.notifications.limit("deadline");
        return;
      }
      const result = await this.read({
        pathname: "/notifications",
        query: {
          all: "true",
          since: this.windowStart.toISOString(),
          before: this.args.anchor.toISOString(),
          per_page: String(MORNING_BRIEF_GITHUB_BUDGET.notificationPerPage),
          page: String(page),
        },
        schema: notificationsSchema,
      });
      if (result.kind !== "ok") {
        if (this.note(recordFailure(this.notifications, result))) {
          return;
        }
        return;
      }
      this.notifications.page();
      let accepted = 0;
      for (const notification of result.value) {
        const updatedAt = isoOrNull(notification.updated_at);
        if (updatedAt === null) {
          this.notifications.limit("malformed-response");
          continue;
        }
        const updatedMs = new Date(updatedAt).getTime();
        if (
          updatedMs < this.windowStart.getTime() ||
          updatedMs >= this.args.anchor.getTime()
        ) {
          continue;
        }
        const subjectUrl = notification.subject.url;
        const ref =
          typeof subjectUrl === "string" ? subjectFromApiUrl(subjectUrl) : null;
        if (ref === null) {
          // Discussions, releases, commits and check suites are real
          // notifications this slice cannot normalize. Recorded, not dropped.
          this.notifications.limit("unsupported-subject");
          if (typeof subjectUrl === "string") {
            this.limits.add("unsafe-link");
          }
          continue;
        }
        const repository = repositoryFromFullName(
          notification.repository.full_name,
        );
        if (
          repository === null ||
          repository.owner !== ref.owner ||
          repository.repo !== ref.repo
        ) {
          this.notifications.limit("malformed-response");
          continue;
        }
        const draft = this.draft(ref, updatedAt);
        draft.title ||= boundedText(notification.subject.title, 200);
        if (new Date(draft.updatedAt).getTime() < updatedMs) {
          draft.updatedAt = updatedAt;
        }
        draft.reasons.push({
          branch: "notification",
          notificationReason: boundedText(notification.reason, 50),
          unread: notification.unread,
        });
        accepted += 1;
      }
      this.notifications.counted(accepted);
      this.observeRateLimit(result.meta);
      // The reader validates GitHub's own `Link` header down to the existence
      // of a next page and its bounded page number. No URL is followed; the
      // next request is still this loop's own constructed path.
      if (!result.meta.hasNextPage) {
        return;
      }
      if (page === MORNING_BRIEF_GITHUB_BUDGET.notificationPages) {
        // A next page this budget will not read is a coverage gap, never a
        // complete read.
        this.notifications.limit("notification-pages");
        this.notifications.limit("unread-pages");
      }
    }
  }

  /**
   * Normalize one bounded search page into merged drafts.
   *
   * Extracted from the page loop so both stay inside the repository's
   * complexity limit; the normalization itself is unchanged.
   */
  private acceptSearchItems(
    coverage: BranchCoverage,
    items: readonly z.infer<typeof searchItemSchema>[],
    branch: "assigned" | "review-requested",
  ): number {
    let accepted = 0;
    for (const item of items) {
      const repository = repositoryFromApiUrl(item.repository_url);
      const updatedAt = isoOrNull(item.updated_at);
      if (repository === null || updatedAt === null || item.number <= 0) {
        coverage.limit("malformed-response");
        continue;
      }
      const kind: SubjectKind =
        item.pull_request === null || item.pull_request === undefined
          ? "issue"
          : "pull-request";
      const ref: SubjectRef = { ...repository, kind, number: item.number };
      const draft = this.draft(ref, updatedAt);
      draft.title = boundedText(item.title, 200);
      draft.state = itemState(item.state);
      if (typeof item.draft === "boolean") {
        draft.draft = item.draft;
      }
      if (item.user) {
        draft.actor = boundedText(item.user.login, 50);
      }
      if (typeof item.body === "string" && item.body.length > 0) {
        draft.excerpt = boundedText(
          item.body,
          MORNING_BRIEF_GITHUB_BUDGET.maxExcerptCharacters,
        );
      }
      if (new Date(draft.updatedAt).getTime() < new Date(updatedAt).getTime()) {
        draft.updatedAt = updatedAt;
      }
      draft.reasons.push({ branch });
      if (branch === "review-requested") {
        draft.reviewRequested = true;
      } else {
        draft.assigned = true;
      }
      accepted += 1;
    }
    return accepted;
  }

  /**
   * One outstanding-work search branch.
   *
   * These are read-time snapshots of currently open work with no lower time
   * bound, which is the point: an assignment nobody touched yesterday is still
   * a priority today. They are not a reconstruction of open state at the
   * anchor, and they do not share a snapshot with the notification branch.
   */
  private async collectSearch(
    coverage: BranchCoverage,
    query: string,
    branch: "assigned" | "review-requested",
  ): Promise<void> {
    for (
      let page = 1;
      page <= MORNING_BRIEF_GITHUB_BUDGET.searchPages;
      page += 1
    ) {
      if (this.outOfTime()) {
        coverage.limit("deadline");
        return;
      }
      const result = await this.read({
        pathname: "/search/issues",
        query: {
          q: query,
          sort: "updated",
          order: "desc",
          per_page: String(MORNING_BRIEF_GITHUB_BUDGET.searchPerPage),
          page: String(page),
          advanced_search: "true",
        },
        schema: searchResultSchema,
      });
      if (result.kind !== "ok") {
        this.note(recordFailure(coverage, result));
        return;
      }
      coverage.page();
      if (result.value.incomplete_results) {
        coverage.limit("search-incomplete");
      }
      const accepted = this.acceptSearchItems(
        coverage,
        result.value.items,
        branch,
      );
      coverage.counted(accepted);
      this.observeRateLimit(result.meta);
      const readSoFar = page * MORNING_BRIEF_GITHUB_BUDGET.searchPerPage;
      if (!result.meta.hasNextPage) {
        // Search reports its own total independently of `Link`, so an
        // unconsumed remainder is still a gap even without a next page.
        if (result.value.total_count > readSoFar) {
          coverage.limit("search-total-exceeded");
        }
        return;
      }
      if (page === MORNING_BRIEF_GITHUB_BUDGET.searchPages) {
        coverage.limit("search-pages");
        coverage.limit("unread-pages");
        if (result.value.total_count > readSoFar) {
          coverage.limit("search-total-exceeded");
        }
      }
    }
  }

  /**
   * The deterministic pull requests whose checks are worth a look.
   *
   * Review requests come first because a failing check is what usually blocks
   * them, then the member's own assigned pull requests, then anything a
   * notification surfaced. Ties break on recency and then stable identity, so
   * the same bundle picks the same five every time.
   */
  private relevantPullRequests(): readonly DraftItem[] {
    const candidates = [...this.drafts.values()].filter((draft) => {
      return draft.ref.kind === "pull-request" && draft.state !== "closed";
    });
    candidates.sort((left, right) => {
      const rank = (draft: DraftItem): number => {
        return draft.reviewRequested ? 0 : draft.assigned ? 1 : 2;
      };
      return (
        rank(left) - rank(right) ||
        new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime() ||
        itemKey(left.ref).localeCompare(itemKey(right.ref))
      );
    });
    const selected = candidates.slice(
      0,
      MORNING_BRIEF_GITHUB_BUDGET.relevantPullRequests,
    );
    if (candidates.length > selected.length) {
      this.checks.limit("relevant-pull-requests");
    }
    return selected;
  }

  /** Fold one bounded check-runs page into the running tally. */
  private tallyCheckRuns(
    tally: CheckTally,
    page: z.infer<typeof checkRunsSchema>,
  ): void {
    this.checks.page();
    for (const run of page.check_runs) {
      if (run.status !== "completed") {
        tally.pending += 1;
        continue;
      }
      if (
        run.conclusion === "success" ||
        run.conclusion === "neutral" ||
        run.conclusion === "skipped"
      ) {
        tally.succeeded += 1;
        continue;
      }
      recordFailingName(tally, run.name);
    }
    if (page.total_count > page.check_runs.length) {
      tally.incomplete = true;
      this.checks.limit("check-runs");
    }
  }

  /** Fold one bounded combined-status page into the running tally. */
  private tallyCommitStatus(
    tally: CheckTally,
    page: z.infer<typeof commitStatusSchema>,
  ): void {
    this.checks.page();
    for (const context of page.statuses) {
      if (context.state === "pending") {
        tally.pending += 1;
        continue;
      }
      if (context.state === "success") {
        tally.succeeded += 1;
        continue;
      }
      recordFailingName(tally, context.context);
    }
    if (page.total_count > page.statuses.length) {
      tally.incomplete = true;
      this.checks.limit("commit-status");
    }
  }

  /** Detail, check runs and combined status for one pull request head. */
  private async collectChecks(draft: DraftItem): Promise<void> {
    if (this.outOfTime()) {
      this.checks.limit("deadline");
      return;
    }
    const repoPath = `/repos/${draft.ref.owner}/${draft.ref.repo}`;
    const detail = await this.read({
      pathname: `${repoPath}/pulls/${draft.ref.number}`,
      schema: pullDetailSchema,
    });
    if (detail.kind !== "ok") {
      this.note(recordFailure(this.checks, detail));
      this.checks.limit("pull-request-detail");
      return;
    }
    this.checks.page();
    draft.state = itemState(detail.value.state);
    if (typeof detail.value.draft === "boolean") {
      draft.draft = detail.value.draft;
    }
    const headSha = detail.value.head.sha;
    const tally: CheckTally = {
      failing: 0,
      pending: 0,
      succeeded: 0,
      failingNames: [],
      incomplete: false,
    };

    const runs = await this.read({
      pathname: `${repoPath}/commits/${headSha}/check-runs`,
      query: {
        per_page: String(MORNING_BRIEF_GITHUB_BUDGET.checkRunsPerPage),
        page: "1",
      },
      schema: checkRunsSchema,
    });
    if (runs.kind === "ok") {
      this.tallyCheckRuns(tally, runs.value);
    } else {
      tally.incomplete = true;
      this.checks.limit("check-runs");
      if (this.note(recordFailure(this.checks, runs))) {
        return;
      }
    }

    const status = await this.read({
      pathname: `${repoPath}/commits/${headSha}/status`,
      query: { per_page: String(MORNING_BRIEF_GITHUB_BUDGET.checkRunsPerPage) },
      schema: commitStatusSchema,
    });
    if (status.kind === "ok") {
      this.tallyCommitStatus(tally, status.value);
    } else {
      tally.incomplete = true;
      this.checks.limit("commit-status");
      this.note(recordFailure(this.checks, status));
    }

    const { failing, pending, succeeded, failingNames, incomplete } = tally;
    // An unread check surface is `unknown`, never `success`. Only a complete
    // read with nothing failing or pending may report green, and this is still
    // observed check state rather than branch-protection satisfaction.
    const state: MorningBriefGithubCheckSummary["state"] =
      failing > 0
        ? "failing"
        : pending > 0
          ? "pending"
          : incomplete || succeeded === 0
            ? "unknown"
            : "success";
    draft.checks = {
      headSha,
      state,
      failing,
      pending,
      succeeded,
      failingNames,
      incomplete,
    };
  }

  private outcome(itemCount: number): MorningBriefGithubOutcome {
    if (this.signal.aborted || this.revoked) {
      return "cancelled";
    }
    const branches = [this.notifications, this.assigned, this.reviewRequested];
    if (
      this.userFailed ||
      branches.every((branch) => {
        return branch.denied || branch.failed;
      })
    ) {
      if (this.retryAfterMs !== undefined) {
        return "rate_limited";
      }
      if (
        branches.every((branch) => {
          return branch.denied;
        })
      ) {
        return "permission_denied";
      }
      return "provider_failed";
    }
    const complete =
      branches.every((branch) => {
        return branch.healthy;
      }) && this.checks.healthyOrEmpty;
    if (!complete) {
      return "partial";
    }
    return itemCount === 0 ? "empty" : "complete";
  }

  private items(): MorningBriefGithubItem[] {
    const ordered = [...this.drafts.values()]
      .filter((draft) => {
        return draft.reasons.length > 0;
      })
      .sort((left, right) => {
        return (
          new Date(right.updatedAt).getTime() -
            new Date(left.updatedAt).getTime() ||
          itemKey(left.ref).localeCompare(itemKey(right.ref))
        );
      });
    const items: MorningBriefGithubItem[] = [];
    let characters = 0;
    for (const draft of ordered) {
      const title = draft.title.length > 0 ? draft.title : itemKey(draft.ref);
      const cost = title.length + (draft.excerpt?.length ?? 0);
      if (characters + cost > MORNING_BRIEF_GITHUB_BUDGET.maxTextCharacters) {
        this.limits.add("text-characters");
        break;
      }
      characters += cost;
      items.push({
        repository: repositoryName(draft.ref),
        number: draft.ref.number,
        kind: draft.ref.kind,
        title,
        ...(draft.excerpt === undefined ? {} : { excerpt: draft.excerpt }),
        state: draft.state,
        ...(draft.draft === undefined ? {} : { draft: draft.draft }),
        updatedAt: draft.updatedAt,
        ...(draft.actor === undefined ? {} : { actor: draft.actor }),
        reasons: draft.reasons,
        url: displayUrl(draft.ref),
        ...(draft.checks === undefined ? {} : { checks: draft.checks }),
      });
    }
    return items;
  }

  async collect(): Promise<MorningBriefGithubBundle> {
    await this.resolveLogin();
    if (this.login !== null && !this.outOfTime()) {
      await this.collectNotifications();
      if (!this.outOfTime()) {
        await this.collectSearch(
          this.assigned,
          `is:open assignee:${this.login}`,
          "assigned",
        );
      } else {
        this.assigned.skip();
      }
      if (!this.outOfTime()) {
        await this.collectSearch(
          this.reviewRequested,
          `is:open is:pr review-requested:${this.login}`,
          "review-requested",
        );
      } else {
        this.reviewRequested.skip();
      }
      const pulls = this.relevantPullRequests();
      if (pulls.length === 0) {
        this.checks.skip();
      } else {
        await mapBounded(
          pulls,
          MORNING_BRIEF_GITHUB_BUDGET.concurrency,
          async (draft) => {
            await this.collectChecks(draft);
          },
        );
      }
    } else {
      this.notifications.skip();
      this.assigned.skip();
      this.reviewRequested.skip();
      this.checks.skip();
    }

    const items = this.items();
    const outcome = this.outcome(items.length);
    const branches = {
      notifications: this.notifications.view(),
      assigned: this.assigned.view(),
      reviewRequested: this.reviewRequested.view(),
      checks: this.checks.view(),
    };
    for (const branch of Object.values(branches)) {
      for (const limit of branch.limits) {
        this.limits.add(limit);
      }
    }
    const textCharacters = items.reduce((total, item) => {
      return total + item.title.length + (item.excerpt?.length ?? 0);
    }, 0);
    return {
      source: "github",
      login: this.login ?? "",
      anchor: this.args.anchor.toISOString(),
      collectedAt: this.args.collectedAt.toISOString(),
      observedAt: new Date(this.args.clock()).toISOString(),
      timezone: this.args.scope.timezone,
      coverage:
        outcome === "complete" || outcome === "empty" ? "complete" : "partial",
      outcome,
      branches,
      limits: [...this.limits].sort(),
      items,
      counts: {
        items: items.length,
        requests: this.requests,
        textCharacters,
      },
      ...(this.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: this.retryAfterMs }),
      ...(this.rateLimitRemaining === undefined
        ? {}
        : { rateLimitRemaining: this.rateLimitRemaining }),
      ...(this.rateLimitResetAt === undefined
        ? {}
        : { rateLimitResetAt: this.rateLimitResetAt }),
    };
  }
}

/**
 * Collect one bounded GitHub priorities bundle through an authorized reader.
 *
 * The reader owns authorization and the request budget; this owns the GitHub
 * semantics. The returned bundle only becomes the caller's result if the
 * reader's release gate still agrees the owner's authority is unchanged.
 */
async function collectMorningBriefGithubPriorities(
  reader: MorningBriefConnectorReader,
  args: MorningBriefGithubCollectionArgs,
  signal: AbortSignal,
): Promise<MorningBriefGithubBundle> {
  return await new GithubPrioritiesCollector(reader, args, signal).collect();
}

/** Anchors may not run ahead of this instance's clock by more than a minute. */
const MAX_ANCHOR_SKEW_MS = 60_000;

/** The oldest anchor this preview accepts. */
const MAX_ANCHOR_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type MorningBriefGithubExecution =
  | { readonly kind: "invalid-anchor"; readonly message: string }
  | {
      readonly kind: "not-executed";
      readonly reason: MorningBriefGithubSkipReason;
    }
  | {
      readonly kind: "collected";
      readonly bundle: MorningBriefGithubBundle;
    };

function validateAnchor(
  anchor: Date,
  at: Date,
): { readonly kind: "invalid-anchor"; readonly message: string } | null {
  if (Number.isNaN(anchor.getTime())) {
    return {
      kind: "invalid-anchor",
      message: "scheduledFor is not an instant.",
    };
  }
  const offset = anchor.getTime() - at.getTime();
  if (offset > MAX_ANCHOR_SKEW_MS) {
    return {
      kind: "invalid-anchor",
      message: "scheduledFor must not be a future instant.",
    };
  }
  if (-offset > MAX_ANCHOR_AGE_MS) {
    return {
      kind: "invalid-anchor",
      message: "scheduledFor is older than the supported collection window.",
    };
  }
  return null;
}

/**
 * Run one explicitly authorized GitHub priorities collection.
 *
 * Admission and the authorization boundary belong to the shared reader owned
 * by [#34809](https://github.com/vm0-ai/okou/issues/34809); this only supplies
 * the GitHub path vocabulary and its budget. The bundle exists in memory only
 * and is released only when that reader's own fence still agrees the admitted
 * authority is current.
 */
export async function executeMorningBriefGithubCollection(
  args: {
    readonly db: Db;
    readonly clerk: ClerkClient;
    readonly owner: { readonly orgId: string; readonly userId: string };
    readonly anchor: Date;
  },
  signal: AbortSignal,
): Promise<MorningBriefGithubExecution> {
  const startedAt = nowDate();
  const invalid = validateAnchor(args.anchor, startedAt);
  if (invalid) {
    return invalid;
  }

  const admitted = await admitMorningBriefCollection(
    {
      db: args.db,
      clerk: args.clerk,
      orgId: args.owner.orgId,
      userId: args.owner.userId,
      anchor: args.anchor,
    },
    signal,
  );
  signal.throwIfAborted();
  if (admitted.kind !== "ok") {
    return { kind: "not-executed", reason: admitted.reason };
  }

  // The shared reader owns the absolute deadline for the whole source, so this
  // passes the caller's signal and lets the wrapper bound it.
  const access = await withMorningBriefConnectorReader(
    {
      scope: admitted.scope,
      connectorSlug: GITHUB_CONNECTOR_SLUG,
      apiBase: GITHUB_API_BASE,
      environmentName: GITHUB_ACCESS_TOKEN_ENVIRONMENT_NAME,
      budget: {
        maxRequests: MORNING_BRIEF_GITHUB_BUDGET.maxRequests,
        maxResponseBytes: MORNING_BRIEF_GITHUB_BUDGET.maxResponseBytes,
        maxTotalResponseBytes:
          MORNING_BRIEF_GITHUB_BUDGET.maxTotalResponseBytes,
        deadlineMs: MORNING_BRIEF_GITHUB_BUDGET.deadlineMs,
      },
      db: args.db,
      clerk: args.clerk,
    },
    async (reader) => {
      return await collectMorningBriefGithubPriorities(
        reader,
        {
          scope: admitted.scope,
          anchor: args.anchor,
          collectedAt: startedAt,
          clock: () => {
            return nowDate().getTime();
          },
        },
        signal,
      );
    },
    signal,
  );
  if (access.kind === "unavailable") {
    // Terminal loss of a whole source. Nothing collected under it is released.
    return { kind: "not-executed", reason: access.reason };
  }
  return { kind: "collected", bundle: access.value };
}
