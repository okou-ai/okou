import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import {
  morningBriefGithubCollectionContract,
  type MorningBriefGithubBundle,
} from "@okouai/api-contracts/contracts/morning-brief-github-collection";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { getApiTestMocks } from "../../../__tests__/mocks";
import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  pauseMorningBriefAutomation,
  readMemberConnectorAccounts,
  seedInstalledMorningBrief,
  seedMorningBriefAgent,
  seedMorningBriefThread,
  selectMorningBriefConnectorAccount,
  revokeMorningBriefMembership,
} from "../../../test-fixtures/morning-brief-github-collection";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { createDeferredPromise } from "../../utils";
import { morningBriefPreviewGithubCollectionRoutes } from "../morning-brief-preview-github-collection";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const connectorApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);

const GITHUB_USER = "https://api.github.com/user";
const GITHUB_NOTIFICATIONS = "https://api.github.com/notifications";
const GITHUB_SEARCH = "https://api.github.com/search/issues";
const GITHUB_PULLS = "https://api.github.com/repos/:owner/:repo/pulls/:number";
const GITHUB_CHECK_RUNS =
  "https://api.github.com/repos/:owner/:repo/commits/:ref/check-runs";
const GITHUB_STATUS =
  "https://api.github.com/repos/:owner/:repo/commits/:ref/status";

/** A second-aligned anchor an hour behind this run, so the window is stable. */
const ANCHOR_MS = Math.floor((now() - 60 * 60 * 1000) / 1000) * 1000;
const ANCHOR = new Date(ANCHOR_MS).toISOString();
const WINDOW_START_MS = ANCHOR_MS - 24 * 60 * 60 * 1000;
/** The first instant inside the window, and two instants outside it. */
const AT_WINDOW_START = new Date(WINDOW_START_MS).toISOString();
const BEFORE_WINDOW = new Date(WINDOW_START_MS - 1000).toISOString();
const AT_ANCHOR = new Date(ANCHOR_MS).toISOString();
const MID_WINDOW = new Date(WINDOW_START_MS + 60_000).toISOString();

const LOGIN = "brief-owner";
const HEAD_SHA = "a".repeat(40);

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly headers: { readonly authorization: string };
}

/**
 * The exact slice the production route table registers.
 *
 * `route-registration.test.ts` owns the assertion that this slice is in
 * `ROUTES` — the typecheck boundary allows only that file and the production
 * bootstrap to import the aggregation module — so between the two a preview
 * that exists only inside its own suite cannot pass.
 */
function collectionClient() {
  return setupApp({
    context,
    routes: morningBriefPreviewGithubCollectionRoutes,
  })(morningBriefGithubCollectionContract);
}

function agentToken(
  userId: string,
  orgId: string,
  capabilities: readonly Capability[] = ["github:read"],
): { readonly authorization: string } {
  const seconds = Math.floor(now() / 1000);
  return {
    authorization: `Bearer ${signSandboxJwtForTests({
      scope: "okou",
      userId,
      orgId,
      runId: randomUUID(),
      capabilities,
      iat: seconds,
      exp: seconds + 3600,
    })}`,
  };
}

/**
 * Keep the caller authenticated at the Clerk boundary.
 *
 * Request authentication falls back to Clerk when the durable member row is
 * missing, so this keeps the *token* valid. Collection admission reads the
 * durable `org_members_cache` row instead, which is what
 * `revokeMorningBriefMembership` removes: an authenticated caller whose
 * organization membership is gone.
 */
function mockClerkMembership(orgId: string, userId: string): void {
  const mocks = getApiTestMocks();
  const membership = {
    id: `orgmem_${userId}`,
    organization: { id: orgId },
    role: "org:admin",
    createdAt: 1,
    publicUserData: { userId },
  };
  mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue({
    data: [membership],
  });
  mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [membership],
  });
}

/** A stable, distinct GitHub external identity per connected account. */
function githubExternalUserId(code: string): number {
  return (
    1000 +
    [...code].reduce((total, character) => {
      return total + (character.codePointAt(0) ?? 0);
    }, 0)
  );
}

function state(start: { readonly authorizationUrl: string }): string {
  const value = new URL(start.authorizationUrl).searchParams.get("state");
  if (!value) {
    throw new Error("Expected OAuth state");
  }
  return value;
}

/**
 * Connect one real GitHub account through the ordinary OAuth routes.
 *
 * `authorizeAgent` is what writes the Agent's connector grant, and the mocked
 * token endpoint returns `github-access-<code>`, so each account ends up with
 * a distinguishable bearer token. That is how a later test proves which
 * account's token actually reached GitHub.
 */
async function connectGithubAccount(
  actor: ApiTestUser,
  code: string,
  agentId: string,
  login = LOGIN,
): Promise<void> {
  // A distinct external identity per account; reusing one updates the first
  // account in place instead of adding a second.
  mockGitHubConnectorOAuth({ userId: githubExternalUserId(code), login });
  const start = await connectorApi.startOauth(
    actor,
    "github",
    "oauth",
    agentId,
  );
  const completed = await connectorApi.completeOauthCallbackResult("github", {
    code,
    state: state(start),
  });
  expect(completed.body.status).toBe("success");
}

async function fixture(
  options: {
    readonly feature?: boolean;
    readonly enabled?: boolean;
    readonly timezone?: string | null;
    readonly capabilities?: readonly Capability[];
    /** `granted` connects the brief's Agent; `other-agent` grants elsewhere. */
    readonly account?: "granted" | "other-agent" | "none";
  } = {},
): Promise<Fixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const actor = bdd.user({ userId, orgId, orgRole: "org:admin" });
  const brief = await seedInstalledMorningBrief({
    orgId,
    userId,
    timezone: options.timezone,
    enabled: options.enabled,
  });
  const account = options.account ?? "granted";
  if (account !== "none") {
    // `other-agent` grants the connector to a different Agent in the same
    // organization, so the account exists but the Agent the canonical
    // installation pinned holds no grant for it.
    const grantedAgentId =
      account === "granted"
        ? brief.agentId
        : await seedMorningBriefAgent({ orgId, userId });
    await connectGithubAccount(actor, "primary", grantedAgentId);
  }
  await updateFeatureSwitchesForUser(
    context,
    { orgId, userId },
    { [FeatureSwitchKey.SimpleMorningBrief]: options.feature !== false },
  );
  mockClerkMembership(orgId, userId);
  return {
    orgId,
    userId,
    agentId: brief.agentId,
    workflowId: brief.workflowId,
    automationId: brief.automationId,
    headers: agentToken(userId, orgId, options.capabilities),
  };
}

function collect(f: Pick<Fixture, "headers">, scheduledFor = ANCHOR) {
  return collectionClient().collect({
    headers: f.headers,
    body: { scheduledFor },
  });
}

/** Assert a collected result and hand back the bundle for inspection. */
function collectedBundle(body: unknown): MorningBriefGithubBundle {
  const result =
    morningBriefGithubCollectionContract.collect.responses[200].safeParse(body);
  if (!result.success || result.data.result !== "collected") {
    throw new Error(`Expected a collected bundle, got ${JSON.stringify(body)}`);
  }
  return result.data.bundle;
}

interface GithubTraffic {
  readonly requests: { method: string; url: string; token: string | null }[];
  readonly queries: URLSearchParams[];
}

/** A scripted reply: either a JSON payload or an explicit HTTP response. */
type ReplyBody = Record<string, unknown> | unknown[];
type Reply = (query: URLSearchParams) => ReplyBody | Response;

/** Script the fixed GitHub reads and record exactly what was asked for. */
function scriptGithub(script: {
  readonly user?: Reply;
  readonly notifications?: Reply;
  readonly search?: Reply;
  readonly pull?: Reply;
  readonly checkRuns?: Reply;
  readonly status?: Reply;
}): GithubTraffic {
  const traffic: GithubTraffic = { requests: [], queries: [] };
  const record = (reply: Reply | undefined, fallback: ReplyBody) => {
    return ({ request }: { request: Request }) => {
      const url = new URL(request.url);
      traffic.requests.push({
        method: request.method,
        url: `${url.origin}${url.pathname}`,
        token: request.headers.get("authorization"),
      });
      traffic.queries.push(url.searchParams);
      const result = reply?.(url.searchParams) ?? fallback;
      return result instanceof Response ? result : HttpResponse.json(result);
    };
  };
  server.use(
    http.get(GITHUB_USER, record(script.user, { login: LOGIN })),
    http.get(GITHUB_NOTIFICATIONS, record(script.notifications, [])),
    http.get(GITHUB_SEARCH, record(script.search, emptySearch())),
    http.get(GITHUB_PULLS, record(script.pull, pullDetail())),
    http.get(GITHUB_CHECK_RUNS, record(script.checkRuns, noCheckRuns())),
    http.get(GITHUB_STATUS, record(script.status, noStatuses())),
  );
  return traffic;
}

function notification(options: {
  readonly repo: string;
  readonly number: number;
  readonly updatedAt: string;
  readonly collection?: "issues" | "pulls";
  readonly reason?: string;
  readonly unread?: boolean;
  readonly subjectUrl?: string;
  readonly type?: string;
}) {
  const collection = options.collection ?? "pulls";
  return {
    id: `${options.repo}-${options.number}`,
    reason: options.reason ?? "review_requested",
    unread: options.unread ?? true,
    updated_at: options.updatedAt,
    subject: {
      title: `subject ${options.number}`,
      type: options.type ?? "PullRequest",
      url:
        options.subjectUrl ??
        `https://api.github.com/repos/${options.repo}/${collection}/${options.number}`,
    },
    repository: { full_name: options.repo },
  };
}

function searchItem(options: {
  readonly repo: string;
  readonly number: number;
  readonly updatedAt: string;
  readonly isPullRequest?: boolean;
  readonly title?: string;
}) {
  return {
    number: options.number,
    title: options.title ?? `item ${options.number}`,
    state: "open",
    updated_at: options.updatedAt,
    repository_url: `https://api.github.com/repos/${options.repo}`,
    body: "body text",
    user: { login: "someone-else" },
    ...(options.isPullRequest === false
      ? {}
      : { pull_request: { url: "ignored" }, draft: false }),
  };
}

function searchPage(items: readonly unknown[], totalCount = items.length) {
  return {
    total_count: totalCount,
    incomplete_results: false,
    items: [...items],
  };
}

function emptySearch() {
  return searchPage([]);
}

function pullDetail(headSha = HEAD_SHA) {
  return {
    number: 1,
    state: "open",
    draft: false,
    updated_at: MID_WINDOW,
    head: { sha: headSha },
  };
}

function noCheckRuns() {
  return { total_count: 0, check_runs: [] };
}

function noStatuses() {
  return { state: "pending", total_count: 0, statuses: [] };
}

/** One bounded check-runs page, reporting its own size unless told otherwise. */
function checkRunsPage(
  runs: readonly Record<string, unknown>[],
  totalCount = runs.length,
) {
  return { total_count: totalCount, check_runs: [...runs] };
}

/** One bounded combined-status page, with the same total-count convention. */
function statusPage(
  statuses: readonly Record<string, unknown>[],
  totalCount = statuses.length,
) {
  return { state: "success", total_count: totalCount, statuses: [...statuses] };
}

/** Exactly one review-requested pull request, so one head reaches the checks. */
function reviewRequestedPull(number: number): Reply {
  return searchByBranch({
    reviewRequested: searchPage([
      searchItem({ repo: "acme/api", number, updatedAt: MID_WINDOW }),
    ]),
  });
}

/** Route the assigned and review-requested branches to different pages. */
function searchByBranch(script: {
  readonly assigned?: ReplyBody;
  readonly reviewRequested?: ReplyBody;
}): Reply {
  return (query) => {
    const q = query.get("q") ?? "";
    return q.includes("review-requested:")
      ? (script.reviewRequested ?? emptySearch())
      : (script.assigned ?? emptySearch());
  };
}

/** GitHub's own `rel="next"` `Link` header for a bounded page number. */
function nextPageLink(page: number): Record<string, string> {
  return {
    link: `<https://api.github.com/resource?page=${page}>; rel="next"`,
  };
}

/**
 * Two assigned search pages, the first advertising a next page.
 *
 * The review-requested branch stays empty so each assertion is about the one
 * branch under test.
 */
function assignedPages(script: {
  readonly one: readonly unknown[];
  readonly two: readonly unknown[];
  readonly totalCount: number;
}): Reply {
  return (query) => {
    if ((query.get("q") ?? "").includes("review-requested:")) {
      return emptySearch();
    }
    return Number(query.get("page") ?? "1") === 1
      ? HttpResponse.json(searchPage(script.one, script.totalCount), {
          headers: nextPageLink(2),
        })
      : searchPage(script.two, script.totalCount);
  };
}

/** The recorded requests whose path ends with `suffix`, with their queries. */
function requestsEnding(
  traffic: GithubTraffic,
  suffix: string,
): { readonly url: string; readonly query: URLSearchParams | undefined }[] {
  return traffic.requests
    .map((entry, index) => {
      return { url: entry.url, query: traffic.queries[index] };
    })
    .filter((entry) => {
      return entry.url.endsWith(suffix);
    });
}

/**
 * The documented model-visible text projection of one emitted item.
 *
 * The test computes it from the response body so the assertion is about the
 * bundle the caller actually received, not about an internal counter.
 */
function projectedTextCharacters(bundle: MorningBriefGithubBundle): number {
  return bundle.items.reduce((total, item) => {
    const reasons = item.reasons.reduce((sum, reason) => {
      return sum + (reason.notificationReason?.length ?? 0);
    }, 0);
    const checks =
      item.checks === undefined
        ? 0
        : item.checks.headSha.length +
          item.checks.failingNames.reduce((sum, name) => {
            return sum + name.length;
          }, 0);
    return (
      total +
      item.repository.length +
      item.title.length +
      (item.excerpt?.length ?? 0) +
      (item.actor?.length ?? 0) +
      (item.url?.length ?? 0) +
      reasons +
      checks
    );
  }, 0);
}

/** Issue notifications, which never pull the check branch into the read. */
function issueNotifications(count: number, from = 1): unknown[] {
  return Array.from({ length: count }, (_unused, index) => {
    return notification({
      repo: "acme/api",
      number: from + index,
      updatedAt: MID_WINDOW,
      collection: "issues",
      type: "Issue",
    });
  });
}

/** A repository name of an exact total length, within GitHub's segment rules. */
function repositoryOfLength(total: number): string {
  const owner = Math.floor((total - 1) / 2);
  return `${"o".repeat(owner)}/${"r".repeat(total - 1 - owner)}`;
}

/**
 * Assigned issues whose retained text costs exactly `cost` characters each.
 *
 * `repository`, `title`, `actor` and the rebuilt display link are all fixed, so
 * the excerpt absorbs the remainder. Numbers stay two digits to keep the link
 * length constant.
 */
function sizedAssignedIssues(cost: number): unknown[] {
  const repository = repositoryOfLength(100);
  const title = "t".repeat(200);
  const actor = "a".repeat(50);
  // `https://github.com/` + repository + `/issues/` + a two-digit number.
  const url = 19 + repository.length + 8 + 2;
  const excerpt = cost - repository.length - title.length - actor.length - url;
  return Array.from({ length: 50 }, (_unused, index) => {
    return {
      ...searchItem({
        repo: repository,
        number: 10 + index,
        updatedAt: MID_WINDOW,
        isPullRequest: false,
        title,
      }),
      body: "b".repeat(excerpt),
      user: { login: actor },
    };
  });
}

describe("Morning Brief GitHub collection preview", () => {
  it("answers 404 in production before authentication, even with the feature on", async () => {
    mockEnv("ENV", "production");
    const traffic = scriptGithub({});

    const response = await collectionClient().collect({
      headers: { authorization: "Bearer not-even-parsed" },
      body: { scheduledFor: ANCHOR },
    });

    expect(response.status).toBe(404);
    expect(traffic.requests).toHaveLength(0);
  });

  it("requires the GitHub read capability", async () => {
    const f = await fixture({ capabilities: ["chat-thread:read"] });
    const traffic = scriptGithub({});

    const response = await collect(f);

    expect(response.status).toBe(403);
    expect(traffic.requests).toHaveLength(0);
  });

  it("does not read GitHub when the implementation switch is off", async () => {
    const f = await fixture({ feature: false });
    const traffic = scriptGithub({});

    const response = await collect(f);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      result: "not-executed",
      reason: "feature-disabled",
    });
    expect(traffic.requests).toHaveLength(0);
  });

  it("does not read GitHub when the canonical brief is paused", async () => {
    const f = await fixture();
    await pauseMorningBriefAutomation(f.automationId);
    const traffic = scriptGithub({});

    const response = await collect(f);

    expect(response.body).toMatchObject({
      result: "not-executed",
      reason: "disabled",
    });
    expect(traffic.requests).toHaveLength(0);
  });

  it("does not read GitHub once the member is removed from the organization", async () => {
    const f = await fixture();
    // The durable member row is an evictable projection that authentication
    // refills from Clerk, so a real removal has to be gone from both.
    getApiTestMocks().clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    getApiTestMocks().clerk.users.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    await revokeMorningBriefMembership({ orgId: f.orgId, userId: f.userId });
    const traffic = scriptGithub({});

    const response = await collect(f);

    // A removed member never reaches the collection at all.
    expect([401, 403]).toContain(response.status);
    expect(traffic.requests).toHaveLength(0);
  });

  it("does not read GitHub without a connected account", async () => {
    const f = await fixture({ account: "none" });
    const traffic = scriptGithub({});

    const response = await collect(f);

    expect(response.body).toMatchObject({
      result: "not-executed",
      reason: "not-connected",
    });
    expect(traffic.requests).toHaveLength(0);
  });

  it("does not read GitHub when the pinned Agent holds no grant", async () => {
    const f = await fixture({ account: "other-agent" });
    const traffic = scriptGithub({});

    const response = await collect(f);

    expect(response.body).toMatchObject({
      result: "not-executed",
      reason: "not-authorized",
    });
    expect(traffic.requests).toHaveLength(0);
  });

  it("rejects a future anchor without reading GitHub", async () => {
    const f = await fixture();
    const traffic = scriptGithub({});

    const response = await collect(
      f,
      new Date(now() + 10 * 60 * 1000).toISOString(),
    );

    expect(response.status).toBe(400);
    expect(traffic.requests).toHaveLength(0);
  });

  it("uses the thread's selected non-default account, not the default one", async () => {
    const f = await fixture();
    const actor = bdd.user({
      userId: f.userId,
      orgId: f.orgId,
      orgRole: "org:admin",
    });
    await connectGithubAccount(actor, "secondary", f.agentId, "second-account");
    const accounts = await readMemberConnectorAccounts({
      orgId: f.orgId,
      userId: f.userId,
      connectorSlug: "github",
    });
    expect(accounts).toHaveLength(2);
    const selected = accounts[1];
    if (!selected) {
      throw new Error("Expected a second GitHub account");
    }
    const chatThreadId = await seedMorningBriefThread({
      userId: f.userId,
      agentId: f.agentId,
    });
    await selectMorningBriefConnectorAccount({
      orgId: f.orgId,
      userId: f.userId,
      workflowId: f.workflowId,
      chatThreadId,
      connectorSlug: "github",
      connectorId: selected.id,
    });
    mockClerkMembership(f.orgId, f.userId);
    const traffic = scriptGithub({});

    const response = await collect(f);

    expect(response.body).toMatchObject({ result: "collected" });
    // The mocked token endpoint mints `github-access-<code>`, so the bearer
    // token names the exact account whose credential was used.
    expect(traffic.requests[0]?.token).toBe("Bearer github-access-secondary");
  });

  it("fails closed when the selected account belongs to another member", async () => {
    const f = await fixture();
    const otherUserId = `user_${randomUUID()}`;
    const otherBrief = await seedInstalledMorningBrief({
      orgId: f.orgId,
      userId: otherUserId,
    });
    const otherActor = bdd.user({
      userId: otherUserId,
      orgId: f.orgId,
      orgRole: "org:admin",
    });
    await connectGithubAccount(otherActor, "foreign", otherBrief.agentId);
    const foreignAccounts = await readMemberConnectorAccounts({
      orgId: f.orgId,
      userId: otherUserId,
      connectorSlug: "github",
    });
    const foreign = foreignAccounts[0];
    if (!foreign) {
      throw new Error("Expected the other member's GitHub account");
    }
    const chatThreadId = await seedMorningBriefThread({
      userId: f.userId,
      agentId: f.agentId,
    });
    await selectMorningBriefConnectorAccount({
      orgId: f.orgId,
      userId: f.userId,
      workflowId: f.workflowId,
      chatThreadId,
      connectorSlug: "github",
      connectorId: foreign.id,
    });
    mockClerkMembership(f.orgId, f.userId);
    const traffic = scriptGithub({});

    const response = await collect(f);

    // An explicit selection that does not resolve for this member must not
    // quietly fall back to the member's own default account.
    expect(response.body).toMatchObject({
      result: "not-executed",
      reason: "not-connected",
    });
    expect(traffic.requests).toHaveLength(0);
  });

  it("keeps the notification window half-open at both ends", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      notifications: () => {
        return [
          notification({
            repo: "acme/api",
            number: 1,
            updatedAt: AT_WINDOW_START,
          }),
          notification({
            repo: "acme/api",
            number: 2,
            updatedAt: BEFORE_WINDOW,
          }),
          notification({ repo: "acme/api", number: 3, updatedAt: AT_ANCHOR }),
        ];
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    // `[anchor - 24h, anchor)`: the window start is inside, the anchor is not.
    expect(
      bundle.items.map((item) => {
        return item.number;
      }),
    ).toStrictEqual([1]);
    expect(bundle.branches.notifications.windowStart).toBe(AT_WINDOW_START);
    expect(bundle.branches.notifications.windowEnd).toBe(ANCHOR);
    expect(traffic.queries[1]?.get("since")).toBe(AT_WINDOW_START);
    expect(traffic.queries[1]?.get("before")).toBe(ANCHOR);
  });

  it("includes old outstanding assignments and review requests with no lower bound", async () => {
    const f = await fixture();
    const ancient = new Date(WINDOW_START_MS - 90 * 24 * 60 * 60 * 1000);
    const traffic = scriptGithub({
      search: searchByBranch({
        assigned: searchPage([
          searchItem({
            repo: "acme/api",
            number: 11,
            updatedAt: ancient.toISOString(),
            isPullRequest: false,
          }),
        ]),
        reviewRequested: searchPage([
          searchItem({
            repo: "acme/web",
            number: 22,
            updatedAt: ancient.toISOString(),
          }),
        ]),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.login).toBe(LOGIN);
    expect(
      bundle.items
        .map((item) => {
          return item.number;
        })
        .sort(),
    ).toStrictEqual([11, 22]);
    // Outstanding-work branches are read-time snapshots, not windows.
    expect(bundle.branches.assigned.observedAt).toBeDefined();
    expect(bundle.branches.assigned.windowStart).toBeUndefined();
    expect(bundle.branches.reviewRequested.observedAt).toBeDefined();
    // The server owns both queries and builds them from the validated login.
    const queries = traffic.queries.map((query) => {
      return query.get("q") ?? "";
    });
    expect(queries).toContain(`is:open assignee:${LOGIN}`);
    expect(queries).toContain(`is:open is:pr review-requested:${LOGIN}`);
  });

  it("merges the three branches by identity and keeps every reason", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return [
          notification({
            repo: "acme/api",
            number: 7,
            updatedAt: MID_WINDOW,
            reason: "mention",
            unread: true,
          }),
        ];
      },
      search: searchByBranch({
        assigned: searchPage([
          searchItem({ repo: "acme/api", number: 7, updatedAt: MID_WINDOW }),
        ]),
        reviewRequested: searchPage([
          searchItem({ repo: "acme/api", number: 7, updatedAt: MID_WINDOW }),
        ]),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items).toHaveLength(1);
    const item = bundle.items[0];
    expect(item?.repository).toBe("acme/api");
    expect(item?.url).toBe("https://github.com/acme/api/pull/7");
    expect(
      item?.reasons
        .map((reason) => {
          return reason.branch;
        })
        .sort(),
    ).toStrictEqual(["assigned", "notification", "review-requested"]);
    expect(
      item?.reasons.find((reason) => {
        return reason.branch === "notification";
      }),
    ).toMatchObject({ notificationReason: "mention", unread: true });
  });

  it("reports a failing head check with its context names", async () => {
    const f = await fixture();
    scriptGithub({
      search: searchByBranch({
        reviewRequested: searchPage([
          searchItem({ repo: "acme/api", number: 5, updatedAt: MID_WINDOW }),
        ]),
      }),
      checkRuns: () => {
        return {
          total_count: 2,
          check_runs: [
            { name: "unit", status: "completed", conclusion: "failure" },
            { name: "types", status: "completed", conclusion: "success" },
          ],
        };
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toMatchObject({
      headSha: HEAD_SHA,
      state: "failing",
      failing: 1,
      succeeded: 1,
      incomplete: false,
    });
    expect(bundle.items[0]?.checks?.failingNames).toStrictEqual(["unit"]);
  });

  it("never reports an unread check surface as green", async () => {
    const f = await fixture();
    scriptGithub({
      search: searchByBranch({
        reviewRequested: searchPage([
          searchItem({ repo: "acme/api", number: 6, updatedAt: MID_WINDOW }),
        ]),
      }),
      checkRuns: () => {
        // More check runs exist than this bounded page returned.
        return {
          total_count: 9,
          check_runs: [
            { name: "unit", status: "completed", conclusion: "success" },
          ],
        };
      },
      status: () => {
        return {
          state: "success",
          total_count: 1,
          statuses: [{ context: "deploy", state: "success" }],
        };
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    // Two readable results out of nine are not a complete check surface.
    expect(bundle.items[0]?.checks).toMatchObject({
      state: "unknown",
      incomplete: true,
    });
    expect(bundle.coverage).toBe("partial");
    expect(bundle.branches.checks.limits).toContain("check-runs");
  });

  it("records a deleted pull request as a missing item, not a denial", async () => {
    const f = await fixture();
    scriptGithub({
      search: searchByBranch({
        reviewRequested: searchPage([
          searchItem({ repo: "acme/api", number: 12, updatedAt: MID_WINDOW }),
        ]),
      }),
      pull: () => {
        return new HttpResponse(null, { status: 404 });
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toBeUndefined();
    expect(bundle.branches.checks.limits).toContain("missing-item");
    expect(bundle.branches.checks.limits).not.toContain("denied-endpoint");
    expect(bundle.outcome).toBe("partial");
  });

  it("records an unsupported notification subject as a coverage gap", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return [
          notification({
            repo: "acme/api",
            number: 9,
            updatedAt: MID_WINDOW,
            type: "Discussion",
            subjectUrl: "https://api.github.com/repos/acme/api/discussions/9",
          }),
        ];
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items).toHaveLength(0);
    expect(bundle.outcome).toBe("partial");
    expect(bundle.coverage).toBe("partial");
    expect(bundle.branches.notifications.limits).toContain(
      "unsupported-subject",
    );
  });

  it("never follows a provider-supplied subject URL off the API host", async () => {
    const f = await fixture();
    let evilCalled = false;
    server.use(
      http.get("https://evil.test/*", () => {
        evilCalled = true;
        return HttpResponse.json({});
      }),
    );
    scriptGithub({
      notifications: () => {
        return [
          notification({
            repo: "acme/api",
            number: 4,
            updatedAt: MID_WINDOW,
            subjectUrl: "https://evil.test/repos/acme/api/pulls/4",
          }),
          notification({
            repo: "acme/api",
            number: 8,
            updatedAt: MID_WINDOW,
            subjectUrl:
              "https://user:pass@api.github.com/repos/acme/api/pulls/8",
          }),
        ];
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(evilCalled).toBeFalsy();
    expect(bundle.items).toHaveLength(0);
    expect(bundle.limits).toContain("unsafe-link");
    expect(bundle.coverage).toBe("partial");
  });

  it("does not turn an unread next page into a complete read", async () => {
    const f = await fixture();
    const page = Array.from({ length: 25 }, (_unused, index) => {
      return searchItem({
        repo: "acme/api",
        number: index + 1,
        updatedAt: MID_WINDOW,
        isPullRequest: false,
      });
    });
    scriptGithub({
      search: (query) => {
        const current = Number(query.get("page") ?? "1");
        // GitHub's own `Link` header. The reader validates it down to the
        // existence of a next page and its bounded number; the URL itself is
        // never followed, and the collector keeps building its own paths.
        return HttpResponse.json(
          {
            total_count: 500,
            incomplete_results: true,
            items: page.map((item, index) => {
              return { ...item, number: index + 1 + current * 100 };
            }),
          },
          {
            headers: {
              link: `<https://api.github.com/search/issues?page=${current + 1}>; rel="next"`,
            },
          },
        );
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.outcome).toBe("partial");
    expect(bundle.coverage).toBe("partial");
    expect(bundle.branches.assigned.limits).toContain("search-incomplete");
    expect(bundle.branches.assigned.limits).toContain("search-pages");
    expect(bundle.branches.assigned.limits).toContain("unread-pages");
    expect(bundle.branches.assigned.limits).toContain("search-total-exceeded");
    // Two bounded pages were read, and the third was refused by the budget.
    expect(bundle.branches.assigned.pages).toBe(2);
  });

  it("keeps a policy-denied search branch from erasing allowed notification data", async () => {
    const f = await fixture();
    const actor = bdd.user({
      userId: f.userId,
      orgId: f.orgId,
      orgRole: "org:admin",
    });
    // A real active grant denying only the search permission, applied through
    // the ordinary permission route. Notifications stay allowed.
    await runsApi.applyUserPermissionGrant(actor, {
      agentId: f.agentId,
      connectorSlug: "github",
      permission: "search:read",
      action: "deny",
    });
    mockClerkMembership(f.orgId, f.userId);
    const traffic = scriptGithub({
      notifications: () => {
        return [
          notification({ repo: "acme/api", number: 7, updatedAt: MID_WINDOW }),
        ];
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(
      bundle.items.map((item) => {
        return item.number;
      }),
    ).toStrictEqual([7]);
    expect(bundle.branches.notifications.status).toBe("complete");
    expect(bundle.branches.assigned.status).toBe("denied");
    expect(bundle.branches.reviewRequested.status).toBe("denied");
    expect(bundle.outcome).toBe("partial");
    expect(bundle.coverage).toBe("partial");
    // A denied endpoint is refused before the request is issued.
    expect(
      traffic.requests.some((entry) => {
        return entry.url === GITHUB_SEARCH;
      }),
    ).toBeFalsy();
  });

  it("keeps a policy-denied notification branch from erasing allowed search data", async () => {
    const f = await fixture();
    const actor = bdd.user({
      userId: f.userId,
      orgId: f.orgId,
      orgRole: "org:admin",
    });
    await runsApi.applyUserPermissionGrant(actor, {
      agentId: f.agentId,
      connectorSlug: "github",
      permission: "notifications:read",
      action: "deny",
    });
    mockClerkMembership(f.orgId, f.userId);
    const traffic = scriptGithub({
      search: searchByBranch({
        assigned: searchPage([
          searchItem({
            repo: "acme/api",
            number: 13,
            updatedAt: MID_WINDOW,
            isPullRequest: false,
          }),
        ]),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(
      bundle.items.map((item) => {
        return item.number;
      }),
    ).toStrictEqual([13]);
    expect(bundle.branches.notifications.status).toBe("denied");
    expect(bundle.branches.assigned.status).toBe("complete");
    expect(bundle.outcome).toBe("partial");
    expect(
      traffic.requests.some((entry) => {
        return entry.url === GITHUB_NOTIFICATIONS;
      }),
    ).toBeFalsy();
  });

  it("keeps a provider-forbidden branch from erasing allowed sibling data", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return new HttpResponse(null, { status: 403 });
      },
      search: searchByBranch({
        assigned: searchPage([
          searchItem({
            repo: "acme/api",
            number: 31,
            updatedAt: MID_WINDOW,
            isPullRequest: false,
          }),
        ]),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    // A provider 403 is endpoint-local: one repository or one endpoint can
    // refuse while the selected credential keeps working everywhere else.
    expect(
      bundle.items.map((item) => {
        return item.number;
      }),
    ).toStrictEqual([31]);
    expect(bundle.branches.notifications.status).toBe("denied");
    expect(bundle.branches.notifications.limits).toContain(
      "provider-forbidden",
    );
    expect(bundle.branches.assigned.status).toBe("complete");
    expect(bundle.outcome).toBe("partial");
    expect(bundle.coverage).toBe("partial");
  });

  it("classifies a provider 403 carrying Retry-After as a secondary rate limit", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return new HttpResponse(null, {
          status: 403,
          headers: { "retry-after": "30" },
        });
      },
      search: searchByBranch({
        reviewRequested: searchPage([
          searchItem({ repo: "acme/api", number: 32, updatedAt: MID_WINDOW }),
        ]),
      }),
    });

    const started = now();
    const bundle = collectedBundle((await collect(f)).body);

    // GitHub delivers its secondary rate limit as a 403 with `Retry-After`.
    // It is throttling, not a lost credential and not a permission refusal.
    expect(now() - started).toBeLessThan(10_000);
    expect(bundle.retryAfterMs).toBe(30_000);
    expect(bundle.branches.notifications.limits).toContain("rate-limited");
    expect(bundle.branches.notifications.limits).not.toContain(
      "provider-forbidden",
    );
    expect(bundle.branches.notifications.status).not.toBe("denied");
    // The sibling branch that was never throttled still contributes.
    expect(
      bundle.items.map((item) => {
        return item.number;
      }),
    ).toStrictEqual([32]);
    expect(bundle.outcome).toBe("partial");
  });

  it("classifies a rate limit without sleeping on Retry-After", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return new HttpResponse(null, {
          status: 429,
          headers: { "retry-after": "120" },
        });
      },
    });

    const started = now();
    const bundle = collectedBundle((await collect(f)).body);

    expect(now() - started).toBeLessThan(10_000);
    // The shared reader clamps the provider hint to its own bounded maximum.
    expect(bundle.retryAfterMs).toBe(60_000);
    expect(bundle.branches.notifications.status).toBe("failed");
    expect(bundle.branches.notifications.limits).toContain("rate-limited");
    expect(bundle.outcome).toBe("partial");
  });

  it("treats a malformed notification page as a failure, not an empty day", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return HttpResponse.text("not json at all");
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items).toHaveLength(0);
    expect(bundle.outcome).toBe("partial");
    expect(bundle.outcome).not.toBe("empty");
    expect(bundle.branches.notifications.limits).toContain(
      "malformed-response",
    );
  });

  it("reports a genuinely quiet day as an empty complete read", async () => {
    const f = await fixture();
    scriptGithub({});

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items).toHaveLength(0);
    expect(bundle.outcome).toBe("empty");
    expect(bundle.coverage).toBe("complete");
    expect(bundle.limits).toStrictEqual([]);
  });

  it("releases nothing when the membership is revoked while a read is held", async () => {
    const f = await fixture();
    const arrived = createDeferredPromise<void>(context.signal);
    const held = createDeferredPromise<void>(context.signal);
    const observed: string[] = [];
    server.use(
      http.get(GITHUB_USER, () => {
        observed.push("user");
        return HttpResponse.json({ login: LOGIN });
      }),
      http.get(GITHUB_NOTIFICATIONS, async () => {
        observed.push("notifications");
        arrived.resolve();
        await held.promise;
        return HttpResponse.json([
          notification({ repo: "acme/api", number: 3, updatedAt: MID_WINDOW }),
        ]);
      }),
      http.get(GITHUB_SEARCH, () => {
        observed.push("search");
        return HttpResponse.json(emptySearch());
      }),
    );

    const pending = collect(f);
    await arrived.promise;
    // The owner loses the organization membership while one GitHub request is
    // still in flight. Nothing after it may be issued, and the bundle that
    // request belongs to may not be released.
    getApiTestMocks().clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [] },
    );
    await revokeMorningBriefMembership({ orgId: f.orgId, userId: f.userId });
    held.resolve();
    const response = await pending;

    expect(observed).toStrictEqual(["user", "notifications"]);
    expect(response.body).toMatchObject({
      result: "not-executed",
      reason: "source-revoked",
    });
  });

  it("performs only GET requests and never marks a notification read", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      notifications: () => {
        return [
          notification({ repo: "acme/api", number: 2, updatedAt: MID_WINDOW }),
        ];
      },
    });

    await collect(f);

    expect(
      traffic.requests.every((entry) => {
        return entry.method === "GET";
      }),
    ).toBeTruthy();
    expect(traffic.requests[0]?.url).toBe(GITHUB_USER);
  });

  it("reports a read that exactly fills the item cap as complete", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return issueNotifications(49);
      },
      search: searchByBranch({
        assigned: searchPage([
          searchItem({
            repo: "acme/api",
            number: 100,
            updatedAt: MID_WINDOW,
            isPullRequest: false,
          }),
        ]),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    // Forty-nine notifications plus one distinct assignment is exactly fifty
    // identities: nothing was dropped, so this must stay a complete read.
    expect(bundle.items).toHaveLength(50);
    expect(bundle.outcome).toBe("complete");
    expect(bundle.coverage).toBe("complete");
    expect(bundle.limits).toStrictEqual([]);
    expect(bundle.branches.assigned.status).toBe("complete");
    expect(bundle.branches.assigned.items).toBe(1);
  });

  it("never reports a read complete when the item cap dropped an assignment", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return issueNotifications(50);
      },
      search: searchByBranch({
        assigned: searchPage([
          searchItem({
            repo: "acme/api",
            number: 100,
            updatedAt: MID_WINDOW,
            isPullRequest: false,
          }),
        ]),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    // The fifty-first identity is a real assignment the cap threw away. The
    // branch that found it may not report a complete read, and may not count
    // what it lost.
    expect(bundle.items).toHaveLength(50);
    expect(
      bundle.items.some((item) => {
        return item.number === 100;
      }),
    ).toBeFalsy();
    expect(bundle.outcome).toBe("partial");
    expect(bundle.coverage).toBe("partial");
    expect(bundle.limits).toContain("items");
    expect(bundle.branches.assigned.status).toBe("partial");
    expect(bundle.branches.assigned.limits).toContain("items");
    expect(bundle.branches.assigned.items).toBe(0);
  });

  it("does not treat requested page capacity as search results read", async () => {
    const f = await fixture();
    scriptGithub({
      search: searchByBranch({
        // A well-formed page that reports work it did not return, and no next
        // page. Twenty-five requested slots are not twenty-five results read.
        assigned: searchPage([], 1),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items).toHaveLength(0);
    expect(bundle.outcome).toBe("partial");
    expect(bundle.outcome).not.toBe("empty");
    expect(bundle.coverage).toBe("partial");
    expect(bundle.branches.assigned.limits).toContain("search-total-exceeded");
  });

  it("counts a repeated search identity once against the reported total", async () => {
    const f = await fixture();
    const first = [1, 2, 3].map((number) => {
      return searchItem({
        repo: "acme/api",
        number,
        updatedAt: MID_WINDOW,
        isPullRequest: false,
      });
    });
    const second = [2, 3, 4].map((number) => {
      return searchItem({
        repo: "acme/api",
        number,
        updatedAt: MID_WINDOW,
        isPullRequest: false,
      });
    });
    scriptGithub({
      // Six rows arrive, but the result set shifted and only four distinct
      // identities exist among them.
      search: assignedPages({ one: first, two: second, totalCount: 6 }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(
      bundle.items
        .map((item) => {
          return item.number;
        })
        .sort(),
    ).toStrictEqual([1, 2, 3, 4]);
    expect(bundle.branches.assigned.items).toBe(4);
    expect(bundle.branches.assigned.limits).toContain("search-total-exceeded");
    expect(bundle.outcome).toBe("partial");
  });

  it("reports a fully read populated search as complete", async () => {
    const f = await fixture();
    scriptGithub({
      search: searchByBranch({
        assigned: searchPage(
          [1, 2].map((number) => {
            return searchItem({
              repo: "acme/api",
              number,
              updatedAt: MID_WINDOW,
              isPullRequest: false,
            });
          }),
          2,
        ),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items).toHaveLength(2);
    expect(bundle.outcome).toBe("complete");
    expect(bundle.coverage).toBe("complete");
    expect(bundle.limits).toStrictEqual([]);
  });

  it("never reports a green head while a check-runs next page exists", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      search: searchByBranch({
        reviewRequested: searchPage([
          searchItem({ repo: "acme/api", number: 41, updatedAt: MID_WINDOW }),
        ]),
      }),
      checkRuns: () => {
        // The total agrees with the returned array, and GitHub still says
        // another page exists. The explicit next page wins.
        return HttpResponse.json(
          {
            total_count: 1,
            check_runs: [
              { name: "unit", status: "completed", conclusion: "success" },
            ],
          },
          { headers: nextPageLink(2) },
        );
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toMatchObject({
      state: "unknown",
      incomplete: true,
    });
    expect(bundle.branches.checks.limits).toContain("check-runs");
    expect(bundle.coverage).toBe("partial");
    // The one-page budget is unchanged: page two is never requested.
    const reads = requestsEnding(traffic, "/check-runs");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.query?.get("page")).toBe("1");
  });

  it("never reports a green head while a combined-status next page exists", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      search: searchByBranch({
        reviewRequested: searchPage([
          searchItem({ repo: "acme/api", number: 42, updatedAt: MID_WINDOW }),
        ]),
      }),
      status: () => {
        return HttpResponse.json(
          {
            state: "success",
            total_count: 1,
            statuses: [{ context: "deploy", state: "success" }],
          },
          { headers: nextPageLink(2) },
        );
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toMatchObject({
      state: "unknown",
      incomplete: true,
    });
    expect(bundle.branches.checks.limits).toContain("commit-status");
    expect(bundle.coverage).toBe("partial");
    expect(requestsEnding(traffic, "/status")).toHaveLength(1);
  });

  it("still reports an observed failing check while a next page exists", async () => {
    const f = await fixture();
    scriptGithub({
      search: searchByBranch({
        reviewRequested: searchPage([
          searchItem({ repo: "acme/api", number: 43, updatedAt: MID_WINDOW }),
        ]),
      }),
      checkRuns: () => {
        return HttpResponse.json(
          {
            total_count: 1,
            check_runs: [
              { name: "unit", status: "completed", conclusion: "failure" },
            ],
          },
          { headers: nextPageLink(2) },
        );
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    // An actually observed failure is a stronger fact than the unread page.
    expect(bundle.items[0]?.checks).toMatchObject({
      state: "failing",
      failing: 1,
      incomplete: true,
    });
  });

  it("treats an exhausted primary rate limit as throttling without Retry-After", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      notifications: () => {
        // GitHub's primary limit: 403 with an exhausted allowance and no hint.
        return new HttpResponse(null, {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        });
      },
      search: searchByBranch({
        assigned: searchPage([
          searchItem({
            repo: "acme/api",
            number: 51,
            updatedAt: MID_WINDOW,
            isPullRequest: false,
          }),
        ]),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.branches.notifications.limits).toContain("rate-limited");
    expect(bundle.branches.notifications.limits).not.toContain(
      "provider-forbidden",
    );
    expect(bundle.branches.notifications.status).not.toBe("denied");
    expect(bundle.retryAfterMs).toBeUndefined();
    expect(bundle.rateLimitRemaining).toBe(0);
    // The throttled branch never erases the sibling data, and nothing retried.
    expect(
      bundle.items.map((item) => {
        return item.number;
      }),
    ).toStrictEqual([51]);
    expect(bundle.outcome).toBe("partial");
    expect(requestsEnding(traffic, "/notifications")).toHaveLength(1);
  });

  it("classifies a throttled identity read as rate limiting without Retry-After", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      user: () => {
        return new HttpResponse(null, { status: 429 });
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.outcome).toBe("rate_limited");
    expect(bundle.limits).toContain("rate-limited");
    expect(bundle.retryAfterMs).toBeUndefined();
    expect(bundle.login).toBe("");
    // A throttled identity read stops the source; nothing is retried.
    expect(traffic.requests).toHaveLength(1);
  });

  it("classifies a denied identity read as a permission refusal", async () => {
    const f = await fixture();
    scriptGithub({
      user: () => {
        return new HttpResponse(null, { status: 403 });
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.outcome).toBe("permission_denied");
    expect(bundle.limits).toContain("provider-forbidden");
    expect(bundle.limits).not.toContain("rate-limited");
  });

  it("distinguishes a provider transport failure from a malformed payload", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return new HttpResponse(null, { status: 502 });
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.branches.notifications.limits).toContain("provider-failed");
    expect(bundle.branches.notifications.limits).not.toContain(
      "malformed-response",
    );
    expect(bundle.branches.notifications.status).toBe("failed");
    expect(bundle.outcome).toBe("partial");
  });

  it("rejects an encoded dot-segment subject URL before it is normalized", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      notifications: () => {
        return [
          notification({
            repo: "acme/api",
            number: 7,
            updatedAt: MID_WINDOW,
            // A URL parser resolves this to `/repos/acme/api/pulls/7` and the
            // escape disappears. The raw text has to be refused first.
            subjectUrl:
              "https://api.github.com/repos/acme/old/%2e%2e/api/pulls/7",
          }),
          notification({
            repo: "acme/api",
            number: 8,
            updatedAt: MID_WINDOW,
            subjectUrl: "https://api.github.com/repos/acme/old/../api/pulls/8",
          }),
        ];
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items).toHaveLength(0);
    expect(bundle.limits).toContain("unsafe-link");
    expect(bundle.branches.notifications.limits).toContain(
      "unsupported-subject",
    );
    expect(bundle.coverage).toBe("partial");
    // No enrichment read was attributed to the smuggled repository.
    expect(requestsEnding(traffic, "/pulls/7")).toHaveLength(0);
    expect(requestsEnding(traffic, "/pulls/8")).toHaveLength(0);
  });

  it("rejects an encoded dot-segment repository URL on a search result", async () => {
    const f = await fixture();
    scriptGithub({
      search: searchByBranch({
        assigned: searchPage([
          {
            ...searchItem({
              repo: "acme/api",
              number: 61,
              updatedAt: MID_WINDOW,
              isPullRequest: false,
            }),
            repository_url: "https://api.github.com/repos/acme/old/%2e%2e/api",
          },
        ]),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items).toHaveLength(0);
    expect(bundle.branches.assigned.limits).toContain("malformed-response");
    expect(bundle.outcome).toBe("partial");
  });

  it("retains a read whose projected text exactly fills the character cap", async () => {
    const f = await fixture();
    const sized = sizedAssignedIssues(800);
    scriptGithub({
      search: assignedPages({
        one: sized.slice(0, 25),
        two: sized.slice(25),
        totalCount: 50,
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items).toHaveLength(50);
    expect(bundle.counts.textCharacters).toBe(40_000);
    expect(bundle.counts.textCharacters).toBe(projectedTextCharacters(bundle));
    expect(bundle.limits).toStrictEqual([]);
    expect(bundle.outcome).toBe("complete");
  });

  it("charges every retained text field against the character cap", async () => {
    const f = await fixture();
    const repository = repositoryOfLength(140);
    const sized = Array.from({ length: 50 }, (_unused, index) => {
      return {
        ...searchItem({
          repo: repository,
          number: 10 + index,
          updatedAt: MID_WINDOW,
          isPullRequest: false,
          title: "t".repeat(200),
        }),
        body: "b".repeat(500),
        user: { login: "a".repeat(39) },
      };
    });
    scriptGithub({
      search: assignedPages({
        one: sized.slice(0, 25),
        two: sized.slice(25),
        totalCount: 50,
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    // Title plus excerpt alone is 35,000 characters, but the actor and
    // repository this bundle also hands the model push the real projection past
    // 40,000. The cap has to see all of it.
    expect(bundle.items.length).toBeLessThan(50);
    expect(bundle.counts.textCharacters).toBeLessThanOrEqual(40_000);
    expect(bundle.counts.textCharacters).toBe(projectedTextCharacters(bundle));
    expect(bundle.limits).toContain("text-characters");
    expect(bundle.outcome).toBe("partial");
    expect(bundle.coverage).toBe("partial");
  });

  it("clips a retained title without splitting a surrogate pair", async () => {
    const f = await fixture();
    scriptGithub({
      search: searchByBranch({
        assigned: searchPage([
          searchItem({
            repo: "acme/api",
            number: 71,
            updatedAt: MID_WINDOW,
            isPullRequest: false,
            // The 200-character boundary lands inside this astral character.
            title: `${"a".repeat(198)}😀 tail`,
          }),
        ]),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    const title = bundle.items[0]?.title ?? "";
    expect(title).toBe(`${"a".repeat(198)}…`);
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        title,
      ),
    ).toBeFalsy();
  });

  it("rejects an authority-adjacent backslash subject URL", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      notifications: () => {
        return [
          // A URL parser treats the backslash as a path separator, so each of
          // these really names a path the collector must not read an identity
          // from: a dot segment, an encoded dot segment, and an extra leading
          // segment that moves the whole repository path.
          notification({
            repo: "acme/api",
            number: 81,
            updatedAt: MID_WINDOW,
            subjectUrl: String.raw`https://api.github.com\../repos/acme/api/pulls/81`,
          }),
          notification({
            repo: "acme/api",
            number: 82,
            updatedAt: MID_WINDOW,
            subjectUrl: String.raw`https://api.github.com\%2e%2e/repos/acme/api/pulls/82`,
          }),
          notification({
            repo: "acme/api",
            number: 83,
            updatedAt: MID_WINDOW,
            subjectUrl: String.raw`https://api.github.com\extra/repos/acme/api/pulls/83`,
          }),
        ];
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items).toHaveLength(0);
    expect(bundle.limits).toContain("unsafe-link");
    expect(bundle.branches.notifications.limits).toContain(
      "unsupported-subject",
    );
    expect(bundle.coverage).toBe("partial");
    // No enrichment read was attributed to any smuggled identity.
    expect(requestsEnding(traffic, "/pulls/81")).toHaveLength(0);
    expect(requestsEnding(traffic, "/pulls/82")).toHaveLength(0);
    expect(requestsEnding(traffic, "/pulls/83")).toHaveLength(0);
  });

  it("rejects an authority-adjacent backslash repository URL on a search result", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      search: searchByBranch({
        assigned: searchPage(
          [
            String.raw`https://api.github.com\../repos/acme/api`,
            String.raw`https://api.github.com\%2e%2e/repos/acme/api`,
            String.raw`https://api.github.com\extra/repos/acme/api`,
          ].map((repositoryUrl, index) => {
            return {
              ...searchItem({
                repo: "acme/api",
                number: 84 + index,
                updatedAt: MID_WINDOW,
              }),
              repository_url: repositoryUrl,
            };
          }),
        ),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items).toHaveLength(0);
    expect(bundle.branches.assigned.limits).toContain("malformed-response");
    expect(bundle.outcome).toBe("partial");
    expect(requestsEnding(traffic, "/pulls/84")).toHaveLength(0);
    expect(requestsEnding(traffic, "/pulls/85")).toHaveLength(0);
    expect(requestsEnding(traffic, "/pulls/86")).toHaveLength(0);
  });

  it("still collects canonical subject and repository URLs", async () => {
    const f = await fixture();
    scriptGithub({
      notifications: () => {
        return [
          notification({
            repo: "acme/api",
            number: 87,
            updatedAt: MID_WINDOW,
            collection: "issues",
            type: "Issue",
          }),
        ];
      },
      search: searchByBranch({
        assigned: searchPage([
          searchItem({
            repo: "acme/api",
            number: 88,
            updatedAt: MID_WINDOW,
            isPullRequest: false,
          }),
        ]),
      }),
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(
      bundle.items
        .map((item) => {
          return item.number;
        })
        .sort(),
    ).toStrictEqual([87, 88]);
    expect(bundle.limits).toStrictEqual([]);
    expect(bundle.outcome).toBe("complete");
  });

  it("rejects a subject URL carrying a query or a fragment", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      notifications: () => {
        return [
          notification({
            repo: "acme/api",
            number: 89,
            updatedAt: MID_WINDOW,
            subjectUrl: "https://api.github.com/repos/acme/api/pulls/89?x=1",
          }),
          notification({
            repo: "acme/api",
            number: 90,
            updatedAt: MID_WINDOW,
            subjectUrl: "https://api.github.com/repos/acme/api/pulls/90#frag",
          }),
        ];
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items).toHaveLength(0);
    expect(bundle.limits).toContain("unsafe-link");
    expect(requestsEnding(traffic, "/pulls/89")).toHaveLength(0);
    expect(requestsEnding(traffic, "/pulls/90")).toHaveLength(0);
  });

  it("never reports a completed check run without a conclusion as failing", async () => {
    const f = await fixture();
    scriptGithub({
      search: reviewRequestedPull(91),
      checkRuns: () => {
        return checkRunsPage([
          { name: "unit", status: "completed", conclusion: null },
          { name: "types", status: "completed" },
        ]);
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    // GitHub's contract requires a conclusion once a run is `completed`, so
    // this payload is unreadable rather than a report of two failures.
    expect(bundle.items[0]?.checks).toMatchObject({
      state: "unknown",
      failing: 0,
      pending: 0,
      succeeded: 0,
      incomplete: true,
    });
    expect(bundle.items[0]?.checks?.failingNames).toStrictEqual([]);
    expect(bundle.branches.checks.limits).toContain("malformed-response");
    expect(bundle.coverage).toBe("partial");
  });

  it("never turns an unrecognized run status or conclusion into a fact", async () => {
    const f = await fixture();
    scriptGithub({
      search: reviewRequestedPull(92),
      checkRuns: () => {
        return checkRunsPage([
          { name: "unit", status: "completed", conclusion: "mystery" },
          { name: "lint", status: "hibernating" },
        ]);
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toMatchObject({
      state: "unknown",
      failing: 0,
      pending: 0,
      succeeded: 0,
      incomplete: true,
    });
    expect(bundle.branches.checks.limits).toContain("malformed-response");
    expect(bundle.coverage).toBe("partial");
  });

  it("rejects terminal conclusions on in-flight check runs", async () => {
    const f = await fixture();
    scriptGithub({
      search: reviewRequestedPull(93),
      checkRuns: () => {
        return checkRunsPage([
          { name: "unit", status: "in_progress", conclusion: "mystery" },
          { name: "lint", status: "queued", conclusion: "success" },
          { name: "e2e", status: "pending", conclusion: "failure" },
        ]);
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toMatchObject({
      state: "unknown",
      failing: 0,
      pending: 0,
      succeeded: 0,
      incomplete: true,
    });
    expect(bundle.items[0]?.checks?.failingNames).toStrictEqual([]);
    expect(bundle.branches.checks.limits).toContain("malformed-response");
    expect(bundle.coverage).toBe("partial");
  });

  it("keeps every documented unfinished status pending without a conclusion", async () => {
    const f = await fixture();
    scriptGithub({
      search: reviewRequestedPull(93),
      checkRuns: () => {
        return checkRunsPage([
          { name: "queued", status: "queued" },
          { name: "in-progress", status: "in_progress", conclusion: null },
          { name: "waiting", status: "waiting" },
          { name: "requested", status: "requested", conclusion: null },
          { name: "pending", status: "pending" },
        ]);
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toMatchObject({
      state: "pending",
      failing: 0,
      pending: 5,
      succeeded: 0,
      incomplete: false,
    });
    expect(bundle.branches.checks.limits).not.toContain("malformed-response");
  });

  it("never turns an unrecognized combined-status context state into a failure", async () => {
    const f = await fixture();
    scriptGithub({
      search: reviewRequestedPull(93),
      status: () => {
        return statusPage([{ context: "deploy", state: "mystery" }]);
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toMatchObject({
      state: "unknown",
      failing: 0,
      pending: 0,
      succeeded: 0,
      incomplete: true,
    });
    expect(bundle.items[0]?.checks?.failingNames).toStrictEqual([]);
    expect(bundle.branches.checks.limits).toContain("malformed-response");
  });

  it("keeps valid failing, pending and successful siblings next to a malformed run", async () => {
    const f = await fixture();
    scriptGithub({
      search: reviewRequestedPull(94),
      checkRuns: () => {
        return checkRunsPage([
          { name: "unit", status: "completed", conclusion: "failure" },
          { name: "types", status: "queued", conclusion: null },
          { name: "lint", status: "completed", conclusion: "success" },
          { name: "e2e", status: "in_progress", conclusion: "mystery" },
        ]);
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    // One unreadable sibling may not swallow facts from readable siblings, and
    // those facts may not hide that the surface was read only in part.
    expect(bundle.items[0]?.checks).toMatchObject({
      state: "failing",
      failing: 1,
      pending: 1,
      succeeded: 1,
      incomplete: true,
    });
    expect(bundle.items[0]?.checks?.failingNames).toStrictEqual(["unit"]);
    expect(bundle.branches.checks.limits).toContain("malformed-response");
  });

  it("keeps a known pending check next to an uninterpretable sibling", async () => {
    const f = await fixture();
    scriptGithub({
      search: reviewRequestedPull(95),
      checkRuns: () => {
        return checkRunsPage([
          { name: "unit", status: "in_progress" },
          { name: "types", status: "completed", conclusion: "mystery" },
        ]);
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toMatchObject({
      state: "pending",
      failing: 0,
      pending: 1,
      incomplete: true,
    });
    expect(bundle.branches.checks.limits).toContain("malformed-response");
  });

  it("rejects a check-suite-only conclusion while preserving check-run failures", async () => {
    const f = await fixture();
    scriptGithub({
      search: reviewRequestedPull(96),
      checkRuns: () => {
        return checkRunsPage(
          [
            "action_required",
            "cancelled",
            "failure",
            "stale",
            "startup_failure",
            "timed_out",
          ].map((conclusion) => {
            return { name: conclusion, status: "completed", conclusion };
          }),
        );
      },
      status: () => {
        return statusPage([{ context: "deploy", state: "error" }]);
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    // `startup_failure` belongs to GitHub's check-suite conclusion vocabulary,
    // not check runs. `stale` remains a documented check-run exception.
    expect(bundle.items[0]?.checks).toMatchObject({
      state: "failing",
      failing: 6,
      pending: 0,
      succeeded: 0,
      incomplete: true,
    });
    expect(bundle.items[0]?.checks?.failingNames).toContain("stale");
    expect(bundle.items[0]?.checks?.failingNames).not.toContain(
      "startup_failure",
    );
    expect(bundle.branches.checks.limits).toContain("malformed-response");
  });

  it("reports a fully read healthy head as green", async () => {
    const f = await fixture();
    scriptGithub({
      search: reviewRequestedPull(97),
      checkRuns: () => {
        return checkRunsPage([
          { name: "unit", status: "completed", conclusion: "success" },
          { name: "lint", status: "completed", conclusion: "neutral" },
          { name: "e2e", status: "completed", conclusion: "skipped" },
        ]);
      },
      status: () => {
        return statusPage([{ context: "deploy", state: "success" }]);
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toMatchObject({
      state: "success",
      failing: 0,
      pending: 0,
      succeeded: 4,
      incomplete: false,
    });
    expect(bundle.limits).toStrictEqual([]);
    expect(bundle.outcome).toBe("complete");
  });

  it("never reports green when a check-runs total underreports its own page", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      search: reviewRequestedPull(98),
      checkRuns: () => {
        // No next page, and a total that contradicts the array it arrived with.
        return checkRunsPage(
          [{ name: "unit", status: "completed", conclusion: "success" }],
          0,
        );
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toMatchObject({
      state: "unknown",
      succeeded: 1,
      incomplete: true,
    });
    expect(bundle.branches.checks.limits).toContain("check-runs");
    expect(bundle.coverage).toBe("partial");
    // The exact head and the one-page ceiling are unchanged.
    const reads = requestsEnding(traffic, "/check-runs");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.url).toBe(
      `https://api.github.com/repos/acme/api/commits/${HEAD_SHA}/check-runs`,
    );
    expect(reads[0]?.query?.get("page")).toBe("1");
  });

  it("never reports green when a combined-status total underreports its own page", async () => {
    const f = await fixture();
    scriptGithub({
      search: reviewRequestedPull(99),
      status: () => {
        return statusPage([{ context: "deploy", state: "success" }], 0);
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toMatchObject({
      state: "unknown",
      succeeded: 1,
      incomplete: true,
    });
    expect(bundle.branches.checks.limits).toContain("commit-status");
    expect(bundle.coverage).toBe("partial");
  });

  it("never reports green when a combined-status total overreports its own page", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      search: reviewRequestedPull(100),
      status: () => {
        return statusPage([{ context: "deploy", state: "success" }], 3);
      },
    });

    const bundle = collectedBundle((await collect(f)).body);

    expect(bundle.items[0]?.checks).toMatchObject({
      state: "unknown",
      succeeded: 1,
      incomplete: true,
    });
    expect(bundle.branches.checks.limits).toContain("commit-status");
    expect(bundle.coverage).toBe("partial");
    const reads = requestsEnding(traffic, "/status");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.url).toBe(
      `https://api.github.com/repos/acme/api/commits/${HEAD_SHA}/status`,
    );
  });
});
