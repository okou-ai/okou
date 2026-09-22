import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { morningBriefCompositionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-composition-preview";
import type { ConnectorCatalogArtifact } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  API_TEST_CONNECTOR_CATALOG,
  installApiTestConnectorCatalog,
} from "../../../test-fixtures/connector-catalog";
import {
  bindMorningBriefThreadFixture,
  installMorningBriefFixture,
} from "../../../test-fixtures/morning-brief-gmail-collection";
import { morningBriefCompositionPreviewRoutes } from "../morning-brief-composition-preview";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

/**
 * One source's authority verdict must never settle another source's morning.
 *
 * This is the 2026-09-21T23:00Z production occurrence. Five sources collected
 * 268 items and every read was authorized; GitHub touched more distinct
 * endpoints than one retained descriptor was allowed to name, and the resulting
 * descriptor-set rejection voided the whole occurrence. The model was never
 * invoked and nothing was delivered, because a bound on how much authority
 * evidence could be retained about one source was being enforced against the
 * entire brief.
 *
 * A read that completed under valid authorization is the brief's evidence. If a
 * source's authority cannot be re-established *after* its read, that is not a
 * reason to withhold the owner's other authorized work, and it is never a
 * reason to settle the occurrence with no request at all.
 *
 * Everything below is the deployed path: the registered composition route, the
 * real database, real authorization, and GitHub doubled only at its HTTP
 * boundary.
 */

const GITHUB_USER = "https://api.github.com/user";
const GITHUB_NOTIFICATIONS = "https://api.github.com/notifications";
const GITHUB_SEARCH = "https://api.github.com/search/issues";

const ANCHOR_ISO = "2026-09-17T07:00:00.000Z";
const ANCHOR_MS = Date.parse(ANCHOR_ISO);
/** Inside the 24-hour window every collector asks about. */
const IN_WINDOW = new Date(ANCHOR_MS - 60_000).toISOString();

const LOGIN = "brief-owner";
const OWNER = "okou-ai";
const REPO = "okou";

/**
 * Two open pull requests, so the collector issues its per-pull reads.
 *
 * Each one costs three further distinct URLs — the pull, its check runs and its
 * combined status — which is how a healthy GitHub morning reaches more retained
 * endpoints than one descriptor may name.
 */
const PULLS = [
  { number: 11, sha: "a".repeat(40) },
  { number: 12, sha: "b".repeat(40) },
] as const;

/** Real OAuth setup plus a five-source composition needs more than 5 seconds. */
const TEST_TIMEOUT_MS = 60_000;

const context = testContext({ connectorCatalog: true });
const store = createStore();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);
const workflowBdd = createWorkflowsBddApi(context);

/**
 * An object store that actually round-trips.
 *
 * Creating an Agent publishes its instructions volume and the composition's
 * language context reads that volume back, so the shared default — which
 * answers every command with a fixed size and no body — would make the
 * composition report an unreadable Agent instead of running.
 */
function stubObjectStorage(objects: Map<string, Buffer>): void {
  const objectKey = (command: {
    readonly input?: { readonly Bucket?: string; readonly Key?: string };
  }): string => {
    return `${command.input?.Bucket ?? ""}/${command.input?.Key ?? ""}`;
  };
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (typeof command !== "object" || command === null) {
      return Promise.resolve({});
    }
    const typed = command as {
      readonly input?: {
        readonly Bucket?: string;
        readonly Key?: string;
        readonly Body?: unknown;
      };
    };
    const name = command.constructor.name;
    const key = objectKey(typed);
    if (name === "PutObjectCommand") {
      const body = typed.input?.Body;
      objects.set(
        key,
        typeof body === "string"
          ? Buffer.from(body, "utf8")
          : Buffer.from(body as Uint8Array),
      );
      return Promise.resolve({});
    }
    const stored = objects.get(key);
    if (name === "HeadObjectCommand") {
      return stored === undefined
        ? Promise.reject(
            Object.assign(new Error("NotFound"), { name: "NotFound" }),
          )
        : Promise.resolve({ ContentLength: stored.length });
    }
    if (name === "GetObjectCommand") {
      return stored === undefined
        ? Promise.reject(
            Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }),
          )
        : Promise.resolve({
            Body: Readable.from([stored]),
            ContentLength: stored.length,
          });
    }
    return Promise.resolve({});
  });
}

/**
 * The accepted catalog, with every GitHub route left unnamed.
 *
 * The connector still allows unknown requests, so every route stays allowed and
 * the collector reads exactly what it always reads. What changes is only how
 * much authority evidence one read produces: an endpoint allowed without a
 * named permission groups with nothing, so each distinct URL is retained
 * separately instead of collapsing onto a shared grant. That is the production
 * shape — 20 distinct URLs over 6 route shapes — reached deterministically.
 */
function catalogWithUnnamedGithubRoutes(): ConnectorCatalogArtifact {
  return {
    ...API_TEST_CONNECTOR_CATALOG,
    catalogVersion: `${API_TEST_CONNECTOR_CATALOG.catalogVersion}-github-unnamed`,
    connectors: API_TEST_CONNECTOR_CATALOG.connectors.map((connector) => {
      if (
        connector.slug !== "github" ||
        connector.firewall?.kind !== "generated"
      ) {
        return connector;
      }
      return {
        ...connector,
        firewall: {
          ...connector.firewall,
          defaultAllowed: null,
          config: {
            ...connector.firewall.config,
            apis: connector.firewall.config.apis.map((api) => {
              return { ...api, permissions: [] };
            }),
          },
        },
      };
    }),
  };
}

interface Fixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly membershipId: string;
}

/** An installed Morning Brief whose Agent holds a connected GitHub account. */
async function setupOwner(
  objectStorage: Map<string, Buffer>,
): Promise<Fixture> {
  const { actor } = await workflowBdd.setupWorkflowOrg({
    timezone: "Asia/Shanghai",
  });
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  // `setupWorkflowOrg` reinstalls the shared object-storage double, so restore
  // the round-tripping one before anything is published.
  stubObjectStorage(objectStorage);
  const agent = await bdd.createAgent(actor, {
    displayName: `brief-${randomUUID().slice(0, 8)}`,
  });
  const agentId = agent.agentId;
  await bdd.updateAgentInstructions(actor, agentId, "Summarize the morning.");
  mockGitHubConnectorOAuth({ userId: 4242, login: LOGIN });
  const start = await connectorsApi.startOauth(
    actor,
    "github",
    "oauth",
    agentId,
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected a GitHub OAuth state");
  }
  await connectorsApi.completeOauthCallback("github", {
    code: `github-code-${randomUUID()}`,
    state,
  });
  await runsApi.enableAgentConnectors(actor, agentId, ["github"]);
  const installation = await installMorningBriefFixture(
    { orgId: actor.orgId, userId: actor.userId },
    { agentId, timezone: "Asia/Shanghai" },
  );
  await bindMorningBriefThreadFixture(
    { orgId: actor.orgId, userId: actor.userId },
    { workflowId: installation.workflowId, agentId },
  );
  await updateFeatureSwitchesForUser(
    context,
    { orgId: actor.orgId, userId: actor.userId },
    { [FeatureSwitchKey.SimpleMorningBrief]: true },
  );
  // Connector and permission setup reinstall their own doubles, so the store
  // the composition reads through is restored last.
  stubObjectStorage(objectStorage);
  return {
    actor: { ...actor, orgId: actor.orgId },
    membershipId: `orgmem_${randomUUID()}`,
  };
}

/**
 * A healthy GitHub morning: every read answers, across many distinct URLs.
 *
 * Nothing here fails. The point of the fixture is that a fully successful,
 * fully authorized collection is what produces the large retained endpoint set.
 */
function stubGithub(): { readonly urls: () => readonly string[] } {
  const urls: string[] = [];
  const record = (payload: Parameters<typeof HttpResponse.json>[0]) => {
    return ({ request }: { request: Request }) => {
      urls.push(request.url);
      return HttpResponse.json(payload);
    };
  };
  const searchItems = PULLS.map((pull) => {
    return {
      number: pull.number,
      title: `pull ${pull.number.toString()}`,
      state: "open",
      updated_at: IN_WINDOW,
      repository_url: `https://api.github.com/repos/${OWNER}/${REPO}`,
      body: "body text",
      draft: false,
      pull_request: {},
      user: { login: "someone-else" },
    };
  });
  server.use(
    http.get(GITHUB_USER, record({ id: 4242, login: LOGIN })),
    http.get(GITHUB_NOTIFICATIONS, record([])),
    http.get(GITHUB_SEARCH, ({ request }) => {
      const url = new URL(request.url);
      urls.push(request.url);
      const assigned = (url.searchParams.get("q") ?? "").includes(
        `assignee:${LOGIN}`,
      );
      return HttpResponse.json({
        total_count: assigned ? searchItems.length : 0,
        incomplete_results: false,
        items: assigned ? searchItems : [],
      });
    }),
    ...PULLS.flatMap((pull) => {
      const base = `https://api.github.com/repos/${OWNER}/${REPO}`;
      return [
        http.get(
          `${base}/pulls/${pull.number.toString()}`,
          record({
            number: pull.number,
            state: "open",
            draft: false,
            updated_at: IN_WINDOW,
            head: { sha: pull.sha },
          }),
        ),
        http.get(
          `${base}/commits/${pull.sha}/check-runs`,
          record({ total_count: 0, check_runs: [] }),
        ),
        http.get(
          `${base}/commits/${pull.sha}/status`,
          record({ state: "success", total_count: 0, statuses: [] }),
        ),
      ];
    }),
  );
  return {
    urls: () => {
      return urls;
    },
  };
}

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer test-token" } as const;
}

async function compose(fixture: Fixture) {
  await store.set(
    seedOrgMembership$,
    {
      orgId: fixture.actor.orgId,
      userId: fixture.actor.userId,
      role: "admin",
      membershipId: fixture.membershipId,
    },
    context.signal,
  );
  return await accept(
    setupApp({
      context,
      routes: morningBriefCompositionPreviewRoutes,
    })(morningBriefCompositionPreviewContract).compose({
      headers: authHeaders(fixture.actor),
      body: { anchor: ANCHOR_ISO },
    }),
    [200],
  );
}

describe("Morning Brief composition containing one source's authority verdict", () => {
  let objectStorage = new Map<string, Buffer>();

  beforeEach(async () => {
    mockNow(ANCHOR_MS + 30_000);
    objectStorage = new Map();
    stubObjectStorage(objectStorage);
    await installApiTestConnectorCatalog({
      catalog: catalogWithUnnamedGithubRoutes(),
    });
  });

  afterEach(() => {
    clearMockNow();
  });

  it(
    "composes the brief when one source touched more endpoints than a descriptor may name",
    async () => {
      const fixture = await setupOwner(objectStorage);
      const github = stubGithub();

      const response = await compose(fixture);

      // The occurrence settles with a request. Before this, the descriptor-set
      // rejection produced `incomplete: retained-authority-unbounded` here and
      // the model was never invoked for any source.
      if (response.status !== 200 || response.body.result !== "composed") {
        throw new Error(
          `Expected a composed brief, received ${JSON.stringify(response.body)}`,
        );
      }
      const composition = response.body.composition;
      expect(composition.request).not.toBeNull();

      // The collection really did read across more distinct endpoints than one
      // retained descriptor was allowed to name. Without this the assertion
      // above would pass for a morning that never reached the bound at all.
      expect(new Set(github.urls()).size).toBeGreaterThan(8);

      // GitHub's own reads were authorized and complete, so its evidence stays
      // and actually reaches the request the model is asked to write from.
      const githubSource = composition.sources.find((entry) => {
        return entry.source === "github";
      });
      expect(githubSource?.coverage).toBe("complete");
      expect(githubSource?.items).toBeGreaterThan(0);
      expect(githubSource?.includedInRequest).toBeGreaterThan(0);

      // The containment claim. Every other source keeps exactly the outcome it
      // collected: one source's retained authority evidence settles that
      // source, never a sibling and never the occurrence.
      for (const entry of composition.sources) {
        if (entry.source === "github") {
          continue;
        }
        expect(entry.coverage).not.toBe("failed");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
