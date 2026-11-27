import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import {
  chatThreadByIdContract,
  chatThreadEventsContract,
  chatThreadsContract,
  type UserMessageInputDocument,
} from "@okouai/api-contracts/contracts/chat-threads";
import { runnerDispatchEnvelopeSchema } from "@okouai/api-contracts/contracts/runner-dispatch";
import { runnersHeartbeatContract } from "@okouai/api-contracts/contracts/runners";
import { sharedThreadVisibilityContract } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import {
  webhookCompleteContract,
  webhookStripeContract,
} from "@okouai/api-contracts/contracts/webhooks";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { env, mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { mockStripeClient } from "../../external/stripe-client";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { artifactDownloadRoutes } from "../artifact-downloads";
import { artifactReferenceRoutes } from "../artifact-references";
import { chatEventsRoutes } from "../chat-events";
import { chatThreadRoutes } from "../chat-threads";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { chatThreadDeleteRoutes } from "../chat-threads-delete";
import { runnersRoutes } from "../runners";
import { sharedThreadRoutes } from "../shared-threads";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { webhooksAgentCompleteRoutes } from "../webhooks-agent-complete";
import { webhooksStripeRoutes } from "../webhooks-stripe";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { projectChatEventRows } from "./helpers/chat-event-test-reader";
import { mockClerkUsers } from "./helpers/clerk-users";
import {
  mockGoogleText,
  VERTEX_TEXT_URL,
  vertexTextRequest,
  vertexTextResponse,
} from "./helpers/google-text";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

const context = testContext();
const bdd = createBddApi(context);
const chatCallbacks = createChatCallbacksApi(context);

const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const app = setupApp({
  context,
  routes: [
    ...sharedThreadRoutes,
    ...artifactCatalogRoutes,
    ...artifactReferenceRoutes,
    ...artifactDownloadRoutes,
    ...uploadsPrepareRoutes,
    ...uploadsCompleteRoutes,
    ...chatEventsRoutes,
    ...chatThreadCreateRoutes,
    ...chatThreadDeleteRoutes,
    ...chatThreadRoutes,
    ...webhooksAgentCompleteRoutes,
    ...webhooksStripeRoutes,
    ...runnersRoutes,
  ],
});
const shares = app(sharedThreadsContract);
const visibility = app(sharedThreadVisibilityContract);
const catalog = app(artifactCatalogContract);
const artifactRefs = app(artifactReferencesContract);
const artifactDownloads = app(artifactDownloadsContract);
const uploads = app(uploadsContract);
const chatEvents = app(chatEventsContract);
const chatThreads = app(chatThreadsContract);
const chatThreadById = app(chatThreadByIdContract);
const threadEvents = app(chatThreadEventsContract);
const agentComplete = app(webhookCompleteContract);
const stripeWebhook = app(webhookStripeContract);
const runnersHeartbeat = app(runnersHeartbeatContract);

beforeAll(async () => {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: false,
  });
  const missingId = randomUUID();
  await Promise.all([
    accept(
      shares.create({
        headers: {},
        params: { threadId: missingId },
        body: { eventIds: [missingId] },
      }),
      [401],
    ),
    accept(
      visibility.create({
        headers: {},
        params: { threadId: missingId },
        body: { eventIds: [missingId], audience: "private" },
      }),
      [401],
    ),
    accept(
      visibility.update({
        headers: {},
        params: { id: missingId },
        body: { audience: "private", expectedRevision: null },
      }),
      [401],
    ),
    accept(
      visibility.get({
        headers: {},
        params: { id: missingId },
      }),
      [401],
    ),
    accept(catalog.list({ headers: {}, query: {} }), [401]),
    accept(
      catalog.get({
        headers: {},
        params: { artifactId: missingId },
        query: {},
      }),
      [401],
    ),
    accept(
      artifactRefs.resolve({
        headers: {},
        params: { reference: "0000000000.pdf" },
        query: { kind: "file" },
      }),
      [401],
    ),
    accept(
      artifactDownloads.download({
        headers: {},
        params: { reference: "0000000000.pdf" },
      }),
      [401],
    ),
    accept(
      uploads.prepare({
        headers: {},
        body: { filename: "warm.txt", contentType: "text/plain", size: 4 },
      }),
      [401],
    ),
    accept(
      uploads.complete({
        headers: {},
        body: { id: missingId },
      }),
      [401],
    ),
    accept(
      threadEvents.rows({
        headers: {},
        params: { threadId: missingId },
        query: { sinceSeqId: 0, limit: 1 },
      }),
      [401],
    ),
    accept(
      chatEvents.send({
        headers: {},
        body: {
          prompt: "warm",
          hasTextContent: true,
          userMessage: {
            version: 1,
            parts: [{ type: "text", text: "warm" }],
          },
        },
      }),
      [401],
    ),
    accept(
      chatThreads.create({
        headers: {},
        body: { title: "warm", model: null },
      }),
      [401],
    ),
    accept(
      chatThreadById.delete({
        headers: {},
        params: { id: missingId },
      }),
      [401],
    ),
    accept(
      agentComplete.complete({
        headers: {},
        body: { runId: missingId, exitCode: 1, error: "warm" },
      }),
      [401],
    ),
    accept(stripeWebhook.post({ body: "{}", extraHeaders: {} }), [401, 503]),
    accept(
      runnersHeartbeat.heartbeat({
        headers: {},
        body: {
          runnerId: missingId,
          group: "vm0/warm",
          snapshotGeneration: 1,
          snapshotSequence: 1,
          totalVcpu: 8,
          totalMemoryMb: 16_384,
          maxConcurrent: 2,
          allocatedVcpu: 0,
          allocatedMemoryMb: 0,
          runningCount: 0,
          admittableProfiles: ["vm0/default"],
          heldSandboxStates: [],
          heldHomeStates: [],
          activeReuseProducers: [],
          mode: "running",
          ingressServiceActive: true,
        },
      }),
      [401],
    ),
  ]);
});

function signIn(user: ApiTestUser | null) {
  if (!user) {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
    return {};
  }
  createRouteMocks(context).clerk.session(
    user.userId,
    user.orgId,
    user.orgRole ?? (user.orgId ? "org:admin" : undefined),
  );
  return headers;
}

function requireOrgId(user: ApiTestUser): string {
  if (!user.orgId) {
    throw new Error("Expected member to belong to an organization");
  }
  return user.orgId;
}

function buildProStripeFixture(actor: ApiTestUser, priceId: string) {
  const orgId = requireOrgId(actor);
  const suffix = randomUUID();
  const customerId = `cus_pro_${suffix}`;
  const subscriptionId = `sub_pro_${suffix}`;
  const invoiceId = `in_pro_${suffix}`;
  const periodEndUnix = Math.floor(now() / 1000) + 30 * 86_400;
  const customer = {
    id: customerId,
    object: "customer",
    metadata: { orgId },
  };
  const subscription = {
    id: subscriptionId,
    object: "subscription",
    status: "active",
    customer: customerId,
    cancel_at_period_end: false,
    cancel_at: null,
    schedule: null,
    trial_end: null,
    metadata: {},
    items: {
      object: "list",
      has_more: false,
      url: `/v1/subscription_items?subscription=${subscriptionId}`,
      data: [
        {
          id: `si_pro_${suffix}`,
          object: "subscription_item",
          price: { id: priceId, object: "price" },
          current_period_start: periodEndUnix - 30 * 86_400,
          current_period_end: periodEndUnix,
        },
      ],
    },
  };
  const invoicePaidEvent = {
    id: `evt_pro_${suffix}`,
    object: "event",
    created: Math.floor(now() / 1000),
    type: "invoice.paid",
    data: {
      object: {
        id: invoiceId,
        object: "invoice",
        customer: customerId,
        metadata: {},
        parent: { subscription_details: { subscription: subscriptionId } },
        lines: {
          has_more: false,
          data: [
            {
              price: { id: priceId },
              parent: { type: "subscription_item_details" },
              period: {
                start: periodEndUnix - 30 * 86_400,
                end: periodEndUnix,
              },
            },
          ],
        },
      },
    },
  };
  const signature = `t=1,v1=${suffix}`;
  return { customer, subscription, invoicePaidEvent, signature };
}

async function grantProMembers(actors: readonly ApiTestUser[]): Promise<void> {
  mockOptionalEnv("STRIPE_WEBHOOK_SECRET", "whsec_bdd_stripe");
  const priceId = env("OKOU_PRICE_PRO")?.[0];
  if (!priceId) {
    throw new Error("Expected a configured pro subscription price");
  }
  const fixtures = actors.map((actor) => {
    return buildProStripeFixture(actor, priceId);
  });
  const customersById = new Map(
    fixtures.map((fixture) => {
      return [fixture.customer.id, fixture.customer] as const;
    }),
  );
  const subscriptionsById = new Map(
    fixtures.map((fixture) => {
      return [fixture.subscription.id, fixture.subscription] as const;
    }),
  );
  const eventsBySignature = new Map(
    fixtures.map((fixture) => {
      return [fixture.signature, fixture.invoicePaidEvent] as const;
    }),
  );
  mockStripeClient(context.mocks.stripe);
  context.mocks.stripe.customers.retrieve.mockImplementation((id: unknown) => {
    return Promise.resolve(
      typeof id === "string" ? customersById.get(id) : undefined,
    );
  });
  context.mocks.stripe.subscriptions.retrieve.mockImplementation(
    (id: unknown) => {
      return Promise.resolve(
        typeof id === "string" ? subscriptionsById.get(id) : undefined,
      );
    },
  );
  context.mocks.stripe.webhooks.constructEventAsync.mockImplementation(
    (_payload: unknown, signature: unknown) => {
      return Promise.resolve(
        typeof signature === "string"
          ? eventsBySignature.get(signature)
          : undefined,
      );
    },
  );
  await Promise.all(
    fixtures.map((fixture) => {
      return accept(
        stripeWebhook.post({
          body: JSON.stringify(fixture.invoicePaidEvent),
          extraHeaders: { "stripe-signature": fixture.signature },
        }),
        [200],
      );
    }),
  );
}

interface DispatchedRunInfo {
  readonly sandboxToken: string;
  readonly cliAgentType: string;
}

async function registerDirectRunnerForTest() {
  const group = `vm0/bdd-${randomUUID().slice(0, 8)}`;
  const runnerId = randomUUID();
  const hostname = `runner-${runnerId}.okou.app`;
  const authorization = `Bearer vm0_official_${env("OFFICIAL_RUNNER_SECRET")}`;
  const dispatchedRuns = new Map<string, DispatchedRunInfo>();
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", group);
  server.use(
    http.post(
      `https://${hostname}/runners/${runnerId}/control/runs/:runId/dispatch`,
      async ({ request }) => {
        if (request.headers.get("authorization") !== authorization) {
          return new HttpResponse(null, { status: 401 });
        }
        const encoding = request.headers.get("content-encoding");
        const bytes =
          encoding === "gzip"
            ? gunzipSync(Buffer.from(await request.arrayBuffer())).toString(
                "utf8",
              )
            : await request.text();
        const envelope = runnerDispatchEnvelopeSchema.parse(JSON.parse(bytes));
        dispatchedRuns.set(envelope.executionContext.runId, {
          sandboxToken: envelope.executionContext.sandboxToken,
          cliAgentType: envelope.executionContext.cliAgentType,
        });
        return HttpResponse.json({
          runnerId,
          heartbeatGeneration: 1,
          runId: envelope.executionContext.runId,
          disposition: "accepted",
        });
      },
    ),
  );
  await accept(
    runnersHeartbeat.heartbeat({
      headers: { authorization },
      body: {
        runnerId,
        runnerHostname: hostname,
        group,
        snapshotGeneration: 1,
        snapshotSequence: 1,
        totalVcpu: 8,
        totalMemoryMb: 16_384,
        maxConcurrent: 2,
        allocatedVcpu: 0,
        allocatedMemoryMb: 0,
        runningCount: 0,
        admittableProfiles: ["vm0/default"],
        heldSandboxStates: [],
        heldHomeStates: [],
        activeReuseProducers: [],
        mode: "running",
        ingressServiceActive: true,
      },
    }),
    [200],
  );
  return { dispatchedRuns };
}

interface TrackedRun extends DispatchedRunInfo {
  readonly threadId: string;
}

interface ActiveRunTracker {
  readonly dispatchedRuns: ReadonlyMap<string, DispatchedRunInfo>;
  readonly track: (runId: string, run: TrackedRun) => void;
  readonly deleteThreadOnCleanup: (threadId: string) => void;
}

async function setupProRunMember(options?: {
  readonly extraProMember?: ApiTestUser;
}) {
  const member = bdd.user();
  const orgId = requireOrgId(member);
  chatCallbacks.acceptChatObjectStorage();
  installSharedThreadStorage(context);
  context.mocks.axiom.ingest.mockResolvedValue(true);
  context.mocks.axiom.query.mockResolvedValue([]);
  chatCallbacks.disableVapid();

  const members: readonly ApiTestUser[] = options?.extraProMember
    ? [member, options.extraProMember]
    : [member];

  mockClerkUsers(
    context,
    members.map((actor) => {
      return {
        id: actor.userId,
        emailAddresses: [
          { id: `email_${actor.userId}`, emailAddress: actor.email },
        ],
        primaryEmailAddressId: `email_${actor.userId}`,
        firstName: "BDD",
        lastName: "User",
      };
    }),
  );

  const seedMemberships = async () => {
    const membershipStore = createStore();
    await membershipStore.set(
      seedOrgMembership$,
      {
        orgId,
        userId: member.userId,
        role: "admin",
        name: "Origin Workspace",
      },
      context.signal,
    );
    if (options?.extraProMember) {
      await membershipStore.set(
        seedOrgMembership$,
        {
          orgId: requireOrgId(options.extraProMember),
          userId: options.extraProMember.userId,
          role: "admin",
          name: "Other Workspace",
        },
        context.signal,
      );
    }
  };

  const [runner] = await Promise.all([
    registerDirectRunnerForTest(),
    seedMemberships(),
    grantProMembers(members),
  ]);

  const activeRuns = new Map<string, TrackedRun>();
  const threadsToDelete = new Set<string>();

  onTestFinished(async () => {
    context.mocks.ably.publish.mockResolvedValue(undefined);
    if (threadsToDelete.size > 0) {
      const cleanupHeaders = signIn(member);
      await Promise.all(
        [...threadsToDelete].map((threadId) => {
          return accept(
            chatThreadById.delete({
              headers: cleanupHeaders,
              params: { id: threadId },
            }),
            [204],
          );
        }),
      );
    }
    const runsToComplete = [...activeRuns].filter(([, run]) => {
      return !threadsToDelete.has(run.threadId);
    });
    if (runsToComplete.length > 0) {
      await Promise.all(
        runsToComplete.map(([runId, run]) => {
          return accept(
            agentComplete.complete({
              headers: { authorization: `Bearer ${run.sandboxToken}` },
              body: {
                runId,
                exitCode: 0,
                completion: {
                  cliAgentType: run.cliAgentType,
                  cliAgentSessionId: run.threadId,
                  cliAgentSessionHistoryDisposition: "native_only",
                },
              },
            }),
            [200],
          );
        }),
      );
    }
    await flushWaitUntilForTest();
  });

  const tracker: ActiveRunTracker = {
    dispatchedRuns: runner.dispatchedRuns,
    track(runId: string, run: TrackedRun) {
      activeRuns.set(runId, run);
    },
    deleteThreadOnCleanup(threadId: string) {
      threadsToDelete.add(threadId);
    },
  };

  return { member, orgId, tracker };
}

async function uploadStoredFile(
  actor: ApiTestUser,
  file: {
    readonly filename: string;
    readonly contentType: string;
    readonly bytes: Buffer;
    readonly visibility: "private" | "public";
  },
) {
  const uploader: ApiTestUser =
    file.visibility === "public"
      ? { ...actor, orgId: null, orgRole: undefined }
      : actor;
  const prepared = await accept(
    uploads.prepare({
      headers: signIn(uploader),
      body: {
        filename: file.filename,
        contentType: file.contentType,
        size: file.bytes.byteLength,
      },
    }),
    [200],
  );
  if (!("uploadUrl" in prepared.body)) {
    throw new Error("Expected a single-PUT upload URL");
  }
  const uploadUrl = prepared.body.uploadUrl;
  const putResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.contentType,
      ...prepared.body.uploadHeaders,
    },
    body: new Uint8Array(file.bytes),
  });
  expect(putResponse.status).toBe(200);
  const completed = await accept(
    uploads.complete({
      headers: signIn(uploader),
      body: { id: prepared.body.id },
    }),
    [200],
  );
  return completed.body;
}

async function sendPromptAndWaitForRun(
  member: ApiTestUser,
  tracker: ActiveRunTracker,
  args: {
    readonly threadId?: string;
    readonly prompt: string;
    readonly userMessage: UserMessageInputDocument;
    readonly hasTextContent?: boolean;
    readonly sourceRunId?: string;
    readonly readEventId?: boolean;
  },
) {
  const seenRunIds = new Set(tracker.dispatchedRuns.keys());
  const clientEventId = randomUUID();
  const sent = await accept(
    chatEvents.send({
      headers: signIn(member),
      body: {
        prompt: args.prompt,
        hasTextContent: args.hasTextContent ?? true,
        clientEventId,
        model: null,
        userMessage: args.userMessage,
        ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
        ...(args.sourceRunId === undefined
          ? {}
          : { sourceRunId: args.sourceRunId }),
      },
    }),
    [201],
  );
  await flushWaitUntilForTest();
  if (args.readEventId === false) {
    const newEntry = [...tracker.dispatchedRuns.entries()].find(([runId]) => {
      return !seenRunIds.has(runId);
    });
    if (!newEntry) {
      throw new Error("Expected the Thread send to dispatch a new Run");
    }
    const [runId, dispatched] = newEntry;
    tracker.track(runId, {
      ...dispatched,
      threadId: sent.body.threadId,
    });
    return {
      threadId: sent.body.threadId,
      runId,
      eventId: clientEventId,
    };
  }
  const listed = await accept(
    threadEvents.rows({
      headers: signIn(member),
      params: { threadId: sent.body.threadId },
      query: { sinceSeqId: 0, limit: 50 },
    }),
    [200],
  );
  const events = projectChatEventRows(listed.body.rows);
  const claimed = events.find((event) => {
    return (
      event.eventType === "input.prompt" &&
      event.revokesEventId === clientEventId &&
      event.runId !== undefined
    );
  });
  if (!claimed || !claimed.runId) {
    throw new Error("Expected the Thread send to launch a Run");
  }
  const dispatched = tracker.dispatchedRuns.get(claimed.runId);
  if (!dispatched) {
    throw new Error("Expected the Run to be directly dispatched to the Runner");
  }
  tracker.track(claimed.runId, {
    ...dispatched,
    threadId: sent.body.threadId,
  });
  return {
    threadId: sent.body.threadId,
    runId: claimed.runId,
    eventId: claimed.id,
  };
}

function titleModel(text: string) {
  mockGoogleText();
  const requests: ReturnType<typeof vertexTextRequest>[] = [];
  server.use(
    http.post(VERTEX_TEXT_URL, async ({ request }) => {
      requests.push(vertexTextRequest(await request.json(), request.url));
      return vertexTextResponse(text);
    }),
  );
  return requests;
}

function referenceFromArtifactUrl(url: string): {
  readonly parsed: URL;
  readonly reference: string;
} {
  const parsed = new URL(url);
  expect(parsed.pathname.startsWith("/artifacts/")).toBeTruthy();
  return {
    parsed,
    reference: parsed.pathname.slice("/artifacts/".length),
  };
}

async function sharedCatalogEntries(member: ApiTestUser, threadId: string) {
  const listed = await accept(
    catalog.list({
      headers: signIn(member),
      query: { kind: "shared-thread", chatThreadId: threadId },
    }),
    [200],
  );
  return listed.body.artifacts;
}

describe("optional shared-thread titles", () => {
  it(
    "shared-threads-006 removes forwarded chat and quoted source identities from the public snapshot",
    { timeout: TEST_WITH_DOUBLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { member, tracker } = await setupProRunMember();
      const sourceThreadTitle = "Private Executive Debrief";
      const sourceThread = await accept(
        chatThreads.create({
          headers: signIn(member),
          body: { title: sourceThreadTitle, model: null },
        }),
        [201],
      );
      const sourceRun = await sendPromptAndWaitForRun(member, tracker, {
        threadId: sourceThread.body.id,
        prompt: "Prepare the executive launch brief",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "Prepare the executive launch brief" }],
        },
        readEventId: false,
      });

      const mailId = `mail-${randomUUID()}`;
      const sentId = `sent-${randomUUID()}`;
      const fileId = randomUUID();
      const artifactId = randomUUID();
      const mailQuote = "We confirmed Friday sign-off with leadership.";
      const artifactQuote = "Release checklist freezes Thursday at noon.";
      const noteText = "Keep the deadline";

      const forwarded = await sendPromptAndWaitForRun(member, tracker, {
        sourceRunId: sourceRun.runId,
        prompt: "Forward quoted launch details",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "feedback",
              quote: mailQuote,
              note: [],
              source: {
                type: "mail",
                id: mailId,
                status: "sent",
                sentId,
              },
            },
            {
              type: "feedback",
              quote: artifactQuote,
              note: [{ type: "text", text: noteText }],
              source: {
                type: "artifact",
                fileId,
                filenameSnapshot: "launch-plan.md",
                artifactId,
              },
            },
          ],
        },
      });

      const created = await accept(
        shares.create({
          headers: signIn(member),
          params: { threadId: forwarded.threadId },
          body: { eventIds: [forwarded.eventId] },
        }),
        [201],
      );
      const shareRead = await accept(
        shares.get({
          headers: signIn(null),
          params: { id: created.body.id },
        }),
        [200],
      );

      expect(shareRead.body.messages).toStrictEqual([
        {
          messageIndex: 0,
          role: "user",
          runIndex: 0,
          content: [
            "The user quoted 2 parts of your reply:",
            "",
            `> ${mailQuote}`,
            "",
            "---",
            "",
            `> ${artifactQuote}`,
            "",
            noteText,
          ].join("\n"),
        },
      ]);

      const serializedSnapshot = JSON.stringify(shareRead.body);
      for (const forbidden of [
        sourceThreadTitle,
        sourceRun.runId,
        sourceThread.body.id,
        mailId,
        sentId,
        fileId,
        artifactId,
        "launch-plan.md",
      ]) {
        expect(serializedSnapshot).not.toContain(forbidden);
      }
    },
  );

  it(
    "shared-threads-001 creates one private-content-safe snapshot with healthy title",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { member, tracker } = await setupProRunMember();
      const privateTitle = "Confidential Compensation Review";
      const selectedContent = "Publish the agreed launch checklist";
      const unselectedPrivateMessage = "Private board salary adjustment 984120";

      const thread = await accept(
        chatThreads.create({
          headers: signIn(member),
          body: { title: privateTitle, model: null },
        }),
        [201],
      );
      tracker.deleteThreadOnCleanup(thread.body.id);

      const launched = await sendPromptAndWaitForRun(member, tracker, {
        threadId: thread.body.id,
        prompt: selectedContent,
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: selectedContent }],
        },
      });

      await accept(
        chatEvents.send({
          headers: signIn(member),
          body: {
            threadId: thread.body.id,
            prompt: unselectedPrivateMessage,
            hasTextContent: true,
            clientEventId: randomUUID(),
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: unselectedPrivateMessage }],
            },
          },
        }),
        [201],
      );

      const rawProviderTitle = "**Launch checklist**";
      const titleRequests = titleModel(rawProviderTitle);

      const created = await accept(
        shares.create({
          headers: signIn(member),
          params: { threadId: thread.body.id },
          body: { eventIds: [launched.eventId, launched.eventId] },
        }),
        [201],
      );
      expect(Object.keys(created.body)).toStrictEqual(["id"]);
      const shareId = created.body.id;

      const anonymousHeaders = signIn(null);
      const [shareRead, metaRead] = await Promise.all([
        accept(
          shares.get({ headers: anonymousHeaders, params: { id: shareId } }),
          [200],
        ),
        accept(shares.meta({ params: { id: shareId } }), [200]),
      ]);
      const catalogEntries = await sharedCatalogEntries(member, thread.body.id);

      expect(shareRead.headers.get("cache-control")).toBe("no-store");
      expect(shareRead.body).toStrictEqual({
        id: shareId,
        title: "Launch checklist",
        messages: [
          {
            messageIndex: 0,
            role: "user",
            content: selectedContent,
            runIndex: 0,
          },
        ],
      });
      expect(metaRead.headers.get("cache-control")).toBe("no-store");
      expect(metaRead.body).toStrictEqual({ title: "Launch checklist" });
      expect(catalogEntries).toStrictEqual([
        expect.objectContaining({
          kind: "shared-thread",
          sharedThreadId: shareId,
          title: "Launch checklist",
        }),
      ]);

      const catalogEntryId = catalogEntries[0]?.id;
      if (!catalogEntryId) {
        throw new Error("Expected a shared-thread catalog artifact");
      }
      const catalogDetail = await accept(
        catalog.get({
          headers: signIn(member),
          params: { artifactId: catalogEntryId },
          query: {},
        }),
        [200],
      );
      expect(catalogDetail.body).toMatchObject({
        kind: "shared-thread",
        sharedThreadId: shareId,
        sharedThread: { id: shareId },
        title: "Launch checklist",
      });

      const publicOutputs = JSON.stringify([
        shareRead.body,
        metaRead.body,
        catalogEntries,
        catalogDetail.body,
      ]);
      expect(publicOutputs).not.toContain(privateTitle);
      expect(publicOutputs).not.toContain(unselectedPrivateMessage);
      expect(publicOutputs).not.toContain(rawProviderTitle);

      expect(titleRequests).toHaveLength(1);
      const titleRequest = titleRequests[0];
      expect(titleRequest?.model).toBe("gemini-3.1-flash-lite");
      expect(titleRequest?.generationConfig.maxOutputTokens).toBe(2048);
      expect(titleRequest?.generationConfig.thinkingConfig.thinkingLevel).toBe(
        "MINIMAL",
      );
      const serializedTitlePrompt = JSON.stringify(titleRequest?.messages);
      expect(serializedTitlePrompt).toContain(selectedContent);
      expect(serializedTitlePrompt).not.toContain(privateTitle);
      expect(serializedTitlePrompt).not.toContain(unselectedPrivateMessage);
    },
  );

  it(
    "shared-threads-012 rejects oversized selections before title generation",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { member, tracker } = await setupProRunMember();
      const launched = await sendPromptAndWaitForRun(member, tracker, {
        prompt: "Hold thread active",
        userMessage: {
          version: 1,
          parts: [{ type: "text", text: "Hold thread active" }],
        },
        readEventId: false,
      });
      tracker.deleteThreadOnCleanup(launched.threadId);

      const oversizedEventId = randomUUID();
      // 700,000 em-dashes encode to 2,100,000 UTF-8 bytes (> 2 MiB) without triggering bigram indexing.
      const twoMiBText = "\u2014".repeat(700_000);
      await accept(
        chatEvents.send({
          headers: signIn(member),
          body: {
            threadId: launched.threadId,
            prompt: "oversized",
            hasTextContent: true,
            clientEventId: oversizedEventId,
            userMessage: {
              version: 1,
              parts: [{ type: "text", text: twoMiBText }],
            },
          },
        }),
        [201],
      );

      const titleRequests = titleModel("Should never be called");
      const rejected = await accept(
        shares.create({
          headers: signIn(member),
          params: { threadId: launched.threadId },
          body: { eventIds: [oversizedEventId] },
        }),
        [413],
      );

      expect(rejected.body.error.code).toBe("SHARED_THREAD_TOO_LARGE");
      expect(titleRequests).toStrictEqual([]);
      await expect(
        sharedCatalogEntries(member, launched.threadId),
      ).resolves.toStrictEqual([]);
    },
  );
});

describe("shared-thread attachments", () => {
  it(
    "shared-thread-attachments-005 publishes the annotated image without exposing its original",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("APP_URL", "https://app.okou.ai");
      const { member, tracker } = await setupProRunMember();
      const originalBytes = Buffer.from("original unredacted image");
      const annotatedBytes = Buffer.from("annotated image");
      const [original, annotated] = await Promise.all([
        uploadStoredFile(member, {
          filename: "screen.png",
          contentType: "image/png",
          bytes: originalBytes,
          visibility: "private",
        }),
        uploadStoredFile(member, {
          filename: "screen.annotated.png",
          contentType: "image/png",
          bytes: annotatedBytes,
          visibility: "private",
        }),
      ]);

      const launched = await sendPromptAndWaitForRun(member, tracker, {
        prompt: "Review the redacted screenshot",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: original.id,
              filenameSnapshot: "screen.png",
              contentType: "image/png",
              annotatedFileId: annotated.id,
              annotations: {
                marks: [
                  {
                    id: "redact-1",
                    shape: "redact",
                    rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
                  },
                ],
              },
            },
            { type: "text", text: "Review the redacted screenshot" },
          ],
        },
      });

      const created = await accept(
        shares.create({
          headers: signIn(member),
          params: { threadId: launched.threadId },
          body: { eventIds: [launched.eventId] },
        }),
        [201],
      );
      const shareRead = await accept(
        shares.get({
          headers: signIn(null),
          params: { id: created.body.id },
        }),
        [200],
      );

      expect(shareRead.body.messages).toHaveLength(1);
      expect(JSON.stringify(shareRead.body)).not.toContain(original.id);
      const attachments = shareRead.body.messages[0]?.attachments;
      expect(attachments).toHaveLength(1);
      const attachment = attachments?.[0];
      if (!attachment) {
        throw new Error("Expected one shared attachment");
      }
      expect(attachment).toMatchObject({
        filename: "screen.annotated.png",
        contentType: "image/png",
        size: annotatedBytes.byteLength,
      });

      const { parsed, reference } = referenceFromArtifactUrl(attachment.url);
      expect(parsed.origin).toBe("https://app.okou.ai");
      expect(reference).toMatch(/^[a-z0-9]{10}\.png$/u);

      const resolved = await accept(
        artifactRefs.publicUrl({ params: { reference } }),
        [200],
      );
      const bytesResponse = await fetch(resolved.body.url);
      expect(bytesResponse.status).toBe(200);
      await expect(bytesResponse.text()).resolves.toBe("annotated image");
    },
  );

  it(
    "shared-thread-attachments-008 protects copies of private attachments across visibility changes",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("APP_URL", "https://app.okou.ai");
      const stranger = bdd.user();
      const { member, tracker } = await setupProRunMember({
        extraProMember: stranger,
      });
      const confidentialBytes = Buffer.from("confidential attachment bytes");
      const uploaded = await uploadStoredFile(member, {
        filename: "confidential.pdf",
        contentType: "application/pdf",
        bytes: confidentialBytes,
        visibility: "private",
      });

      const launched = await sendPromptAndWaitForRun(member, tracker, {
        prompt: "Review the confidential PDF",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: uploaded.id,
              filenameSnapshot: "confidential.pdf",
              contentType: "application/pdf",
            },
            { type: "text", text: "Review the confidential PDF" },
          ],
        },
      });

      const ownerHeaders = signIn(member);
      const created = await accept(
        visibility.create({
          headers: ownerHeaders,
          params: { threadId: launched.threadId },
          body: { eventIds: [launched.eventId], audience: "private" },
        }),
        [201],
      );
      const shareId = created.body.id;

      const [ownerShare, initialVisibility] = await Promise.all([
        accept(
          shares.get({ headers: ownerHeaders, params: { id: shareId } }),
          [200],
        ),
        accept(
          visibility.get({ headers: ownerHeaders, params: { id: shareId } }),
          [200],
        ),
      ]);
      const attachmentUrl = ownerShare.body.messages[0]?.attachments?.[0]?.url;
      if (!attachmentUrl) {
        throw new Error("Expected the shared attachment URL");
      }
      const { reference } = referenceFromArtifactUrl(attachmentUrl);

      const [, ownerResolve, ownerDownload] = await Promise.all([
        accept(artifactRefs.publicUrl({ params: { reference } }), [404]),
        accept(
          artifactRefs.resolve({
            headers: ownerHeaders,
            params: { reference },
            query: {},
          }),
          [200],
        ),
        accept(
          artifactDownloads.download({
            headers: ownerHeaders,
            params: { reference },
          }),
          [200],
        ),
      ]);
      const ownerBytes = await fetch(ownerResolve.body.url);
      expect(ownerBytes.status).toBe(200);
      await expect(ownerBytes.text()).resolves.toBe(
        "confidential attachment bytes",
      );
      expect(ownerDownload.body.kind).toBe("file");

      const strangerHeaders = signIn(stranger);
      await Promise.all([
        accept(
          artifactRefs.resolve({
            headers: strangerHeaders,
            params: { reference },
            query: {},
          }),
          [404],
        ),
        accept(
          artifactDownloads.download({
            headers: strangerHeaders,
            params: { reference },
          }),
          [404],
        ),
      ]);

      const madePublic = await accept(
        visibility.update({
          headers: signIn(member),
          params: { id: shareId },
          body: {
            audience: "public",
            expectedRevision: initialVisibility.body.revision,
          },
        }),
        [200],
      );
      const publicResolve = await accept(
        artifactRefs.publicUrl({ params: { reference } }),
        [200],
      );
      const publicBytes = await fetch(publicResolve.body.url);
      expect(publicBytes.status).toBe(200);
      await expect(publicBytes.text()).resolves.toBe(
        "confidential attachment bytes",
      );

      await accept(
        visibility.update({
          headers: signIn(member),
          params: { id: shareId },
          body: {
            audience: "private",
            expectedRevision: madePublic.body.revision,
          },
        }),
        [200],
      );
      await accept(artifactRefs.publicUrl({ params: { reference } }), [404]);
    },
  );

  it(
    "shared-thread-attachments-010 asks for a new share before restricting legacy public attachment copies on https://a.okou.io",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      mockEnv("OKOU_PUBLIC_ARTIFACTS_BASE_URL", "https://a.okou.io");
      const { member, tracker } = await setupProRunMember();
      const uploaded = await uploadStoredFile(member, {
        filename: "legacy.pdf",
        contentType: "application/pdf",
        bytes: Buffer.from("legacy public pdf bytes"),
        visibility: "public",
      });

      const launched = await sendPromptAndWaitForRun(member, tracker, {
        prompt: "Read the legacy PDF",
        userMessage: {
          version: 1,
          parts: [
            {
              type: "file",
              fileId: uploaded.id,
              filenameSnapshot: "legacy.pdf",
              contentType: "application/pdf",
            },
            { type: "text", text: "Read the legacy PDF" },
          ],
        },
      });

      const created = await accept(
        shares.create({
          headers: signIn(member),
          params: { threadId: launched.threadId },
          body: { eventIds: [launched.eventId] },
        }),
        [201],
      );
      const shareId = created.body.id;

      const beforeUpdate = await accept(
        shares.get({ headers: signIn(null), params: { id: shareId } }),
        [200],
      );
      const attachmentUrl =
        beforeUpdate.body.messages[0]?.attachments?.[0]?.url;
      if (!attachmentUrl) {
        throw new Error("Expected the shared legacy attachment URL");
      }
      expect(new URL(attachmentUrl).origin).toBe("https://a.okou.io");

      const ownerHeaders = signIn(member);
      const [privateAttempt, orgAttempt] = await Promise.all([
        accept(
          visibility.update({
            headers: ownerHeaders,
            params: { id: shareId.toUpperCase() },
            body: { audience: "private", expectedRevision: null },
          }),
          [400],
        ),
        accept(
          visibility.update({
            headers: ownerHeaders,
            params: { id: shareId.toUpperCase() },
            body: { audience: "organization", expectedRevision: null },
          }),
          [400],
        ),
      ]);
      expect(privateAttempt.body.error.message).toContain("Create a new share");
      expect(orgAttempt.body.error.message).toContain("Create a new share");

      const afterUpdate = await accept(
        shares.get({ headers: signIn(null), params: { id: shareId } }),
        [200],
      );
      expect(afterUpdate.body).toStrictEqual(beforeUpdate.body);
    },
  );
});
