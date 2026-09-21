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
 * A composed brief whose source read an endpoint allowed without a permission.
 *
 * Connector requests are authorized one URL at a time, and a URL under an
 * allowed base that matches no named catalog route is decided by the
 * connector's unknown-request policy rather than by a named permission. Such an
 * endpoint is allowed and contributes no permission at all.
 *
 * The composition records what each released read was authorized by, and
 * re-asks that authority before the request is assembled. If the two sides
 * disagree about what a permissionless endpoint contributes, a source whose
 * grants never changed is withdrawn on every attempt and reports
 * `coverage: "failed"` with no items despite a fully successful collection.
 *
 * The accepted catalog is what decides whether a route names a permission, and
 * a caller cannot choose it, so these install a GitHub catalog whose `/user`
 * route carries no permission name. Everything else is the deployed path: the
 * registered composition route, the real database, real authorization, and
 * GitHub doubled only at its HTTP boundary.
 */

const GITHUB_USER = "https://api.github.com/user";
const GITHUB_NOTIFICATIONS = "https://api.github.com/notifications";
const GITHUB_SEARCH = "https://api.github.com/search/issues";

const ANCHOR_ISO = "2026-09-17T07:00:00.000Z";
const ANCHOR_MS = Date.parse(ANCHOR_ISO);
/** Inside the 24-hour window the collector asks GitHub about. */
const IN_WINDOW = new Date(ANCHOR_MS - 60_000).toISOString();

const LOGIN = "brief-owner";
const REPO = "okou-ai/okou";

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
 * The accepted catalog, with GitHub's `GET /user` route left unnamed.
 *
 * The connector already allows unknown requests, so the route stays allowed and
 * the collector still reads it — it simply resolves without a permission, which
 * is the production shape this suite is about. Every other GitHub route keeps
 * its permission, so the source still exercises named grants as well.
 */
function catalogWithUnnamedGithubUserRoute(): ConnectorCatalogArtifact {
  return {
    ...API_TEST_CONNECTOR_CATALOG,
    catalogVersion: `${API_TEST_CONNECTOR_CATALOG.catalogVersion}-github-unnamed-user`,
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
          defaultAllowed:
            connector.firewall.defaultAllowed?.filter((permission) => {
              return permission !== "user:read";
            }) ?? null,
          config: {
            ...connector.firewall.config,
            apis: connector.firewall.config.apis.map((api) => {
              return {
                ...api,
                permissions: (api.permissions ?? []).filter((permission) => {
                  return permission.name !== "user:read";
                }),
              };
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

/** GitHub answers every read the collector issues, with one open item. */
function stubGithub(): { readonly paths: () => readonly string[] } {
  const paths: string[] = [];
  const record = (payload: Record<string, unknown> | unknown[]) => {
    return ({ request }: { request: Request }) => {
      paths.push(new URL(request.url).pathname);
      return HttpResponse.json(payload);
    };
  };
  server.use(
    http.get(GITHUB_USER, record({ id: 4242, login: LOGIN })),
    http.get(GITHUB_NOTIFICATIONS, record([])),
    http.get(GITHUB_SEARCH, ({ request }) => {
      const url = new URL(request.url);
      paths.push(url.pathname);
      const assigned = (url.searchParams.get("q") ?? "").includes(
        `assignee:${LOGIN}`,
      );
      return HttpResponse.json({
        total_count: assigned ? 1 : 0,
        incomplete_results: false,
        items: assigned
          ? [
              {
                number: 1,
                title: "an open issue",
                state: "open",
                updated_at: IN_WINDOW,
                repository_url: `https://api.github.com/repos/${REPO}`,
                body: "body text",
                user: { login: "someone-else" },
              },
            ]
          : [],
      });
    }),
  );
  return {
    paths: () => {
      return paths;
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

describe("Morning Brief composition over a permissionless endpoint", () => {
  let objectStorage = new Map<string, Buffer>();

  beforeEach(async () => {
    mockNow(ANCHOR_MS + 30_000);
    objectStorage = new Map();
    stubObjectStorage(objectStorage);
    await installApiTestConnectorCatalog({
      catalog: catalogWithUnnamedGithubUserRoute(),
    });
  });

  afterEach(() => {
    clearMockNow();
  });

  it(
    "keeps a source whose read touched an endpoint allowed without a named permission",
    async () => {
      const fixture = await setupOwner(objectStorage);
      const github = stubGithub();

      const response = await compose(fixture);
      if (response.status !== 200 || response.body.result !== "composed") {
        throw new Error(
          `Expected a composed brief, received ${JSON.stringify(response.body)}`,
        );
      }
      const composition = response.body.composition;
      const source = composition.sources.find((entry) => {
        return entry.source === "github";
      });
      // The collection itself succeeded: GitHub answered every read, including
      // the one route that now resolves without a permission.
      expect(github.paths()).toContain("/user");
      expect(source?.requests).toBeGreaterThan(0);
      // Nothing about this owner's grants changed between the read and the
      // re-proof, so the source keeps what it collected instead of being
      // withdrawn and accounted for as a failed day.
      expect(source?.coverage).not.toBe("failed");
      expect(source?.items).toBeGreaterThan(0);

      const descriptor = composition.descriptors.find((entry) => {
        return entry.source === "github";
      });
      expect(descriptor?.contributed).toBeTruthy();
      // The permissionless endpoint is still named for the later per-URL
      // re-check: it has no grant behind it to narrow, so that decision is the
      // whole question for it.
      expect(descriptor?.endpoints).toContain(GITHUB_USER);
    },
    TEST_TIMEOUT_MS,
  );
});
