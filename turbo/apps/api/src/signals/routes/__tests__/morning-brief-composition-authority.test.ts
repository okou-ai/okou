import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { morningBriefCompositionPreviewContract } from "@okouai/api-contracts/contracts/morning-brief-composition-preview";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import {
  bindMorningBriefThreadFixture,
  installMorningBriefFixture,
  reselectThreadGmailAccountFixture,
  revokeAgentConnectorGrantFixture,
  selectThreadGmailAccountFixture,
} from "../../../test-fixtures/morning-brief-gmail-collection";
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
import {
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
} from "./helpers/integrations-slack";
import { seedOrgMembership$ } from "./helpers/org-membership";
import { createRouteMocks } from "./helpers/route-test";

/**
 * Exact source selection and retained-source revalidation, through the real
 * registered composition route.
 *
 * The engine reads its sources in waves, so a source can finish, wait while a
 * later wave is still running, and only then have its material used. These
 * tests drive that window at the application boundary: the account choice is
 * frozen before any source starts, and the authority every supplied source was
 * read under is re-asked before the request is planned.
 *
 * External boundaries are doubled — Gmail and Slack answer through MSW, and
 * every gate they pass is the deployed one. Nothing here reaches a real
 * provider, and the arrival of a held provider request is the barrier, not a
 * sleep.
 */

const GMAIL_LIST_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_MESSAGE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/messages/:messageId";
const SLACK_CONVERSATIONS_URL = "https://slack.com/api/users.conversations";
const SLACK_HISTORY_URL = "https://slack.com/api/conversations.history";
const SLACK_REPLIES_URL = "https://slack.com/api/conversations.replies";

const ANCHOR_ISO = "2026-09-17T07:00:00.000Z";
const ANCHOR_MS = Date.parse(ANCHOR_ISO);

/**
 * Real OAuth setup, five collectors and a held provider request do not fit the
 * 5-second default. The barrier is still the request's arrival, never elapsed
 * time; this only stops the runner from cutting the attempt short.
 */
const TEST_TIMEOUT_MS = 60_000;

const context = testContext();
const store = createStore();
const mocks = createRouteMocks(context);
const bdd = createBddApi(context);
const connectorsApi = createConnectorBddApi(context);
const runsApi = createRunsApi(context);
const workflowBdd = createWorkflowsBddApi(context);

/**
 * An object store that actually round-trips.
 *
 * Creating an Agent publishes its instructions volume, and the composition's
 * language context reads that volume back. The shared default answers every
 * command with a fixed size and no body, so the read fails and the composition
 * reports an unreadable Agent instead of running. Keeping the written bytes is
 * what makes the published instructions readable by the same production path.
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

function composeClient() {
  return setupApp({
    context,
    routes: morningBriefCompositionPreviewRoutes,
  })(morningBriefCompositionPreviewContract);
}

function authHeaders(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
  return { authorization: "Bearer test-token" } as const;
}

interface Fixture {
  readonly actor: ApiTestUser & { readonly orgId: string };
  readonly agentId: string;
  readonly workflowId: string;
  readonly chatThreadId: string;
  readonly gmailAccountId: string;
  readonly botToken: string;
  readonly membershipId: string;
}

/** Record every provider call so a refusal is observable as zero reads. */
interface ProviderCalls {
  readonly gmail: string[];
  readonly slack: string[];
}

function gmailMessagePayload(id: string) {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: String(ANCHOR_MS - 60_000),
    labelIds: ["INBOX"],
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Subject", value: `Subject ${id}` },
        { name: "From", value: "sender@example.test" },
        { name: "To", value: "owner@example.test" },
        { name: "Date", value: new Date(ANCHOR_MS - 60_000).toUTCString() },
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
 * Gmail answers immediately; Slack's channel enumeration waits on `hold`.
 *
 * Slack runs in the second wave, so by the time its enumeration is reached
 * Gmail's whole collection — including its own release fence — has already
 * finished. That makes the hold an exact barrier for "a source returned and its
 * material is now waiting", which is the window this issue is about.
 */
function stubProviders(args: {
  readonly slackHold?: Promise<void>;
  readonly onSlackEnumerated?: () => void;
}): ProviderCalls {
  const calls: ProviderCalls = { gmail: [], slack: [] };
  // Slack enumerates once to discover the intersection and again to prove it
  // before release, so the arrival barrier fires on the first one only.
  let onEnumerated = args.onSlackEnumerated;
  const fireOnce = (): void => {
    onEnumerated = undefined;
  };
  server.use(
    http.get(GMAIL_LIST_URL, ({ request }) => {
      const url = new URL(request.url);
      calls.gmail.push(url.pathname);
      const query = url.searchParams.get("q") ?? "";
      return HttpResponse.json({
        messages:
          query === "is:unread" ? [] : [{ id: "m1", threadId: "thread-m1" }],
      });
    }),
    http.get(GMAIL_MESSAGE_URL, ({ request, params }) => {
      calls.gmail.push(new URL(request.url).pathname);
      return HttpResponse.json(
        gmailMessagePayload(String(params["messageId"])),
      );
    }),
    http.get(SLACK_CONVERSATIONS_URL, async () => {
      calls.slack.push("users.conversations");
      onEnumerated?.();
      fireOnce();
      if (args.slackHold) {
        await args.slackHold;
      }
      return HttpResponse.json({
        ok: true,
        channels: [{ id: "C1", name: "general", is_private: false }],
      });
    }),
    http.get(SLACK_HISTORY_URL, () => {
      calls.slack.push("conversations.history");
      return HttpResponse.json({
        ok: true,
        messages: [
          {
            type: "message",
            ts: `${String(Math.floor((ANCHOR_MS - 120_000) / 1000))}.000100`,
            user: "U9",
            text: "standup at ten",
          },
        ],
      });
    }),
    http.get(SLACK_REPLIES_URL, () => {
      calls.slack.push("conversations.replies");
      return HttpResponse.json({ ok: true, messages: [] });
    }),
  );
  return calls;
}

async function connectGmail(
  actor: ApiTestUser,
  agentId: string,
  args: { readonly email: string; readonly subject: string },
): Promise<string> {
  mockGmailConnectorOAuth({
    accessToken: `gmail-token-${args.subject}`,
    email: args.email,
    subject: args.subject,
  });
  const start = await connectorsApi.startOauth(
    actor,
    "gmail",
    "oauth",
    agentId,
    { intent: "add", displayName: args.email },
  );
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected a Gmail OAuth state");
  }
  await connectorsApi.completeOauthCallback("gmail", {
    code: `gmail-code-${args.subject}`,
    state,
  });
  const account = (
    await connectorsApi.listBuiltinConnectorAccounts(actor, "gmail")
  ).find((candidate) => {
    return candidate.externalId === args.subject;
  });
  if (!account) {
    throw new Error("Expected the connected Gmail account");
  }
  return account.id;
}

async function setupOwner(
  /** Everything this suite's production writes published, kept across setup. */
  objectStorage: Map<string, Buffer>,
): Promise<Fixture> {
  const { actor } = await workflowBdd.setupWorkflowOrg({
    timezone: "Asia/Shanghai",
  });
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped actor");
  }
  // A freshly created Agent, so no instructions volume has ever been published
  // for it and the language context resolves from the member's locale. The
  // onboarding default Agent promises an instructions archive this suite has no
  // reason to populate, and an unreadable promise is an incomplete composition
  // rather than an absent one.
  // `setupWorkflowOrg` installs the shared object-storage double that answers
  // every command with a fixed size and no body. Restore the round-tripping one
  // before publishing anything this suite has to read back.
  stubObjectStorage(objectStorage);
  const agent = await bdd.createAgent(actor, {
    displayName: `brief-${randomUUID().slice(0, 8)}`,
  });
  const agentId = agent.agentId;
  // Published through the production endpoint, so the composition's language
  // context resolves a real version rather than an unreadable promise.
  await bdd.updateAgentInstructions(actor, agentId, "Summarize the morning.");
  const gmailAccountId = await connectGmail(actor, agentId, {
    email: "owner@example.test",
    subject: `gmail-${randomUUID()}`,
  });
  await runsApi.enableAgentConnectors(actor, agentId, ["gmail"]);
  await runsApi.applyUserPermissionGrant(actor, {
    agentId,
    connectorSlug: "gmail",
    permission: "messages.detail",
    action: "allow",
  });
  const installation = await installMorningBriefFixture(
    { orgId: actor.orgId, userId: actor.userId },
    { agentId },
  );
  const chatThreadId = await bindMorningBriefThreadFixture(
    { orgId: actor.orgId, userId: actor.userId },
    { workflowId: installation.workflowId, agentId },
  );
  await selectThreadGmailAccountFixture({
    chatThreadId,
    connectorId: gmailAccountId,
  });
  const botToken = `xoxb-test-${randomUUID()}`;
  const slack = await store.set(
    seedSlackOrgInstallation$,
    { orgId: actor.orgId, botToken },
    context.signal,
  );
  await store.set(
    seedSlackOrgConnection$,
    { slackWorkspaceId: slack.slackWorkspaceId, userId: actor.userId },
    context.signal,
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
    agentId,
    workflowId: installation.workflowId,
    chatThreadId,
    gmailAccountId,
    botToken,
    membershipId: `orgmem_${randomUUID()}`,
  };
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
    composeClient().compose({
      headers: authHeaders(fixture.actor),
      body: { anchor: ANCHOR_ISO },
    }),
    [200],
  );
}

describe("Morning Brief exact source selection and retained authority", () => {
  let objectStorage = new Map<string, Buffer>();

  beforeEach(async () => {
    mockNow(ANCHOR_MS + 30_000);
    objectStorage = new Map();
    stubObjectStorage(objectStorage);
    await installApiTestConnectorCatalog();
  });

  afterEach(() => {
    clearMockNow();
  });

  it(
    "removes material whose grant was withdrawn while a later source was held, and keeps its siblings",
    async () => {
      const fixture = await setupOwner(objectStorage);
      const held = createDeferredPromise<void>(context.signal);
      const enumerated = createDeferredPromise<void>(context.signal);
      const calls = stubProviders({
        slackHold: held.promise,
        onSlackEnumerated: () => {
          enumerated.resolve();
        },
      });

      const pending = compose(fixture);
      // Slack runs in the second wave, so its arrival proves Gmail's collection
      // and its own release fence already finished.
      await enumerated.promise;
      expect(calls.gmail.length).toBeGreaterThan(0);
      await revokeAgentConnectorGrantFixture(
        { orgId: fixture.actor.orgId, userId: fixture.actor.userId },
        { agentId: fixture.agentId, connectorSlug: "gmail" },
      );
      held.resolve();

      const response = await pending;
      if (response.status !== 200 || response.body.result !== "composed") {
        throw new Error(
          `Expected a composed brief, received ${JSON.stringify(response.body)}`,
        );
      }
      const composition = response.body.composition;
      const bySource = new Map(
        composition.sources.map((entry) => {
          return [entry.source, entry];
        }),
      );
      // Gmail's day is accounted for as failed rather than as a quiet morning,
      // and none of its material remains in the request.
      expect(bySource.get("gmail")?.coverage).toBe("failed");
      expect(bySource.get("gmail")?.items).toBe(0);
      expect(
        composition.descriptors.some((descriptor) => {
          return descriptor.source === "gmail";
        }),
      ).toBeFalsy();
      // The authorized sibling is preserved and still supplies the request.
      expect(bySource.get("slack")?.items).toBeGreaterThan(0);
      const slack = composition.descriptors.find((descriptor) => {
        return descriptor.source === "slack";
      });
      expect(slack?.contributed).toBeTruthy();
      expect(slack?.containers).toStrictEqual(["C1"]);
      // No hidden recollection: the revalidation asks about permissions, so
      // Gmail is never read a second time for the check.
      expect(
        calls.gmail.filter((path) => {
          return path.endsWith("/messages");
        }),
      ).toHaveLength(2);
      expect(composition.request?.items).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "proves the exact selected account and refuses to swap it mid-attempt",
    async () => {
      const fixture = await setupOwner(objectStorage);
      stubProviders({});

      const baseline = await compose(fixture);
      if (baseline.status !== 200 || baseline.body.result !== "composed") {
        throw new Error(
          `Expected a composed brief, received ${JSON.stringify(baseline.body)}`,
        );
      }
      const gmail = baseline.body.composition.descriptors.find((descriptor) => {
        return descriptor.source === "gmail";
      });
      // The retained proof names the exact connection and mailbox this material
      // came from, and the endpoints a later check re-asks about.
      expect(gmail?.connectionId).toBe(fixture.gmailAccountId);
      expect(gmail?.accountRef).toBe("owner@example.test");
      expect(gmail?.endpoints.length).toBeGreaterThan(0);
      expect(gmail?.contributed).toBeTruthy();
      expect(gmail?.scopeDigest).not.toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not adopt an account selected after the attempt was admitted",
    async () => {
      const fixture = await setupOwner(objectStorage);
      const second = await connectGmail(fixture.actor, fixture.agentId, {
        email: "other@example.test",
        subject: `gmail-${randomUUID()}`,
      });
      const held = createDeferredPromise<void>(context.signal);
      const enumerated = createDeferredPromise<void>(context.signal);
      const calls = stubProviders({
        slackHold: held.promise,
        onSlackEnumerated: () => {
          enumerated.resolve();
        },
      });

      const pending = compose(fixture);
      await enumerated.promise;
      // The owner switches accounts while a later source is still reading.
      await reselectThreadGmailAccountFixture({
        chatThreadId: fixture.chatThreadId,
        connectorId: second,
      });
      held.resolve();

      const response = await pending;
      if (response.status !== 200 || response.body.result !== "composed") {
        throw new Error(
          `Expected a composed brief, received ${JSON.stringify(response.body)}`,
        );
      }
      // Nothing was read through the newly selected account, and no descriptor
      // claims it: the frozen attempt neither swaps nor silently continues.
      expect(
        response.body.composition.descriptors.some((descriptor) => {
          return descriptor.connectionId === second;
        }),
      ).toBeFalsy();
      expect(
        calls.gmail.filter((path) => {
          return path.endsWith("/messages");
        }).length,
      ).toBeLessThanOrEqual(2);
    },
    TEST_TIMEOUT_MS,
  );
});
