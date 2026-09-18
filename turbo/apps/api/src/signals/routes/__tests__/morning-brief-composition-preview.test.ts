import { randomUUID } from "node:crypto";

import type { Capability } from "@okouai/api-contracts/contracts/capabilities";
import { morningBriefCompositionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-composition-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { getApiTestMocks } from "../../../__tests__/mocks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { seedInstalledMorningBrief } from "../../../test-fixtures/morning-brief-github-collection";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { morningBriefCompositionPreviewRoutes } from "../morning-brief-composition-preview";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

/**
 * The source-independent composition, driven through the registered route.
 *
 * Everything asserted here is an HTTP response to the production endpoint: the
 * facts a provider supplied either reach request assembly or they do not, and
 * the only way to see that from outside is the report the route returns. The
 * per-source evidence digest is what makes "two different provider states" and
 * "two different requests" the same assertion — a normalization that quietly
 * dropped the branch a pull request was selected by, or the head its checks
 * describe, produced byte-identical evidence for materially different days.
 *
 * `route-registration.test.ts` owns the assertion that this exact slice is in
 * the production table, so driving the slice here exercises the deployed
 * handler, its production gate, authentication and ownership checks.
 */

const context = testContext();
const bdd = createBddApi(context);
const connectorApi = createConnectorBddApi(context);

const GITHUB_ORIGIN = "https://api.github.com";
const GITHUB_USER = `${GITHUB_ORIGIN}/user`;
const GITHUB_NOTIFICATIONS = `${GITHUB_ORIGIN}/notifications`;
const GITHUB_SEARCH = `${GITHUB_ORIGIN}/search/issues`;
const GITHUB_PULLS = `${GITHUB_ORIGIN}/repos/:owner/:repo/pulls/:number`;
const GITHUB_CHECK_RUNS = `${GITHUB_ORIGIN}/repos/:owner/:repo/commits/:ref/check-runs`;
const GITHUB_STATUS = `${GITHUB_ORIGIN}/repos/:owner/:repo/commits/:ref/status`;

/** A second-aligned anchor an hour behind this run, so the window is stable. */
const ANCHOR_MS = Math.floor((now() - 60 * 60 * 1000) / 1000) * 1000;
const ANCHOR = new Date(ANCHOR_MS).toISOString();
const MID_WINDOW = new Date(ANCHOR_MS - 60 * 60 * 1000).toISOString();

const LOGIN = "brief-owner";
const REPO = "vm0-ai/okou";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
  readonly headers: { readonly authorization: string };
}

function composeClient() {
  return setupApp({
    context,
    routes: morningBriefCompositionPreviewRoutes,
  })(morningBriefCompositionPreviewContract);
}

function agentToken(
  userId: string,
  orgId: string,
  capabilities: readonly Capability[] = ["agent:read"],
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

/** Keep the caller authenticated at the Clerk boundary. */
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

async function connectGithubAccount(
  actor: ApiTestUser,
  code: string,
  agentId: string,
): Promise<void> {
  mockGitHubConnectorOAuth({
    userId: githubExternalUserId(code),
    login: LOGIN,
  });
  const start = await connectorApi.startOauth(
    actor,
    "github",
    "oauth",
    agentId,
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected a GitHub OAuth state");
  }
  const completed = await connectorApi.completeOauthCallbackResult("github", {
    code,
    state,
  });
  expect(completed.body.status).toBe("success");
}

async function fixture(
  options: { readonly github?: boolean } = {},
): Promise<Fixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const actor = bdd.user({ userId, orgId, orgRole: "org:admin" });
  const brief = await seedInstalledMorningBrief({ orgId, userId });
  if (options.github !== false) {
    await connectGithubAccount(actor, `compose-${randomUUID()}`, brief.agentId);
  }
  await updateFeatureSwitchesForUser(
    context,
    { orgId, userId },
    { [FeatureSwitchKey.SimpleMorningBrief]: true },
  );
  mockClerkMembership(orgId, userId);
  return { orgId, userId, headers: agentToken(userId, orgId) };
}

type ReplyBody = Record<string, unknown> | unknown[];
type Reply = (query: URLSearchParams) => ReplyBody | Response;

interface GithubTraffic {
  readonly requests: string[];
}

/** Script the GitHub reads and count exactly how many were issued. */
function scriptGithub(script: {
  readonly notifications?: Reply;
  readonly search?: Reply;
  readonly pull?: Reply;
  readonly checkRuns?: Reply;
  readonly status?: Reply;
}): GithubTraffic {
  const traffic: GithubTraffic = { requests: [] };
  const record = (reply: Reply | undefined, fallback: ReplyBody) => {
    return ({ request }: { request: Request }) => {
      const url = new URL(request.url);
      traffic.requests.push(url.pathname);
      const result = reply?.(url.searchParams) ?? fallback;
      return result instanceof Response ? result : HttpResponse.json(result);
    };
  };
  server.use(
    http.get(GITHUB_USER, record(undefined, { login: LOGIN })),
    http.get(GITHUB_NOTIFICATIONS, record(script.notifications, [])),
    http.get(GITHUB_SEARCH, record(script.search, emptySearch())),
    http.get(GITHUB_PULLS, record(script.pull, pullDetail(HEAD_A))),
    http.get(GITHUB_CHECK_RUNS, record(script.checkRuns, noCheckRuns())),
    http.get(GITHUB_STATUS, record(script.status, noStatuses())),
  );
  return traffic;
}

function searchPage(items: readonly unknown[]) {
  return {
    total_count: items.length,
    incomplete_results: false,
    items: [...items],
  };
}

function emptySearch() {
  return searchPage([]);
}

/** The one pull request both scenarios describe, identically titled. */
function pullSearchItem() {
  return {
    number: 7,
    title: "Ship the composition",
    state: "open",
    updated_at: MID_WINDOW,
    repository_url: `${GITHUB_ORIGIN}/repos/${REPO}`,
    body: "body text",
    user: { login: "someone-else" },
    pull_request: { url: "ignored" },
    draft: false,
  };
}

function pullDetail(headSha: string) {
  return {
    number: 7,
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

function failingCheckRuns() {
  return {
    total_count: 1,
    check_runs: [
      { name: "build", status: "completed", conclusion: "failure" },
      { name: "types", status: "completed", conclusion: "success" },
    ],
  };
}

function successfulCheckRuns() {
  return {
    total_count: 1,
    check_runs: [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "types", status: "completed", conclusion: "success" },
    ],
  };
}

/** Route the two search branches to different pages. */
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

async function compose(f: Fixture) {
  const response = await accept(
    composeClient().compose({ headers: f.headers, body: { anchor: ANCHOR } }),
    [200],
  );
  return response.body;
}

/** The per-source report, or a failure naming what the route did return. */
function sourceReport(
  body: Awaited<ReturnType<typeof compose>>,
  source: "gmail" | "calendar" | "github" | "slack" | "chat",
) {
  if (body.result !== "composed" && body.result !== "empty") {
    throw new Error(`Expected a composition, got ${JSON.stringify(body)}`);
  }
  const report = body.composition.sources.find((entry) => {
    return entry.source === source;
  });
  if (!report) {
    throw new Error(`Expected a ${source} report`);
  }
  return report;
}

describe("POST /api/morning-brief/collection-preview/compose", () => {
  it("keeps review, check and head differences visible to request assembly", async () => {
    const reviewRequested = await fixture();
    scriptGithub({
      search: searchByBranch({
        reviewRequested: searchPage([pullSearchItem()]),
      }),
      pull: () => {
        return pullDetail(HEAD_A);
      },
      checkRuns: () => {
        return failingCheckRuns();
      },
    });
    const first = await compose(reviewRequested);

    const assigned = await fixture();
    scriptGithub({
      search: searchByBranch({ assigned: searchPage([pullSearchItem()]) }),
      pull: () => {
        return pullDetail(HEAD_B);
      },
      checkRuns: () => {
        return successfulCheckRuns();
      },
    });
    const second = await compose(assigned);

    const left = sourceReport(first, "github");
    const right = sourceReport(second, "github");
    // The same repository, number and title in both: only the branch that
    // selected it, its check state and its head differ.
    expect(left.items).toBe(1);
    expect(right.items).toBe(1);
    expect(left.includedInRequest).toBe(1);
    expect(right.includedInRequest).toBe(1);
    // Two materially different mornings must not assemble one request.
    expect(left.evidenceDigest).not.toBe(right.evidenceDigest);
    expect(first.result).toBe("composed");
    expect(second.result).toBe("composed");
  });

  it("reports the provider reads the collector actually issued", async () => {
    const f = await fixture();
    const traffic = scriptGithub({
      search: searchByBranch({
        reviewRequested: searchPage([pullSearchItem()]),
      }),
      pull: () => {
        return pullDetail(HEAD_A);
      },
      checkRuns: () => {
        return failingCheckRuns();
      },
    });

    const body = await compose(f);

    const github = sourceReport(body, "github");
    // The independent oracle is the traffic the mocked provider observed.
    const listPages = traffic.requests.filter((pathname) => {
      return pathname === "/notifications" || pathname === "/search/issues";
    }).length;
    // A count summed from list pages alone misses the identity read and every
    // pull request detail, check run and status read the same collection paid
    // for, so the reported budget could never be reconciled with the provider.
    expect(traffic.requests.length).toBeGreaterThan(listPages);
    expect(github.requests).toBe(traffic.requests.length);
  });

  it("keeps an outstanding review request out of window activity", async () => {
    const f = await fixture();
    scriptGithub({
      search: searchByBranch({
        reviewRequested: searchPage([pullSearchItem()]),
      }),
    });

    const github = sourceReport(await compose(f), "github");

    expect(github.timeSemantics.outstanding).toBe(1);
    expect(github.timeSemantics.instant).toBe(0);
    expect(github.provenance.observedAt).not.toBeNull();
    expect(
      github.provenance.branches.map((branch) => {
        return branch.name;
      }),
    ).toContain("reviewRequested");
  });

  it("keeps a bounded read from being reported as a complete one", async () => {
    const f = await fixture();
    scriptGithub({
      search: () => {
        return {
          total_count: 2,
          incomplete_results: true,
          items: [pullSearchItem()],
        };
      },
    });

    const github = sourceReport(await compose(f), "github");

    expect(github.coverage).toBe("partial");
    // The cap never enumerated what it left behind, so the remainder stays an
    // explicit unknown rather than a count nothing observed.
    expect(github.omitted.bySource.known).toBe(0);
    expect(github.omitted.bySource.unknownRemaining).toBeTruthy();
    expect(github.omitted.unknownRemaining).toBeTruthy();
    expect(github.provenance.limitations.length).toBeGreaterThan(0);
  });

  it("keeps an empty Chat snapshot explicit without inventing evidence", async () => {
    const f = await fixture({ github: false });
    scriptGithub({});

    const chat = sourceReport(await compose(f), "chat");

    expect(chat.coverage).toBe("empty");
    expect(chat.items).toBe(0);
    expect(chat.includedInRequest).toBe(0);
    expect(chat.timeSemantics.outstanding).toBe(0);
    expect(chat.provenance.observedAt).not.toBeNull();
    expect(chat.provenance.branches).toStrictEqual([
      expect.objectContaining({ name: "unread", status: "empty" }),
    ]);
    expect(chat.omitted.knownTotal).toBe(0);
  });

  it("leaves a source nobody connected unconfigured rather than empty", async () => {
    const f = await fixture({ github: false });
    scriptGithub({});

    const body = await compose(f);

    expect(sourceReport(body, "github").coverage).toBe("unconfigured");
    expect(sourceReport(body, "github").provenance.collectedAt).toBeNull();
    expect(sourceReport(body, "github").omitted.knownTotal).toBe(0);
  });
});
