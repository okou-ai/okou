import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { morningBriefCompositionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-composition-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  barrierQueryBinds,
  barrierQueryText,
  withDatabaseTransactionBarrierFixture,
} from "../../../test-fixtures/account-erasure-subject";
import {
  clearMorningBriefInstructionsHead,
  holdMorningBriefMembershipLookup,
  pauseMorningBriefAutomation,
} from "../../../test-fixtures/morning-brief-collection";
import { installMorningBriefFixture } from "../../../test-fixtures/morning-brief-gmail-collection";
import { createDeferredPromise } from "../../utils";
import { morningBriefCompositionPreviewRoutes } from "../morning-brief-composition-preview";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
  mockGitHubConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createWorkflowsBddApi,
  mockGoogleCalendarConnectorOAuth,
} from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

/**
 * The source-independent composition, through the registered preview route.
 *
 * `route-registration.test.ts` pins this exact route entry inside `ROUTES`, so
 * every result here is a statement about the deployed endpoint rather than
 * about a look-alike slice. Composition is driven end to end: real admission,
 * real canonical state, real collectors and real provider boundaries doubled at
 * the network edge. Nothing below stubs an authorizer or re-implements the
 * orchestration it is asserting about.
 *
 * Three behaviors are under test and each one used to be wrong:
 *
 * - the attempt owns **one** absolute deadline, resolved before admission and
 *   sampled after every wait rather than once in the middle;
 * - every source job the attempt starts is **joined**, so one failure cannot
 *   hand the answer back while an authorized sibling is still reading;
 * - an outcome says what actually happened — a failed, partial or never-started
 *   source can never be reported as a quiet morning.
 */

const GMAIL_LIST_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_MESSAGE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId";
const CALENDAR_LIST_URL =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/:calendarId/events";
const SLACK_CONVERSATIONS_URL = "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const GITHUB_API_URL = "https://api.github.com/*";

/** The documented absolute phase and the cutoff that sits inside it. */
const COLLECTION_PHASE_MS = 45_000;
const NEW_READ_CUTOFF_MS = 40_000;

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);
const workflowBdd = createWorkflowsBddApi(context);

afterEach(() => {
  clearMockNow();
});

function composeClient(signal?: AbortSignal) {
  return setupApp({
    context,
    routes: morningBriefCompositionPreviewRoutes,
    ...(signal === undefined ? {} : { signal, rethrowErrors: true }),
  })(morningBriefCompositionPreviewContract);
}

interface Fixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly agentId: string;
  readonly workflowId: string;
  readonly automationId: string;
  readonly membershipId: string;
}

/**
 * An owner with an installed, enabled Morning Brief and the switch on.
 *
 * `gmail` decides whether the member also has a usable selected Gmail
 * connection, which is the difference between a source that reads a provider
 * and a source that never had one to read.
 */
interface OwnerSourceOptions {
  readonly gmail?: boolean;
  readonly calendar?: boolean;
  readonly github?: boolean;
  readonly slack?: boolean;
}

async function setupOwner(options: OwnerSourceOptions = {}): Promise<Fixture> {
  const { actor } = await workflowBdd.setupWorkflowOrg({
    timezone: "Asia/Shanghai",
  });
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  const onboarding = await bdd.readOnboardingStatus(actor);
  if (!onboarding.defaultAgentId) {
    throw new Error("Expected a default Agent");
  }
  const agentId = onboarding.defaultAgentId;
  const connectorSlugs: string[] = [];
  if (options.gmail === true) {
    await connectGmail(actor, agentId);
    connectorSlugs.push("gmail");
    // Message bodies are not allowed by default, so a working Gmail read needs
    // the real grant rather than a relaxed authorizer.
    await runsApi.applyUserPermissionGrant(actor, {
      agentId,
      connectorSlug: "gmail",
      permission: "messages.detail",
      action: "allow",
    });
  }
  if (options.calendar === true) {
    await connectCalendar(actor, agentId);
    connectorSlugs.push("google-calendar");
  }
  if (options.github === true) {
    await connectGithub(actor, agentId);
    connectorSlugs.push("github");
  }
  if (connectorSlugs.length > 0) {
    await runsApi.enableAgentConnectors(actor, agentId, connectorSlugs);
  }
  const installation = await installMorningBriefFixture(
    { orgId: actor.orgId, userId: actor.userId },
    { agentId },
  );
  if (options.slack === true) {
    const slack = await store.set(
      seedSlackOrgInstallation$,
      { orgId: actor.orgId, botToken: `xoxb-test-${randomUUID()}` },
      context.signal,
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: slack.slackWorkspaceId, userId: actor.userId },
      context.signal,
    );
  }
  await updateFeatureSwitchesForUser(
    context,
    { orgId: actor.orgId, userId: actor.userId },
    { [FeatureSwitchKey.SimpleMorningBrief]: true },
  );
  return {
    actor: { ...actor, orgId: actor.orgId },
    agentId,
    workflowId: installation.workflowId,
    automationId: installation.automationId,
    membershipId: `orgmem_${randomUUID()}`,
  };
}

async function connectGmail(
  actor: ApiTestUser,
  agentId: string,
): Promise<void> {
  const subject = `gmail-${randomUUID()}`;
  mockGmailConnectorOAuth({
    accessToken: "gmail-access-token",
    email: "owner@example.test",
    subject,
  });
  const start = await connectorsApi.startOauth(
    actor,
    "gmail",
    "oauth",
    agentId,
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected a Gmail OAuth state");
  }
  await connectorsApi.completeOauthCallback("gmail", {
    code: `gmail-code-${subject}`,
    state,
  });
}

async function connectCalendar(
  actor: ApiTestUser,
  agentId: string,
): Promise<void> {
  const subject = `calendar-${randomUUID()}`;
  mockGoogleCalendarConnectorOAuth({
    accessToken: "calendar-access-token",
    email: "owner@example.test",
    subject,
  });
  const start = await connectorsApi.startOauth(
    actor,
    "google-calendar",
    "oauth",
    agentId,
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected a Calendar OAuth state");
  }
  await connectorsApi.completeOauthCallback("google-calendar", {
    code: `calendar-code-${subject}`,
    state,
  });
}

async function connectGithub(
  actor: ApiTestUser,
  agentId: string,
): Promise<void> {
  const suffix = randomUUID();
  mockGitHubConnectorOAuth({
    userId: 424_242,
    login: `owner-${suffix}`,
  });
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
    code: `github-code-${suffix}`,
    state,
  });
}

/**
 * Reseed the membership generation this attempt runs under.
 *
 * The shared BDD helpers reinstall their own Clerk membership mocks while
 * setting an organization up, so the request has to pin the generation it is
 * asserting about.
 */
async function seedMembership(fixture: Fixture): Promise<void> {
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
}

function authHeaders(fixture: Fixture) {
  mocks.clerk.session(
    fixture.actor.userId,
    fixture.actor.orgId,
    fixture.actor.orgRole,
  );
  return { authorization: "Bearer clerk-session" } as const;
}

/** Issue one composition through the deployed route slice. */
async function compose(
  fixture: Fixture,
  body: { readonly anchor: string; readonly deadlineAt?: string },
) {
  const response = await accept(startCompose(fixture, body), [200]);
  return response.body;
}

/**
 * Start one composition without awaiting it, for held-boundary cases.
 *
 * The membership generation is seeded by the caller before any hold is
 * installed, because seeding reinstalls the Clerk mocks a hold wraps.
 */
function startCompose(
  fixture: Fixture,
  body: { readonly anchor: string; readonly deadlineAt?: string },
) {
  return composeClient().compose({ headers: authHeaders(fixture), body });
}

interface GmailStub {
  /** Every provider request the composition actually issued. */
  readonly calls: string[];
  readonly firstList: Promise<void>;
  readonly firstDetail: Promise<void>;
}

/** One inline plain-text message, exactly as Gmail nests it. */
function messagePayload(id: string, internalDate: number) {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(internalDate),
    labelIds: ["INBOX", "UNREAD"],
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Subject", value: `Subject ${id}` },
        { name: "From", value: "sender@example.test" },
        { name: "To", value: "owner@example.test" },
        { name: "Date", value: new Date(internalDate).toUTCString() },
      ],
      parts: [
        {
          mimeType: "text/plain",
          body: { data: Buffer.from(`Body ${id}`).toString("base64url") },
        },
      ],
    },
  };
}

/**
 * Double Gmail at the network edge.
 *
 * `hold` suspends every list response until the test releases it, which is how
 * a wait inside the collection phase is observed at a known arrival point
 * instead of after a sleep. `status` makes the provider refuse instead.
 */
function stubGmail(
  args: {
    readonly messages?: readonly { readonly id: string; readonly at: number }[];
    readonly hold?: Promise<void>;
    readonly holdDetails?: Promise<void>;
    readonly status?: number;
  } = {},
): GmailStub {
  const calls: string[] = [];
  const arrived = createDeferredPromise<void>(context.signal);
  const detailArrived = createDeferredPromise<void>(context.signal);
  const byId = new Map(
    (args.messages ?? []).map((message) => {
      return [message.id, message];
    }),
  );
  server.use(
    http.get(GMAIL_LIST_URL, async ({ request }) => {
      calls.push(new URL(request.url).pathname);
      if (!arrived.settled()) {
        arrived.resolve();
      }
      if (args.hold) {
        await args.hold;
      }
      if (args.status !== undefined) {
        return HttpResponse.json(
          { error: { code: args.status } },
          { status: args.status },
        );
      }
      return HttpResponse.json({
        messages: [...byId.values()].map((message) => {
          return { id: message.id, threadId: `thread-${message.id}` };
        }),
      });
    }),
    http.get(GMAIL_MESSAGE_URL, async ({ request, params }) => {
      calls.push(new URL(request.url).pathname);
      if (!detailArrived.settled()) {
        detailArrived.resolve();
      }
      if (args.holdDetails) {
        await args.holdDetails;
      }
      const message = byId.get(String(params["messageId"]));
      if (!message) {
        return HttpResponse.json({ error: { code: 404 } }, { status: 404 });
      }
      return HttpResponse.json(messagePayload(message.id, message.at));
    }),
  );
  return {
    calls,
    firstList: arrived.promise,
    firstDetail: detailArrived.promise,
  };
}

interface CompositionSlackTraffic {
  /** Every provider request the Slack collector actually issued. */
  readonly requests: string[];
}

/**
 * Double Slack at its real HTTP boundary and record every issued request.
 *
 * The response functions keep classified failures, successful empties and
 * partial reads on the same production client path.
 */
function stubCompositionSlack(args: {
  readonly channels: () => Response;
  readonly history?: () => Response;
}): CompositionSlackTraffic {
  const requests: string[] = [];
  server.use(
    http.get(SLACK_CONVERSATIONS_URL, ({ request }) => {
      requests.push(new URL(request.url).pathname);
      return args.channels();
    }),
    http.get(SLACK_HISTORY_URL, ({ request }) => {
      requests.push(new URL(request.url).pathname);
      return args.history?.() ?? HttpResponse.json({ ok: true, messages: [] });
    }),
  );
  return { requests };
}

/** One real Slack item, including the collector's final release proof. */
function stubSlackMessage(
  at: number,
  onCollectionProved: () => void = () => {},
): void {
  let enumerations = 0;
  server.use(
    http.get(SLACK_CONVERSATIONS_URL, () => {
      enumerations += 1;
      // With one retained channel, discovery, protected-read admission and the
      // collector's release proof are three canonical enumerations.
      if (enumerations === 3) {
        onCollectionProved();
      }
      return HttpResponse.json({
        ok: true,
        channels: [{ id: "C1", name: "general", is_private: false }],
      });
    }),
    http.get(SLACK_HISTORY_URL, () => {
      return HttpResponse.json({
        ok: true,
        has_more: false,
        messages: [
          {
            type: "message",
            ts: `${String(Math.floor((at - 2 * 60 * 60 * 1000) / 1000))}.000100`,
            user: "U2",
            text: "Morning update",
          },
        ],
      });
    }),
  );
}

interface TestObjectStorageCommand {
  readonly input?: {
    readonly Bucket?: string;
    readonly Key?: string;
    readonly Prefix?: string;
    readonly Body?: unknown;
    readonly Delete?: {
      readonly Objects?: readonly { readonly Key?: string }[];
    };
  };
}

/**
 * An object store that round-trips the canonical instruction publisher and
 * exposes the archive download as an observable post-collection boundary.
 */
function stubInstructionStorage(onArchiveRead: () => void): void {
  const objects = new Map<string, Buffer>();
  const keyOf = (command: TestObjectStorageCommand): string => {
    return `${command.input?.Bucket ?? ""}/${command.input?.Key ?? ""}`;
  };
  const handlers: Record<
    string,
    (command: TestObjectStorageCommand) => Promise<unknown>
  > = {
    PutObjectCommand: (command) => {
      const body = command.input?.Body;
      if (!(typeof body === "string" || body instanceof Uint8Array)) {
        throw new Error("Expected an instruction object body");
      }
      objects.set(keyOf(command), Buffer.from(body));
      return Promise.resolve({});
    },
    HeadObjectCommand: (command) => {
      const stored = objects.get(keyOf(command));
      return stored === undefined
        ? Promise.reject(
            Object.assign(new Error("NotFound"), { name: "NotFound" }),
          )
        : Promise.resolve({ ContentLength: stored.length });
    },
    GetObjectCommand: (command) => {
      const key = keyOf(command);
      const stored = objects.get(key);
      if (stored === undefined) {
        return Promise.reject(
          Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }),
        );
      }
      if (key.endsWith("/archive.tar.gz")) {
        onArchiveRead();
      }
      return Promise.resolve({
        Body: Readable.from([stored]),
        ContentLength: stored.length,
      });
    },
    ListObjectsV2Command: (command) => {
      const bucket = `${command.input?.Bucket ?? ""}/`;
      const prefix = `${bucket}${command.input?.Prefix ?? ""}`;
      return Promise.resolve({
        Contents: [...objects]
          .filter(([storedKey]) => {
            return storedKey.startsWith(prefix);
          })
          .map(([storedKey, body]) => {
            return {
              Key: storedKey.slice(bucket.length),
              Size: body.length,
              LastModified: new Date(now()),
            };
          }),
      });
    },
    DeleteObjectsCommand: (command) => {
      for (const object of command.input?.Delete?.Objects ?? []) {
        if (object.Key !== undefined) {
          objects.delete(`${command.input?.Bucket ?? ""}/${object.Key}`);
        }
      }
      return Promise.resolve({});
    },
  };
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    if (typeof command !== "object" || command === null) {
      return Promise.resolve({});
    }
    const handler = handlers[command.constructor.name];
    return (
      handler?.(command as TestObjectStorageCommand) ?? Promise.resolve({})
    );
  });
}

/** The coverage this composition reported for one source. */
function coverageOf(
  composition: {
    readonly sources: readonly { source: string; coverage: string }[];
  },
  source: string,
): string | undefined {
  return composition.sources.find((entry) => {
    return entry.source === source;
  })?.coverage;
}

/**
 * Hold the first real provider boundary of each first-wave source.
 *
 * Active counts provider boundaries that correspond one-to-one with Calendar,
 * Gmail and GitHub source jobs. Later provider fan-out is deliberately not
 * counted as another source job.
 */
function holdFirstWaveProviders(release: Promise<void>) {
  const arrived = createDeferredPromise<void>(context.signal);
  const cancelled = createDeferredPromise<void>(context.signal);
  let active = 0;
  let maximum = 0;
  let aborted = 0;
  let slackCalls = 0;

  const hold = async (request: Request): Promise<void> => {
    active += 1;
    maximum = Math.max(maximum, active);
    if (active === 3 && !arrived.settled()) {
      arrived.resolve();
    }
    request.signal.addEventListener(
      "abort",
      () => {
        aborted += 1;
        if (aborted === 3 && !cancelled.settled()) {
          cancelled.resolve();
        }
      },
      { once: true },
    );
    await release;
    active -= 1;
  };

  server.use(
    http.get(CALENDAR_LIST_URL, async ({ request }) => {
      await hold(request);
      return HttpResponse.json({ items: [] });
    }),
    http.get(GMAIL_LIST_URL, async ({ request }) => {
      await hold(request);
      return HttpResponse.json({ messages: [] });
    }),
    http.get(GITHUB_API_URL, async ({ request }) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/user") {
        await hold(request);
        return HttpResponse.json({ id: 424_242, login: "owner" });
      }
      if (pathname === "/search/issues") {
        return HttpResponse.json({
          total_count: 0,
          incomplete_results: false,
          items: [],
        });
      }
      return HttpResponse.json([]);
    }),
    http.get(SLACK_CONVERSATIONS_URL, () => {
      slackCalls += 1;
      return HttpResponse.json({ ok: true, channels: [] });
    }),
  );

  return {
    arrived: arrived.promise,
    cancelled: cancelled.promise,
    active: () => {
      return active;
    },
    maximum: () => {
      return maximum;
    },
    slackCalls: () => {
      return slackCalls;
    },
  };
}

describe("POST /api/morning-brief/collection-preview/compose", () => {
  /** A second-aligned anchor an hour behind the frozen clock. */
  function anchorFor(at: number): string {
    return new Date(
      Math.floor((at - 60 * 60 * 1000) / 1000) * 1000,
    ).toISOString();
  }

  /** Freeze the service clock so the attempt's own deadline is exact. */
  function freezeClock(): number {
    const at = Math.floor(now() / 1000) * 1000;
    mockNow(at);
    return at;
  }

  /**
   * An owner whose composition can reach a model request.
   *
   * Setup writes rows and connects accounts through the product APIs, and both
   * touch object storage, so the storage double is cleared here: every later
   * assertion about language I/O is about this attempt, not about its fixture.
   */
  async function readyOwner(
    options: OwnerSourceOptions = {},
  ): Promise<Fixture> {
    const fixture = await setupOwner(options);
    await clearMorningBriefInstructionsHead(fixture.agentId);
    await seedMembership(fixture);
    context.mocks.s3.send.mockClear();
    return fixture;
  }

  it("does not exist in production, even with the switch on", async () => {
    const fixture = await readyOwner();
    mockEnv("ENV", "production");

    const response = await composeClient().compose({
      headers: authHeaders(fixture),
      body: { anchor: new Date(now()).toISOString() },
    });

    expect(response.status).toBe(404);
  });

  it("settles as empty only when every applicable source answered", async () => {
    const fixture = await readyOwner();
    const at = freezeClock();

    const body = await compose(fixture, { anchor: anchorFor(at) });

    expect(body.result).toBe("empty");
    if (body.result !== "empty") {
      return;
    }
    // An owner who connected nothing has no evidence to lose, and Chat's own
    // read answered. Every source is accounted for, none of them silently.
    expect(
      body.composition.sources.map(({ source, coverage, items, requests }) => {
        return { source, coverage, items, requests };
      }),
    ).toStrictEqual([
      { source: "calendar", coverage: "unconfigured", items: 0, requests: 0 },
      { source: "gmail", coverage: "unconfigured", items: 0, requests: 0 },
      { source: "github", coverage: "unconfigured", items: 0, requests: 0 },
      { source: "chat", coverage: "empty", items: 0, requests: 0 },
    ]);
    expect(body.composition.request).toBeNull();
    // A brief nobody will write needs no language, so nothing was read for one.
    expect(body.composition.language).toBeNull();
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("reports the exact issued Slack request count after a classified failure", async () => {
    const fixture = await readyOwner({ slack: true });
    const at = freezeClock();
    const slack = stubCompositionSlack({
      channels: () => {
        return HttpResponse.json(
          { ok: false, error: "ratelimited" },
          { status: 429, headers: { "retry-after": "30" } },
        );
      },
    });

    const body = await compose(fixture, { anchor: anchorFor(at) });

    expect(slack.requests).toStrictEqual(["/api/users.conversations"]);
    expect(body.result).toBe("incomplete");
    if (body.result !== "incomplete") {
      return;
    }
    expect(body.reason).toBe("incomplete-coverage");
    expect(
      body.sources.find((source) => {
        return source.source === "slack";
      }),
    ).toMatchObject({ coverage: "failed", requests: slack.requests.length });
  });

  it("keeps a successful Slack collector's exact request count", async () => {
    const fixture = await readyOwner({ slack: true });
    const at = freezeClock();
    const slack = stubCompositionSlack({
      channels: () => {
        return HttpResponse.json({ ok: true, channels: [] });
      },
    });

    const body = await compose(fixture, { anchor: anchorFor(at) });

    expect(slack.requests).toStrictEqual(["/api/users.conversations"]);
    expect(body.result).toBe("empty");
    if (body.result !== "empty") {
      return;
    }
    expect(
      body.composition.sources.find((source) => {
        return source.source === "slack";
      }),
    ).toMatchObject({ coverage: "empty", requests: slack.requests.length });
  });

  it("keeps a partial Slack collector's exact request count", async () => {
    const fixture = await readyOwner({ slack: true });
    const at = freezeClock();
    const slack = stubCompositionSlack({
      channels: () => {
        return HttpResponse.json({
          ok: true,
          channels: [{ id: "C1", name: "general", is_private: false }],
        });
      },
      history: () => {
        return HttpResponse.json({ ok: true, messages: [], has_more: true });
      },
    });

    const body = await compose(fixture, { anchor: anchorFor(at) });

    expect(slack.requests).toStrictEqual([
      "/api/users.conversations",
      "/api/users.conversations",
      "/api/conversations.history",
      "/api/users.conversations",
    ]);
    expect(body.result).toBe("incomplete");
    if (body.result !== "incomplete") {
      return;
    }
    expect(body.reason).toBe("incomplete-coverage");
    expect(
      body.sources.find((source) => {
        return source.source === "slack";
      }),
    ).toMatchObject({ coverage: "partial", requests: slack.requests.length });
  });

  it("refuses to call a failed read a quiet morning", async () => {
    const fixture = await readyOwner({ gmail: true });
    const at = freezeClock();
    const gmail = stubGmail({ status: 500 });

    const body = await compose(fixture, { anchor: anchorFor(at) });

    expect(body.result).toBe("incomplete");
    if (body.result !== "incomplete") {
      return;
    }
    expect(body.reason).toBe("incomplete-coverage");
    expect(body.detail).toContain("gmail=failed");
    expect(gmail.calls.length).toBeGreaterThan(0);
    // The failure is reported before any language work, not after it.
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("separates every source failing from a source the owner lacks", async () => {
    const fixture = await readyOwner({ gmail: true });
    const at = freezeClock();
    const held = createDeferredPromise<void>(context.signal);
    const gmail = stubGmail({ status: 500, hold: held.promise });
    const pending = startCompose(fixture, { anchor: anchorFor(at) });

    await gmail.firstList;
    // Disabling the brief mid-attempt is the real Settings mutation that leaves
    // Chat with no installation to read, so now every source that could have
    // answered has failed.
    await pauseMorningBriefAutomation(fixture.automationId);
    held.resolve();
    const response = await accept(pending, [200]);

    expect(response.body.result).toBe("incomplete");
    if (response.body.result !== "incomplete") {
      return;
    }
    expect(response.body.reason).toBe("all-sources-failed");
    expect(response.body.detail).toContain("gmail=failed");
    expect(response.body.detail).toContain("chat=failed");
  });

  it("composes a request from the sources that did answer", async () => {
    const fixture = await readyOwner({ gmail: true });
    const at = freezeClock();
    stubGmail({ messages: [{ id: "m-1", at: at - 30 * 60 * 1000 }] });

    const body = await compose(fixture, { anchor: anchorFor(at) });

    expect(body.result).toBe("composed");
    if (body.result !== "composed") {
      return;
    }
    expect(coverageOf(body.composition, "gmail")).toBe("complete");
    expect(coverageOf(body.composition, "github")).toBe("unconfigured");
    expect(body.composition.request?.items).toBeGreaterThan(0);
    expect(body.composition.deadline.source).toBe("phase");
    expect(body.composition.deadline.deadlineAt).toBe(
      new Date(at + COLLECTION_PHASE_MS).toISOString(),
    );
  });

  it("keeps a source the cutoff never admitted in the report", async () => {
    const fixture = await readyOwner({ gmail: true });
    const at = freezeClock();
    const held = createDeferredPromise<void>(context.signal);
    const gmail = stubGmail({ hold: held.promise });
    const pending = startCompose(fixture, { anchor: anchorFor(at) });

    await gmail.firstList;
    // Past the 40-second cutoff and still inside the 45-second phase: the first
    // wave may finish, and nothing new may start.
    mockNow(at + NEW_READ_CUTOFF_MS + 1000);
    held.resolve();
    const response = await accept(pending, [200]);

    expect(response.body.result).toBe("incomplete");
    if (response.body.result !== "incomplete") {
      return;
    }
    // Chat never ran, and Gmail's held read could not finish inside its own
    // budget. Both facts survive into the report: an exhausted attempt must not
    // look like an owner whose Chat was quiet and whose mail was read.
    expect(
      response.body.sources.map(({ source, coverage, items, requests }) => {
        return { source, coverage, items, requests };
      }),
    ).toStrictEqual([
      { source: "calendar", coverage: "unconfigured", items: 0, requests: 0 },
      { source: "gmail", coverage: "failed", items: 0, requests: 0 },
      { source: "github", coverage: "unconfigured", items: 0, requests: 0 },
      { source: "chat", coverage: "not-started", items: 0, requests: 0 },
    ]);
  });

  it("will not call an exhausted collection a quiet morning", async () => {
    const fixture = await readyOwner({ gmail: true });
    const at = freezeClock();
    const held = createDeferredPromise<void>(context.signal);
    const gmail = stubGmail({ hold: held.promise });
    const pending = startCompose(fixture, { anchor: anchorFor(at) });

    await gmail.firstList;
    mockNow(at + NEW_READ_CUTOFF_MS + 1000);
    held.resolve();
    const response = await accept(pending, [200]);

    // Nothing contributed, and Chat never ran, so this attempt does not know
    // what the owner's morning held.
    expect(response.body.result).toBe("incomplete");
    if (response.body.result !== "incomplete") {
      return;
    }
    expect(response.body.reason).toBe("incomplete-coverage");
    expect(response.body.detail).toContain("chat=not-started");
    expect(context.mocks.s3.send).not.toHaveBeenCalled();
  });

  it("starts no source once admission alone has spent the phase", async () => {
    const fixture = await readyOwner({ gmail: true });
    const at = freezeClock();
    const gmail = stubGmail({ messages: [{ id: "m-1", at: at - 60_000 }] });
    const membership = holdMorningBriefMembershipLookup(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      context.signal,
    );
    const pending = startCompose(fixture, { anchor: anchorFor(at) });

    await membership.waitForArrival();
    // Admission itself spent the phase. No provider may be read afterwards.
    mockNow(at + COLLECTION_PHASE_MS + 1000);
    membership.release();
    const response = await accept(pending, [200]);

    expect(response.body.result).toBe("incomplete");
    if (response.body.result !== "incomplete") {
      return;
    }
    expect(response.body.reason).toBe("deadline-exceeded");
    expect(response.body.detail).toContain("admission");
    expect(gmail.calls).toStrictEqual([]);
  });

  it.each([
    { name: "one millisecond before", offset: -1, expired: false },
    { name: "at", offset: 0, expired: true },
    { name: "after", offset: 1, expired: true },
  ])(
    "decides a held admission wait $name the deadline",
    async ({ offset, expired }) => {
      const fixture = await readyOwner({ gmail: true });
      const at = freezeClock();
      const gmail = stubGmail({ messages: [{ id: "m-1", at: at - 60_000 }] });
      const membership = holdMorningBriefMembershipLookup(
        { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
        context.signal,
      );
      const pending = startCompose(fixture, { anchor: anchorFor(at) });

      await membership.waitForArrival();
      mockNow(at + COLLECTION_PHASE_MS + offset);
      membership.release();
      const response = await accept(pending, [200]);

      // Equality is expired, and one millisecond short of it is not. The
      // before-boundary attempt still runs to an answer of its own — it has no
      // budget left to read a provider with, which is a different fact from
      // having run out of time entirely.
      expect(response.body.result).toBe("incomplete");
      if (response.body.result !== "incomplete") {
        return;
      }
      expect(response.body.reason === "deadline-exceeded").toBe(expired);
      if (expired) {
        expect(response.body.detail).toContain("admission");
      }
      // Nothing is read on either side of the boundary once admission alone
      // has spent the phase.
      expect(gmail.calls).toStrictEqual([]);
    },
  );

  it.each([
    { name: "one millisecond before", offset: -1, expired: false },
    { name: "at", offset: 0, expired: true },
    { name: "after", offset: 1, expired: true },
  ])(
    "decides a held source body $name the absolute deadline",
    async ({ offset, expired }) => {
      const fixture = await readyOwner({ gmail: true });
      const at = freezeClock();
      const deadlineAt = at + 10_000;
      const heldBody = createDeferredPromise<void>(context.signal);
      const gmail = stubGmail({
        messages: [{ id: "m-1", at: at - 30 * 60 * 1000 }],
        holdDetails: heldBody.promise,
      });
      const pending = startCompose(fixture, {
        anchor: anchorFor(at),
        deadlineAt: new Date(deadlineAt).toISOString(),
      });

      await gmail.firstDetail;
      mockNow(deadlineAt + offset);
      heldBody.resolve();
      const response = await accept(pending, [200]);

      if (!expired) {
        if (response.body.result === "incomplete") {
          // One millisecond remains at the source boundary. Later bounded work
          // may consume it, but this source-body sample itself is not expired.
          expect(response.body.reason).not.toBe("deadline-exceeded");
        }
        return;
      }
      expect(response.body.result).toBe("incomplete");
      if (response.body.result !== "incomplete") {
        return;
      }
      expect(response.body.reason).toBe("deadline-exceeded");
      // The source body answered before the public outcome was classified, so
      // the expiry carries the known source facts instead of erasing them.
      expect(response.body.sources.length).toBeGreaterThan(0);
      expect(
        response.body.sources.some((source) => {
          return source.source === "gmail";
        }),
      ).toBeTruthy();
    },
  );

  it.each([
    { name: "before", offset: -1000, expired: false },
    { name: "at", offset: 0, expired: true },
    { name: "after", offset: 1, expired: true },
  ])(
    "decides the held final authority read $name the deadline",
    async ({ offset, expired }) => {
      const fixture = await setupOwner({ slack: true });
      const at = freezeClock();
      const deadlineAt = at + 10_000;
      const initialAuthorityReady = createDeferredPromise<
        ReturnType<typeof holdMorningBriefMembershipLookup>
      >(context.signal);
      let installed = false;
      stubInstructionStorage(() => {
        if (installed) {
          return;
        }
        installed = true;
        // The archive download occurs only after all source jobs have settled.
        // This first hold therefore targets retained proof admission without a
        // Clerk call ordinal.
        initialAuthorityReady.resolve(
          holdMorningBriefMembershipLookup(
            { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
            context.signal,
          ),
        );
      });
      await bdd.updateAgentInstructions(
        fixture.actor,
        fixture.agentId,
        "Write in Polish.",
      );
      await seedMembership(fixture);
      // Advance only after the source's own release proof. Language and the
      // retained phase then share the four seconds left before the tighter
      // outer reservation, without denying source admission at the cutoff.
      stubSlackMessage(at, () => {
        mockNow(at + 6000);
      });
      const pending = startCompose(fixture, {
        anchor: anchorFor(at),
        deadlineAt: new Date(deadlineAt).toISOString(),
      });

      const initialAuthority = await initialAuthorityReady.promise;
      await initialAuthority.waitForArrival();
      // Slack's retained proof has no Clerk membership lookup of its own. By
      // installing the next exact lookup before releasing admission, this hold
      // can only be the final owner proof after the remote source re-proof.
      const finalAuthority = holdMorningBriefMembershipLookup(
        { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
        context.signal,
      );
      initialAuthority.release();
      await finalAuthority.waitForArrival();
      mockNow(deadlineAt + offset);
      finalAuthority.release();
      const response = await accept(pending, [200]);

      if (!expired) {
        expect(response.body.result).toBe("composed");
        if (response.body.result === "composed") {
          expect(
            response.body.composition.language?.instructions,
          ).toMatchObject({ state: "available" });
        }
        return;
      }
      expect(response.body.result).toBe("incomplete");
      if (response.body.result !== "incomplete") {
        return;
      }
      expect(response.body.reason).toBe("deadline-exceeded");
      expect(response.body.detail).toContain("final authority check");
      expect(response.body.sources.length).toBeGreaterThan(0);
    },
  );

  it.each([
    { name: "one millisecond before", offset: -1, expired: false },
    { name: "at", offset: 0, expired: true },
    { name: "after", offset: 1, expired: true },
  ])(
    "decides the held canonical instruction version read $name the deadline",
    async ({ offset, expired }) => {
      const otherOwner = await setupOwner();
      const fixture = await setupOwner({ slack: true });
      const at = freezeClock();
      const deadlineAt = at + 10_000;
      const initialAuthorityReady = createDeferredPromise<
        ReturnType<typeof holdMorningBriefMembershipLookup>
      >(context.signal);
      let installed = false;
      stubInstructionStorage(() => {
        if (installed) {
          return;
        }
        installed = true;
        initialAuthorityReady.resolve(
          holdMorningBriefMembershipLookup(
            { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
            context.signal,
          ),
        );
      });
      await bdd.updateAgentInstructions(
        fixture.actor,
        fixture.agentId,
        "Write in Polish.",
      );
      await seedMembership(fixture);
      stubSlackMessage(at);
      let awaitingVersionRead = false;
      const response = await withDatabaseTransactionBarrierFixture(
        {
          select: (queryArgs) => {
            const text = barrierQueryText(queryArgs);
            return (
              awaitingVersionRead &&
              text.startsWith('select "head_version_id"') &&
              text.includes('from "storages"') &&
              barrierQueryBinds(queryArgs, fixture.actor.orgId)
            );
          },
          stopAt: (_queryArgs, selectingStatement) => {
            return selectingStatement;
          },
          pauseAfter: true,
          work: async (versionRead) => {
            const pending = startCompose(fixture, {
              anchor: anchorFor(at),
              deadlineAt: new Date(deadlineAt).toISOString(),
            });
            const initialAuthority = await initialAuthorityReady.promise;
            await initialAuthority.waitForArrival();
            const finalAuthority = holdMorningBriefMembershipLookup(
              { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
              context.signal,
            );
            initialAuthority.release();
            await finalAuthority.waitForArrival();
            awaitingVersionRead = true;
            // An unrelated storage operation must neither satisfy the target
            // boundary nor wait on a table-wide lock held by this test.
            await bdd.updateAgentInstructions(
              otherOwner.actor,
              otherOwner.agentId,
              "Write in English.",
            );
            expect(versionRead.enteredYet()).toBeFalsy();
            finalAuthority.release();
            await versionRead.entered;
            mockNow(deadlineAt + offset);
            versionRead.release();
            return await accept(pending, [200]);
          },
        },
        context.signal,
      );

      if (!expired) {
        expect(response.body.result).toBe("composed");
        return;
      }
      expect(response.body.result).toBe("incomplete");
      if (response.body.result !== "incomplete") {
        return;
      }
      expect(response.body.reason).toBe("deadline-exceeded");
      expect(response.body.detail).toContain("instruction version check");
      expect(response.body.sources.length).toBeGreaterThan(0);
    },
  );

  it("takes the caller's deadline when it is tighter than the phase", async () => {
    const fixture = await readyOwner({ gmail: true });
    const at = freezeClock();
    stubGmail({ messages: [{ id: "m-1", at: at - 30 * 60 * 1000 }] });
    const callerDeadline = new Date(at + 20_000).toISOString();

    const body = await compose(fixture, {
      anchor: anchorFor(at),
      deadlineAt: callerDeadline,
    });

    expect(body.result).toBe("composed");
    if (body.result !== "composed") {
      return;
    }
    expect(body.composition.deadline.source).toBe("caller");
    expect(body.composition.deadline.deadlineAt).toBe(callerDeadline);
  });

  it("cannot be handed a deadline looser than its own phase", async () => {
    const fixture = await readyOwner({ gmail: true });
    const at = freezeClock();
    stubGmail({ messages: [{ id: "m-1", at: at - 30 * 60 * 1000 }] });

    const body = await compose(fixture, {
      anchor: anchorFor(at),
      deadlineAt: new Date(at + 10 * COLLECTION_PHASE_MS).toISOString(),
    });

    expect(body.result).toBe("composed");
    if (body.result !== "composed") {
      return;
    }
    expect(body.composition.deadline.source).toBe("phase");
    expect(body.composition.deadline.deadlineAt).toBe(
      new Date(at + COLLECTION_PHASE_MS).toISOString(),
    );
  });

  it("consumes a caller deadline that actually cuts the attempt off", async () => {
    const fixture = await readyOwner();
    const at = freezeClock();
    const callerDeadline = at + 5000;
    const membership = holdMorningBriefMembershipLookup(
      { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
      context.signal,
    );
    const pending = startCompose(fixture, {
      anchor: anchorFor(at),
      deadlineAt: new Date(callerDeadline).toISOString(),
    });

    await membership.waitForArrival();
    // Past the caller's budget and far inside the 45-second phase, which alone
    // would have let this attempt keep going.
    mockNow(callerDeadline + 1);
    membership.release();
    const response = await accept(pending, [200]);

    expect(response.body.result).toBe("incomplete");
    if (response.body.result !== "incomplete") {
      return;
    }
    expect(response.body.reason).toBe("deadline-exceeded");
    expect(response.body.detail).toContain(
      new Date(callerDeadline).toISOString(),
    );
  });

  it("reports rejected-source request spend as unknown", async () => {
    const fixture = await readyOwner({ gmail: true });
    const at = freezeClock();
    const held = createDeferredPromise<void>(context.signal);
    // Gmail never answers, so its source deadline rejects the job after at
    // least one real provider request has started. Its exact spend is no longer
    // available at the rejection boundary and must not be fabricated as zero.
    const gmail = stubGmail({ hold: held.promise });
    const pending = startCompose(fixture, {
      anchor: anchorFor(at),
      deadlineAt: new Date(at + 1500).toISOString(),
    });

    const response = await accept(pending, [200]);
    held.resolve();

    expect(gmail.calls.length).toBeGreaterThan(0);
    expect(response.body.result).toBe("incomplete");
    if (response.body.result !== "incomplete") {
      return;
    }
    expect(response.body.detail).toContain("gmail=failed");
    expect(
      response.body.sources.find((source) => {
        return source.source === "gmail";
      })?.requests,
    ).toBeNull();
  });

  it("joins a failed source with a held useful sibling before answering", async () => {
    const fixture = await readyOwner({ gmail: true, calendar: true });
    const at = freezeClock();
    const calendarArrived = createDeferredPromise<void>(context.signal);
    const releaseCalendar = createDeferredPromise<void>(context.signal);
    stubGmail({ status: 500 });
    server.use(
      http.get(CALENDAR_LIST_URL, () => {
        return HttpResponse.json({
          items: [
            {
              id: "owner@example.test",
              accessRole: "owner",
              primary: true,
              timeZone: "Asia/Shanghai",
            },
          ],
        });
      }),
      http.get(CALENDAR_EVENTS_URL, async () => {
        calendarArrived.resolve();
        await releaseCalendar.promise;
        return HttpResponse.json({
          items: [
            {
              id: "event-1",
              status: "confirmed",
              summary: "Useful calendar sibling",
              start: { dateTime: new Date(at - 30 * 60 * 1000).toISOString() },
              end: { dateTime: new Date(at - 15 * 60 * 1000).toISOString() },
            },
          ],
        });
      }),
    );
    let publiclySettled = false;
    const pending = startCompose(fixture, { anchor: anchorFor(at) }).finally(
      () => {
        publiclySettled = true;
      },
    );

    await calendarArrived.promise;
    await Promise.resolve();
    expect(publiclySettled).toBeFalsy();
    releaseCalendar.resolve();
    const response = await accept(pending, [200]);

    expect(response.body.result).toBe("composed");
    if (response.body.result !== "composed") {
      return;
    }
    expect(coverageOf(response.body.composition, "calendar")).toBe("complete");
    expect(coverageOf(response.body.composition, "gmail")).toBe("failed");
    expect(response.body.composition.request?.items).toBeGreaterThan(0);
  });

  it("joins every started job before caller cancellation completes and starts no later wave", async () => {
    const fixture = await readyOwner({
      gmail: true,
      calendar: true,
      github: true,
      slack: true,
    });
    const at = freezeClock();
    const release = createDeferredPromise<void>(context.signal);
    const providers = holdFirstWaveProviders(release.promise);
    const cancellation = new AbortController();
    let publiclySettled = false;
    const pending = composeClient(cancellation.signal)
      .compose({
        headers: authHeaders(fixture),
        body: { anchor: anchorFor(at) },
      })
      .finally(() => {
        publiclySettled = true;
        expect(providers.active()).toBe(0);
      });

    await providers.arrived;
    expect(providers.active()).toBe(3);
    expect(providers.maximum()).toBe(3);
    expect(providers.slackCalls()).toBe(0);
    cancellation.abort(new Error("cancel composition"));
    await providers.cancelled;
    await Promise.resolve();

    // Cancellation has reached all three started provider boundaries, but the
    // public request still waits for the deliberately held siblings to settle.
    expect(publiclySettled).toBeFalsy();
    expect(providers.active()).toBe(3);
    expect(providers.slackCalls()).toBe(0);

    release.resolve();
    await expect(pending).rejects.toThrow("cancel composition");
    expect(providers.maximum()).toBe(3);
    expect(providers.slackCalls()).toBe(0);
  });
});
