import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

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
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWorkflowsBddApi } from "./helpers/api-bdd-workflows";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
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

function composeClient() {
  return setupApp({ context, routes: morningBriefCompositionPreviewRoutes })(
    morningBriefCompositionPreviewContract,
  );
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
async function setupOwner(
  options: { readonly gmail?: boolean } = {},
): Promise<Fixture> {
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
  if (options.gmail === true) {
    await connectGmail(actor, agentId);
    await runsApi.enableAgentConnectors(actor, agentId, ["gmail"]);
    // Message bodies are not allowed by default, so a working Gmail read needs
    // the real grant rather than a relaxed authorizer.
    await runsApi.applyUserPermissionGrant(actor, {
      agentId,
      connectorSlug: "gmail",
      permission: "messages.detail",
      action: "allow",
    });
  }
  const installation = await installMorningBriefFixture(
    { orgId: actor.orgId, userId: actor.userId },
    { agentId },
  );
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
    options: { readonly gmail?: boolean } = {},
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
    expect(body.composition.sources).toStrictEqual([
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
    expect(response.body.sources).toStrictEqual([
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

  it("answers about every started reader when one source job fails", async () => {
    const fixture = await readyOwner({ gmail: true });
    const at = freezeClock();
    const held = createDeferredPromise<void>(context.signal);
    // Gmail never answers, so its own budget aborts the job. The service clock
    // stays frozen, so the attempt itself is not expired: a delivered timeout
    // callback is not the same fact as spent time.
    const gmail = stubGmail({ hold: held.promise });
    const pending = startCompose(fixture, {
      anchor: anchorFor(at),
      deadlineAt: new Date(at + 1500).toISOString(),
    });

    const response = await accept(pending, [200]);
    held.resolve();

    expect(gmail.calls.length).toBeGreaterThan(0);
    // One rejected job does not discard the wave, and the attempt still answers
    // rather than propagating that job's abort as the whole request's failure.
    expect(response.body.result).toBe("incomplete");
    if (response.body.result !== "incomplete") {
      return;
    }
    expect(response.body.detail).toContain("gmail=failed");
  });

  it("joins a held reader before it answers at all", async () => {
    const fixture = await readyOwner({ gmail: true });
    const at = freezeClock();
    const held = createDeferredPromise<void>(context.signal);
    const gmail = stubGmail({
      messages: [{ id: "m-1", at: at - 30 * 60 * 1000 }],
      hold: held.promise,
    });
    const pending = startCompose(fixture, { anchor: anchorFor(at) });

    await gmail.firstList;
    let answeredWhileHeld = true;
    const joined = pending.finally(() => {
      answeredWhileHeld = !held.settled();
    });
    held.resolve();
    const response = await accept(joined, [200]);

    // The response can only exist after the held reader settled, and it carries
    // that reader's evidence.
    expect(answeredWhileHeld).toBeFalsy();
    expect(response.body.result).toBe("composed");
    if (response.body.result !== "composed") {
      return;
    }
    expect(coverageOf(response.body.composition, "gmail")).toBe("complete");
    expect(response.body.composition.request?.items).toBeGreaterThan(0);
  });
});
