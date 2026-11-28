import { switchRecoverySubscription } from "./helpers/subscription-recovery";
import { mockNow, now } from "../../../lib/time";
import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { http, HttpResponse } from "msw";
import { array, object, string, record } from "zod";
import {
  integrationsEmailContract,
  integrationsEmailUploadContract,
  MAX_EMAIL_ATTACHMENT_SIZE_BYTES,
} from "@okouai/api-contracts/contracts/integrations-email";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { emailInboundContract } from "@okouai/api-contracts/contracts/email";
import { proactiveSuggestionsContract } from "@okouai/api-contracts/contracts/proactive-suggestions";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorPermissionsContract } from "@okouai/api-contracts/contracts/connector-permissions";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createDeferredPromise } from "../../utils";
import { integrationsEmailRoutes } from "../integrations-email";
import { emailInboundRoutes } from "../email-inbound";
import { proactiveSuggestionsRoutes } from "../proactive-preferences";
import { integrationsEmailUploadCompleteRoutes } from "../integrations-email-upload-complete";
import { integrationsEmailSessionRoutes } from "../integrations-email-session";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { chatThreadRoutes } from "../chat-threads";
import { connectorPermissionsRoutes } from "../connector-permissions";
import { chatConnectorAccessRoutes } from "../chat-connector-access";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import {
  createChatFilesBddApi,
  threadEventCursor,
} from "./helpers/api-bdd-chat-files";
import { createChatCallbacksApi } from "./helpers/api-bdd-chat-callbacks";
import { mockGoogleText } from "./helpers/google-text";
import {
  createWebhookCallbackApi,
  deliverOrganizationCreated,
} from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import {
  mockClerkUsers,
  ClerkUserNotFoundTestError,
} from "./helpers/clerk-users";
import { ClerkTransportTestError } from "./helpers/clerk-transport-error";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { createUniqueEmailSignupAddressFixture } from "../../../test-fixtures/email-signup-identity";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const files = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createRouteMocks(context);
const connectorsApi = createConnectorBddApi(context);
function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function emailClient() {
  return setupApp({ context, routes: integrationsEmailRoutes })(
    integrationsEmailContract,
  );
}

function emailUploadClient() {
  return setupApp({ context, routes: integrationsEmailUploadCompleteRoutes })(
    integrationsEmailUploadContract,
  );
}

function emailSessionClient() {
  return setupApp({ context, routes: integrationsEmailSessionRoutes })(
    integrationsEmailContract,
  );
}

async function startEmailFileExecution(additionalEmail?: string) {
  const { actor, group } = await entitledActor();
  if (additionalEmail) {
    const code = await connectionCode();
    await incoming({ sender: additionalEmail, text: code }).send();
  }
  const message = incoming({
    sender: additionalEmail ?? actor.email,
    subject: "Requested report",
  });
  await message.send();
  await runs.heartbeatRunner(group);
  const execution = await runs.nextReceivedExecution(group);
  const runId = execution.runId;
  const token = execution.platformEnvironment.OKOU_TOKEN;
  if (!token) {
    throw new Error("Expected the run token");
  }
  return { actor, execution, token, message, group, runId };
}

function mockEmailS3(contentLength: number, etag = "email-file") {
  const objects = new Map<string, Buffer>();
  context.mocks.s3.send.mockImplementation((command: unknown) => {
    const name =
      typeof command === "object" && command !== null
        ? command.constructor.name
        : "";
    const input =
      typeof command === "object" &&
      command !== null &&
      "input" in command &&
      typeof command.input === "object" &&
      command.input !== null
        ? (command.input as { Key?: unknown; Body?: unknown })
        : undefined;
    const key = typeof input?.Key === "string" ? input.Key : undefined;
    if (name === "PutObjectCommand" && key) {
      const body = input?.Body;
      objects.set(
        key,
        typeof body === "string"
          ? Buffer.from(body)
          : body instanceof Uint8Array
            ? Buffer.from(body)
            : Buffer.alloc(0),
      );
    }
    if (name === "GetObjectCommand" && key) {
      const stored = objects.get(key);
      if (stored !== undefined) {
        return Promise.resolve({
          ContentLength: stored.length,
          ETag: `"${etag}"`,
          Body: {
            async *[Symbol.asyncIterator]() {
              yield stored;
            },
          },
        });
      }
      return Promise.reject(
        Object.assign(new Error(`NoSuchKey: ${key}`), { name: "NoSuchKey" }),
      );
    }
    return Promise.resolve({
      ContentLength: contentLength,
      UploadId: randomUUID(),
      ETag: etag,
    });
  });
}

async function prepareEmailFile(token: string) {
  const client = setupApp({
    context,
    routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
  })(uploadsContract);
  const prepared = await accept(
    client.prepare({
      headers: { authorization: `Bearer ${token}` },
      body: {
        filename: "report.txt",
        contentType: "text/plain",
        size: 1024,
        purpose: "artifact",
        requirePrivateArtifact: true,
      },
    }),
    [200],
  );
  const completed = await accept(
    client.complete({
      headers: { authorization: `Bearer ${token}` },
      body: { id: prepared.body.id },
    }),
    [200],
  );
  return completed.body;
}

function verifiedDirectory(actor: ApiTestUser, primaryEmail = actor.email) {
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  mockClerkUsers(context, [
    {
      id: actor.userId,
      primaryEmailAddressId: primaryEmail,
      firstName: "Email",
      lastName: "User",
      imageUrl: "",
      username: null,
      privateMetadata: {},
      emailAddresses: [...new Set([actor.email, primaryEmail])].map(
        (emailAddress) => {
          return {
            id: emailAddress,
            emailAddress,
            verification: { status: "verified" },
          };
        },
      ),
    },
  ]);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        id: "membership_email",
        role: "org:admin",
        createdAt: now(),
        organization: { id: actor.orgId, name: "Email workspace" },
        publicUserData: { userId: actor.userId },
      },
    ],
    totalCount: 1,
  });
}

beforeEach(() => {
  mockEnv("RESEND_API_KEY", "test-resend-key");
  mockEnv("RESEND_FROM_DOMAIN", "okou.io");
  mockEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
  mockEnv("APP_URL", "https://app.okou.ai");
  mockOptionalEnv("EMAIL_OUTBOX_DRAIN_DELAY_MS", "0");
  context.mocks.resend.send.mockResolvedValue({
    data: { id: randomUUID() },
    error: null,
  });
});

describe("email model recovery", () => {
  it("links a model failure to the original Web conversation", async () => {
    mockEnv("OKOU_WEB_URL", "https://app.okou.ai");
    const { actor, execution, runId, group } = await startEmailFileExecution();
    await webhooks.requestAgentComplete(
      {
        runId,
        exitCode: 1,
        error: "Claude verification required",
        failureReason: "account_verification_required",
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    const snapshot = await createdThreads(actor);
    const thread = snapshot.chatThreads[0];
    if (!thread) {
      throw new Error("Expected the original Email conversation");
    }
    expect(sentEmails().at(-1)?.text).toContain(
      `Switch this conversation's model in Okou: https://app.okou.ai/chats/${thread.id}`,
    );
    await expect(
      files.listThreadEvents(actor, thread.id),
    ).resolves.toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ eventType: "run.failed", runId }),
      ]),
    });
    await switchRecoverySubscription(context, actor);
    await flushWaitUntilForTest();
    await runs.heartbeatRunner(group);
    const continued = await runs.nextReceivedExecution(group);
    expect(continued.runId).not.toBe(runId);
    expect(continued.prompt).toBe("continue");
    expect(continued.appendSystemPrompt).toContain("Requested report");
  });
});

describe("email-native signup", () => {
  function anonymousSender() {
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [],
      totalCount: 0,
    });
    return createUniqueEmailSignupAddressFixture();
  }

  async function pendingSignup() {
    const sender = anonymousSender();
    const original = incoming({
      sender,
      text: "Please compare these options after signup",
    });
    await original.send();
    const invitation = sentEmails().find((email) => {
      return email.text.includes("\nCONFIRM\n");
    });
    const line = invitation?.text.match(/^CONFIRM$/mu)?.[0];
    expect(line).toBeTruthy();
    expect(invitation?.text).toContain("https://www.okou.ai/en/terms-of-use");
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
    const replyTo = invitation?.replyTo;
    expect(replyTo).toMatch(/^okou\+confirm-[a-f0-9]{32}@okou\.io$/u);
    return { sender, original, line: line!, replyTo: replyTo! };
  }

  async function signupProvider(sender: string) {
    const actor = bdd.user({ email: sender });
    const profile = {
      id: actor.userId,
      primaryEmailAddressId: "email_signup",
      createdAt: now(),
      firstName: null,
      lastName: null,
      username: null,
      imageUrl: "",
      privateMetadata: {},
      emailAddresses: [
        {
          id: "email_signup",
          emailAddress: sender,
          verification: { status: "verified" },
        },
      ],
    };
    let userCreated = false;
    let organizationCreated = false;
    const organization = {
      id: actor.orgId,
      name: "My workspace",
      slug: "email-signup",
      createdAt: now(),
      createdBy: actor.userId,
      imageUrl: "",
      hasImage: false,
    };
    context.mocks.clerk.users.getUser.mockResolvedValue(profile);
    context.mocks.clerk.users.getUserList.mockImplementation(() => {
      if (!userCreated) {
        return Promise.resolve({ data: [], totalCount: 0 });
      }
      return Promise.resolve({ data: [profile], totalCount: 1 });
    });
    context.mocks.clerk.users.createUser.mockImplementation(() => {
      userCreated = true;
      return Promise.resolve(profile);
    });
    context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
      () => {
        if (!organizationCreated) {
          return Promise.resolve({ data: [], totalCount: 0 });
        }
        return Promise.resolve({
          data: [
            {
              id: "membership_signup",
              role: "org:admin",
              createdAt: now(),
              organization,
              publicUserData: { userId: actor.userId },
            },
          ],
          totalCount: 1,
        });
      },
    );
    context.mocks.clerk.organizations.getOrganization.mockImplementation(() => {
      return organizationCreated
        ? Promise.resolve(organization)
        : Promise.reject(new ClerkUserNotFoundTestError());
    });
    context.mocks.clerk.organizations.createOrganization.mockImplementation(
      () => {
        organizationCreated = true;
        return Promise.resolve(organization);
      },
    );
    bdd.acceptStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const group = await runs.configureRunnerGroup();
    return { actor, group };
  }

  it("creates the account and workspace only after consent, then resumes the original request once", async () => {
    const pending = await pendingSignup();
    const { actor, group } = await signupProvider(pending.sender);
    const confirmation = incoming({
      sender: pending.sender,
      text: "\n cOnFiRm \t\r\n\nOn Tuesday, Okou wrote:\n> CONFIRM",
      to: [pending.replyTo],
    });
    await expect(confirmation.send(true)).rejects.toThrow(
      "Email workspace initialization is pending",
    );
    await deliverOrganizationCreated(context, actor);
    const emailSinceSeqId = await threadEventCursor(context, actor);
    await confirmation.send();
    expect(
      context.mocks.clerk.users.createUser,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        emailAddress: [pending.sender],
        legalAcceptedAt: expect.any(Date),
        privateMetadata: {
          emailSignup: expect.objectContaining({
            confirmationMessageId: expect.any(String),
            termsUrl: "https://www.okou.ai/en/terms-of-use",
          }),
        },
      }),
    );
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).toHaveBeenCalledTimes(1);
    await confirmation.send();
    await incoming({
      sender: pending.sender,
      text: pending.line,
      to: [pending.replyTo],
    }).send();
    await expect(bdd.readOnboardingStatus(actor)).resolves.toMatchObject({
      needsOnboarding: false,
      onboardingComplete: true,
    });
    const suggestions = setupApp({
      context,
      routes: proactiveSuggestionsRoutes,
    })(proactiveSuggestionsContract);
    const preference = await accept(
      suggestions.get({ headers: authHeaders() }),
      [200],
    );
    expect(preference.body).toMatchObject({
      enabled: true,
      unavailableReason: "missing-timezone",
    });
    const snapshot = await createdThreads({ ...actor, emailSinceSeqId });
    expect(snapshot.chatThreads).toHaveLength(1);
    const { events } = await files.listThreadEvents(
      actor,
      snapshot.chatThreads[0]!.id,
    );
    const prompts = events.filter((event) => {
      return event.eventType === "input.prompt" && !event.revokesEventId;
    });
    expect(prompts).toHaveLength(1);
    await runs.heartbeatRunner(group);
    const execution = await runs.nextReceivedExecution(group);
    expect(execution.prompt).toContain(
      "Please compare these options after signup",
    );
    expect(execution.prompt).not.toContain(pending.line);
    verifiedDirectory(actor);
    await expect(
      emailClient().getLinkStatus({ headers: authHeaders() }),
    ).resolves.toMatchObject({
      status: 200,
      body: { emails: [pending.sender] },
    });
    const runId = execution.runId;
    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "result",
            sequenceNumber: 0,
            result: "Your first email request is complete",
          },
        ],
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId,
        exitCode: 0,
        lastEventSequence: 0,
        completion: {
          cliAgentType: execution.cliAgentType,
          cliAgentSessionId: execution.piSessionId ?? `email-signup-${runId}`,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect(sentEmails().at(-1)).toMatchObject({
      replyTo: "okou@okou.io",
      to: pending.sender,
      text: "Your first email request is complete",
    });
  });

  it.each(["domain", "uppercase-address"] as const)(
    "refuses a Clerk-blocked sender matching %s before confirming or creating an account",
    async (kind) => {
      const sender = anonymousSender();
      const identifier =
        kind === "domain" ? `*@${sender.split("@")[1]}` : sender.toUpperCase();
      context.mocks.clerk.blocklistIdentifiers.getBlocklistIdentifierList.mockResolvedValue(
        { data: [{ identifier }], totalCount: 1 },
      );
      await incoming({ sender }).send();
      expect(sentEmails()).toMatchObject([
        {
          to: sender,
          text: expect.stringContaining("did not pass our security checks"),
        },
      ]);
      expect(sentEmails()[0]!.text).not.toContain("CONFIRM");
      expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
      expect(
        context.mocks.clerk.organizations.createOrganization,
      ).not.toHaveBeenCalled();
    },
  );

  it("refuses email-native signup for a disposable address", async () => {
    const sender = `disposable-${randomUUID()}@mailinator.com`;
    const actor = bdd.user({
      email: sender,
      orgId: createUniqueStaffOrgIdFixture(),
    });
    verifiedDirectory(actor);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          role: "org:admin",
          organization: { id: actor.orgId, name: "Workspace" },
        },
        {
          role: "org:admin",
          organization: {
            id: createUniqueStaffOrgIdFixture(),
            name: "Other workspace",
          },
        },
      ],
      totalCount: 2,
    });
    await incoming({ sender }).send();
    expect(sentEmails()).toMatchObject([
      {
        to: sender,
        text: expect.stringContaining("did not pass our security checks"),
      },
    ]);
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
    await expect(createdThreads(actor)).resolves.toStrictEqual({
      chatThreads: [],
    });
    await expect(
      emailClient().getLinkStatus({ headers: authHeaders() }),
    ).resolves.toMatchObject({ status: 200, body: { emails: [sender] } });
  });

  it.each(["> CONFIRM", "Please CONFIRM this account"])(
    "does not register when the reply only contains or quotes CONFIRM: %s",
    async (text) => {
      const pending = await pendingSignup();
      await incoming({
        sender: pending.sender,
        text,
        to: [pending.replyTo],
      }).send();
      expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
      expect(
        sentEmails().filter((email) => {
          return email.text.includes("\nCONFIRM\n");
        }),
      ).toHaveLength(1);
    },
  );

  it("rejects another mailbox's confirmation reply address without creating or running anything", async () => {
    const pending = await pendingSignup();
    const other = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
    verifiedDirectory(other);
    await incoming({
      sender: other.email,
      text: pending.line,
      to: [pending.replyTo],
    }).send();
    expect(sentEmails().at(-1)?.text).toContain("invalid or expired");
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
    await expect(createdThreads(other)).resolves.toStrictEqual({
      chatThreads: [],
    });
  });

  it("rejects expired consent and does not create an account", async () => {
    const pending = await pendingSignup();
    const confirmation = incoming({
      sender: pending.sender,
      text: pending.line,
      to: [pending.replyTo],
    });
    mockNow(now() + 25 * 60 * 60 * 1000);
    await confirmation.send();
    expect(sentEmails().at(-1)?.text).toContain("invalid or expired");
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
  });

  it("rejects an unissued confirmation reply address without creating an account", async () => {
    const pending = await pendingSignup();
    const forged = incoming({
      sender: pending.sender,
      text: pending.line,
      to: [`okou+confirm-${randomUUID().replaceAll("-", "")}@okou.io`],
    });
    await forged.send();
    expect(sentEmails().at(-1)?.text).toContain("invalid or expired");
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
  });

  it("requires the issued reply address even when CONFIRM references the original request", async () => {
    const pending = await pendingSignup();
    await incoming({
      sender: pending.sender,
      text: pending.line,
      inReplyTo: pending.original.messageId,
    }).send();
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
    expect(sentEmails()).toMatchObject([
      { text: expect.stringContaining("\nCONFIRM\n") },
      { text: expect.stringContaining("\nCONFIRM\n") },
    ]);
  });

  it("does not accuse a sender when the Clerk precheck is unavailable, and recovers on redelivery", async () => {
    const unavailable = new ClerkTransportTestError(403, [
      { code: "authorization_invalid", message: "Unauthorized" },
    ]);
    context.mocks.clerk.blocklistIdentifiers.getBlocklistIdentifierList.mockRejectedValueOnce(
      unavailable,
    );
    const message = incoming({ sender: anonymousSender() });
    await expect(message.send(true)).rejects.toBe(unavailable);
    expect(sentEmails()).toHaveLength(0);
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
    await message.send();
    expect(sentEmails()).toMatchObject([
      { text: expect.stringContaining("\nCONFIRM\n") },
    ]);
  });

  it("bounds unconfirmed signup messages from one sender", async () => {
    const sender = anonymousSender();
    for (let index = 0; index < 4; index += 1) {
      await incoming({
        sender,
        text: `Request ${index}`,
      }).send();
    }
    expect(
      sentEmails().filter((email) => {
        return email.text.includes("\nCONFIRM\n");
      }),
    ).toHaveLength(3);
    expect(context.mocks.clerk.users.createUser).not.toHaveBeenCalled();
  });

  it("preserves Clerk's authoritative rejection after a successful precheck", async () => {
    const pending = await pendingSignup();
    await signupProvider(pending.sender);
    context.mocks.clerk.users.createUser.mockRejectedValue(
      new ClerkTransportTestError(403, [
        {
          code: "not_allowed_access",
          message: "This identifier is not allowed",
        },
      ]),
    );
    await incoming({
      sender: pending.sender,
      text: pending.line,
      to: [pending.replyTo],
    }).send();
    expect(sentEmails().at(-1)?.text).toContain(
      "did not pass our security checks",
    );
    expect(
      context.mocks.clerk.organizations.createOrganization,
    ).not.toHaveBeenCalled();
  });
});

function incoming(options: {
  readonly sender: string;
  readonly to?: readonly string[];
  readonly messageId?: string;
  readonly subject?: string;
  readonly text?: string;
  readonly inReplyTo?: string;
  readonly authenticated?: boolean;
  readonly attachments?: readonly {
    readonly id: string;
    readonly filename: string | null;
  }[];
  readonly authentication?: {
    readonly spf: string;
    readonly dkim: string;
    readonly dmarc: string;
  };
}) {
  const id = randomUUID();
  const messageId = options.messageId ?? `<${randomUUID()}@sender.example>`;
  server.use(
    http.get(`https://api.resend.com/emails/receiving/${id}`, () => {
      return HttpResponse.json({
        id,
        from: options.sender,
        to: options.to ?? ["okou@okou.io"],
        message_id: messageId,
        subject: options.subject ?? "A request",
        text: options.text ?? "Please compare these options",
        html: null,
        headers: options.inReplyTo
          ? { "In-Reply-To": options.inReplyTo, References: options.inReplyTo }
          : {},
        authentication: options.authentication ?? {
          spf: "pass",
          dkim: "pass",
          dmarc: options.authenticated === false ? "fail" : "pass",
        },
        attachments: options.attachments ?? [],
      });
    }),
  );
  const event = {
    type: "email.received",
    data: { email_id: id, to: options.to ?? ["okou@okou.io"] },
  };
  const signedHeaders = webhooks.signedResendWebhookHeaders(event);
  return {
    id,
    messageId,
    async send(rethrowErrors = false) {
      await accept(
        setupApp({ context, routes: emailInboundRoutes, rethrowErrors })(
          emailInboundContract,
        ).post({ body: event, headers: signedHeaders }),
        [200],
      );
      await flushWaitUntilForTest();
    },
  };
}

async function entitledActor(email?: string) {
  const orgId = createUniqueStaffOrgIdFixture();
  const actor = bdd.user({
    orgId,
    ...(email ? { email } : {}),
  });
  bdd.acceptStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const group = await runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);
  const emailSinceSeqId = await threadEventCursor(context, actor);
  verifiedDirectory(actor);
  return { actor: { ...actor, orgId, emailSinceSeqId }, group };
}

async function createdThreads(
  actor: ApiTestUser & { readonly emailSinceSeqId?: number },
) {
  const response = await files.requestThreadEvents(
    actor,
    { sinceSeqId: actor.emailSinceSeqId },
    [200],
  );
  if (response.status !== 200) {
    throw new Error("Expected thread lifecycle events");
  }
  return {
    chatThreads: response.body.events
      .filter((event) => {
        return event.kind === "created";
      })
      .map((event) => {
        return { id: event.chatThreadId };
      }),
  };
}

async function connectEmailMailbox(
  actor: ApiTestUser,
  provider: "gmail" | "outlook-mail",
  address: string,
) {
  if (provider === "gmail") {
    mockGmailConnectorOAuth({ email: address, subject: randomUUID() });
  } else {
    mockOptionalEnv("MICROSOFT_OAUTH_CLIENT_ID", "email-outlook-client");
    mockOptionalEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "email-outlook-secret");
    server.use(
      http.post(
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        () => {
          return HttpResponse.json({
            access_token: "email-outlook-token",
            refresh_token: "email-outlook-refresh",
            expires_in: 3600,
          });
        },
      ),
      http.get("https://graph.microsoft.com/v1.0/me", () => {
        return HttpResponse.json({
          id: randomUUID(),
          mail: address,
          displayName: "Email Outlook",
        });
      }),
    );
  }
  const started = await connectorsApi.startOauth(actor, provider, "oauth");
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) {
    throw new Error("Expected OAuth state");
  }
  const completed = await connectorsApi.completeOauthCallbackResult(provider, {
    code: "email-channel-oauth",
    state,
  });
  expect(completed.body).toMatchObject({ status: "success" });
  const accounts = await connectorsApi.requestBuiltinConnectorAccounts(
    actor,
    provider,
    [200],
  );
  if (accounts.status !== 200) {
    throw new Error("Expected connected mailbox accounts");
  }
  const account = accounts.body.connections.find((connection) => {
    return connection.externalEmail === address;
  });
  if (!account) {
    throw new Error("Expected the connected mailbox identity");
  }
  return account;
}

async function setGmailContextReadPermission(action: "allow" | "deny") {
  await accept(
    setupApp({ context, routes: connectorPermissionsRoutes })(
      connectorPermissionsContract,
    ).apply({
      headers: authHeaders(),
      body: {
        target: { kind: "builtin", connectorSlug: "gmail" },
        mode: "patch",
        grants: [
          { permission: "messages.read", action },
          { permission: "messages.detail", action },
          { permission: "threads.read", action },
        ],
      },
    }),
    [200],
  );
}

async function readPendingEmailExecution(
  group: Awaited<ReturnType<typeof runs.configureRunnerGroup>>,
) {
  await runs.heartbeatRunner(group);
  return await runs.nextReceivedExecution(group);
}

async function startEmailRun(
  actor: ApiTestUser,
  group: Awaited<ReturnType<typeof runs.configureRunnerGroup>>,
) {
  const initial = incoming({ sender: actor.email });
  await initial.send();
  return {
    messageId: initial.messageId,
    execution: await readPendingEmailExecution(group),
  };
}

async function readActiveEmailPrompt(
  execution: Awaited<ReturnType<typeof readPendingEmailExecution>>,
  message: ReturnType<typeof incoming>,
) {
  await message.send();
  const { input } = await runs.nextSteerableInput(
    execution.sandboxToken,
    execution.runId,
  );
  if (!input) {
    throw new Error("Expected the active Email input");
  }
  return input.prompt;
}

function mockEmailMessageLookup(
  provider: "gmail" | "outlook-mail",
  messageId: string,
  body: string,
  found = true,
  history: readonly {
    readonly id: string;
    readonly messageId: string;
    readonly body: string;
    readonly receivedAt: number;
    readonly from?: string;
    readonly conversationId?: string;
    readonly isDraft?: boolean;
  }[] = [],
) {
  const providerMessageId = `source-${randomUUID()}`;
  const providerConversationId = `conversation-${randomUUID()}`;
  const receivedAt = now();
  if (provider === "gmail") {
    const gmailMessage = (entry: (typeof history)[number]) => {
      return {
        id: entry.id,
        threadId: entry.conversationId ?? providerConversationId,
        internalDate: String(entry.receivedAt),
        labelIds: entry.isDraft ? ["DRAFT"] : [],
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Message-ID", value: entry.messageId },
            { name: "Subject", value: "API message subject" },
            {
              name: "From",
              value: entry.from ?? "Reviewer <reviewer@example.com>",
            },
            { name: "Date", value: new Date(entry.receivedAt).toUTCString() },
          ],
          body: { data: Buffer.from(entry.body).toString("base64url") },
        },
      };
    };
    const current = gmailMessage({
      id: providerMessageId,
      messageId,
      body,
      receivedAt,
    });
    server.use(
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("q")).toBe(
            `rfc822msgid:${messageId}`,
          );
          return HttpResponse.json({
            messages: found ? [{ id: providerMessageId }] : [],
          });
        },
      ),
      http.get(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${providerMessageId}`,
        () => {
          return HttpResponse.json(current);
        },
      ),
      http.get(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${providerConversationId}`,
        () => {
          return HttpResponse.json({
            id: providerConversationId,
            messages: [...history.map(gmailMessage), current],
          });
        },
      ),
    );
  } else {
    const outlookMessage = (entry: (typeof history)[number]) => {
      return {
        id: entry.id,
        conversationId: entry.conversationId ?? providerConversationId,
        internetMessageId: entry.messageId,
        receivedDateTime: new Date(entry.receivedAt).toISOString(),
        isDraft: entry.isDraft ?? false,
        internetMessageHeaders: [
          {
            name: "From",
            value: entry.from ?? "Reviewer <reviewer@example.com>",
          },
          { name: "Date", value: new Date(entry.receivedAt).toUTCString() },
        ],
        subject: "API message subject",
        body: { contentType: "text", content: entry.body },
      };
    };
    const current = outlookMessage({
      id: providerMessageId,
      messageId,
      body,
      receivedAt,
    });
    server.use(
      http.get(
        "https://graph.microsoft.com/v1.0/me/messages",
        ({ request }) => {
          const filter = new URL(request.url).searchParams.get("$filter");
          if (filter?.startsWith("receivedDateTime le ")) {
            expect(filter).toBe(
              `receivedDateTime le ${new Date(receivedAt).toISOString()} and conversationId eq '${providerConversationId}' and isDraft eq false`,
            );
            return HttpResponse.json({
              value: [current, ...history.map(outlookMessage)],
            });
          }
          expect(new URL(request.url).searchParams.get("$filter")).toBe(
            `internetMessageId eq '${messageId.replaceAll("'", "''")}'`,
          );
          expect(request.headers.get("Prefer")).toContain(
            'IdType="ImmutableId"',
          );
          return HttpResponse.json({
            value: found
              ? [{ id: providerMessageId, internetMessageId: messageId }]
              : [],
          });
        },
      ),
      http.get(
        `https://graph.microsoft.com/v1.0/me/messages/${providerMessageId}`,
        () => {
          return HttpResponse.json(current);
        },
      ),
    );
  }
  return { providerMessageId, providerConversationId };
}

function sentEmails() {
  return context.mocks.resend.send.mock.calls.map((call) => {
    return object({
      to: string(),
      text: string(),
      replyTo: string().optional(),
      headers: record(string(), string()),
      attachments: array(
        object({ filename: string(), contentType: string(), path: string() }),
      ).optional(),
    }).parse(call[0]);
  });
}

function emailThreadMessages(prompt: string | null | undefined) {
  const block = prompt
    ?.split("# Email Thread Context")[1]
    ?.split("# This Chat Thread")[0];
  if (!block) {
    throw new Error("Expected Email thread context");
  }
  return block
    .split(/\n\n---(?:\n\n|$)/)
    .slice(1)
    .map((message) => {
      return message.trim();
    })
    .filter(Boolean);
}

describe("Email integration", () => {
  it.each(["gmail", "outlook-mail"] as const)(
    "starts with the received email when %s is unavailable and enriches active input",
    async (provider) => {
      const { actor, group } = await entitledActor();

      const mailbox = await connectEmailMailbox(actor, provider, actor.email);
      const disabled = await connectEmailMailbox(
        actor,
        provider,
        `${randomUUID()}@private-mailbox.example`,
      );
      verifiedDirectory(actor);
      await accept(
        setupApp({ context, routes: chatConnectorAccessRoutes })(
          chatConnectorAccessContract,
        ).updateAccountPolicy({
          headers: authHeaders(),
          params: { connectionId: disabled.id },
          body: {
            target: { kind: "builtin", connectorSlug: provider },
            policy: "deny",
          },
        }),
        [200],
      );
      if (provider === "gmail") {
        await setGmailContextReadPermission("allow");
      }
      const parentId = `<${randomUUID()}@original.example>`;
      const message = incoming({
        sender: actor.email,
        subject: "Fwd: Customer discussion",
        text: "Please review this forwarded message.\nOriginal message content",
        inReplyTo: parentId,
      });
      let mailboxRequests = 0;
      server.use(
        http.get(
          provider === "gmail"
            ? "https://gmail.googleapis.com/gmail/v1/users/me/messages"
            : "https://graph.microsoft.com/v1.0/me/messages",
          () => {
            mailboxRequests += 1;
            return HttpResponse.json({ error: "unavailable" }, { status: 503 });
          },
        ),
      );
      const titleRequests: string[] = [];
      const expectedTitle = "Review customer discussion";
      mockGoogleText();
      createChatCallbacksApi(context).mockVertexCompletions((body) => {
        if (
          body.messages[0]?.content.includes(
            "Generate a short, descriptive title",
          )
        ) {
          const content = body.messages[1]?.content ?? "";
          titleRequests.push(content);
          return content.includes("Original message content")
            ? expectedTitle
            : "Review email";
        }
        return "Thinking";
      });
      await message.send();
      const threadEvents = await accept(
        files.requestThreadEvents(actor, {}, [200]),
        [200],
      );
      expect(threadEvents.body.events).toContainEqual(
        expect.objectContaining({ kind: "renamed", title: expectedTitle }),
      );
      expect(titleRequests).toHaveLength(1);
      expect(titleRequests[0]).toContain("Original message content");
      expect(titleRequests[0]).toContain('Subject: "Fwd: Customer discussion"');
      const execution = await readPendingEmailExecution(group);
      const runId = execution.runId;
      expect(execution.prompt).toContain("Original message content");
      expect(mailboxRequests).toBe(0);
      expect(execution.appendSystemPrompt).toContain(
        'Subject: "Fwd: Customer discussion"',
      );
      expect(execution.appendSystemPrompt).toContain(
        JSON.stringify(message.messageId),
      );
      expect(execution.appendSystemPrompt).toContain(
        "Find a single exact match for the RFC Message-ID",
      );
      const tokenName =
        provider === "gmail" ? "GMAIL_TOKEN" : "OUTLOOK_MAIL_TOKEN";
      expect(execution.appendSystemPrompt).toContain(tokenName);
      expect(execution.environment).toHaveProperty(tokenName);
      expect(execution.firewalls).toContainEqual({
        kind: "builtin",
        name: provider,
        sourceId: mailbox.id,
      });
      if (provider === "outlook-mail") {
        expect(execution.appendSystemPrompt).toContain(
          "X-Okou-Connector-Intent: outlook-mail",
        );
        expect(execution.appendSystemPrompt).toContain(
          'Prefer: IdType="ImmutableId"',
        );
      }
      expect(execution.appendSystemPrompt).toContain(
        `In-Reply-To: ${JSON.stringify(parentId)}`,
      );
      expect(execution.appendSystemPrompt).toContain(
        `References: ${JSON.stringify([parentId])}`,
      );
      const prefix = "Connected mailbox for this Run: ";
      const mailboxes = (execution.appendSystemPrompt ?? "")
        .split("\n")
        .filter((line) => {
          return line.startsWith(prefix);
        })
        .map((line) => {
          return object({
            connectorSlug: string(),
            connectionId: string(),
            emailAddress: string().nullable(),
            displayName: string().nullable(),
          })
            .strict()
            .parse(JSON.parse(line.slice(prefix.length)));
        });
      expect(mailboxes).toStrictEqual([
        {
          connectorSlug: provider,
          connectionId: mailbox.id,
          emailAddress: actor.email,
          displayName: mailbox.displayName,
        },
      ]);
      const followUp = incoming({
        sender: actor.email,
        inReplyTo: message.messageId,
        text: "A follow-up while the Run is active",
      });
      const followUpBody = `API follow-up body ${randomUUID()}`;
      const followUpHistory = `Earlier thread context for active input ${randomUUID()}`;
      const followUpHistoryReceivedAt = now() - 1000;
      const source = mockEmailMessageLookup(
        provider,
        followUp.messageId,
        followUpBody,
        true,
        [
          {
            id: randomUUID(),
            messageId: message.messageId,
            body: followUpHistory,
            receivedAt: followUpHistoryReceivedAt,
          },
        ],
      );
      await followUp.send();
      const next = await runs.nextSteerableInput(execution.sandboxToken, runId);
      expect(next.input?.prompt).toContain(
        "A follow-up while the Run is active",
      );
      expect(next.input?.prompt).toContain(followUpBody);
      expect(next.input?.prompt).toContain(followUpHistory);
      expect(next.input?.prompt).toContain("- LOOKUP_STATUS: found");
      expect(next.input?.prompt).toContain(source.providerMessageId);
      expect(next.input?.prompt).toContain(source.providerConversationId);
      const history = emailThreadMessages(next.input?.prompt);
      expect(history).toStrictEqual([expect.stringContaining(followUpHistory)]);
      expect(history[0]).toContain(
        "- RELATIVE_INDEX: -1\n- SENDER: {id: Reviewer <reviewer@example.com>}",
      );
      expect(history[0]).toContain(
        `- DATE: ${JSON.stringify(new Date(followUpHistoryReceivedAt).toUTCString())}`,
      );
      expect(next.input?.prompt).toMatch(
        /# Integration Note[\s\S]*# Email Message Context[\s\S]*# Email Thread Context[\s\S]*# This Chat Thread[\s\S]*A follow-up while the Run is active/,
      );
      if (provider === "gmail") {
        if (!next.input) {
          throw new Error("Expected the active Email input");
        }
        await runs.declareSteeredInput(
          execution.sandboxToken,
          runId,
          next.input.eventId,
        );
        await setGmailContextReadPermission("deny");
        server.use(
          http.get(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages",
            () => {
              mailboxRequests += 1;
              return HttpResponse.json(
                { error: "unexpected request" },
                { status: 503 },
              );
            },
          ),
        );
        await incoming({
          sender: actor.email,
          inReplyTo: followUp.messageId,
          text: "A follow-up after mailbox reads were revoked",
        }).send();
        const revoked = await runs.nextSteerableInput(
          execution.sandboxToken,
          runId,
        );
        expect(revoked.input?.prompt).toContain(
          "A follow-up after mailbox reads were revoked",
        );
        expect(revoked.input?.prompt).toContain(
          "- LOOKUP_STATUS: permission-required",
        );
        expect(mailboxRequests).toBe(0);
      }
    },
  );

  it.each(["gmail", "outlook-mail"] as const)(
    "adds chronological %s history to active input without repeating quoted bodies, current messages or unrelated mail",
    async (provider) => {
      const { actor, group } = await entitledActor();
      await connectEmailMailbox(actor, provider, actor.email);
      verifiedDirectory(actor);
      if (provider === "gmail") {
        await setGmailContextReadPermission("allow");
      }
      const receivedBody =
        "Please explain this reply.\n\nAlready forwarded\noriginal text";
      const { execution, messageId } = await startEmailRun(actor, group);
      const message = incoming({
        sender: actor.email,
        inReplyTo: messageId,
        text: receivedBody,
      });
      const older = {
        id: randomUUID(),
        messageId: `<${randomUUID()}@original.example>`,
        body: "The first application was submitted in March.",
        receivedAt: now() - 3000,
        from: "Application team <applications@example.com>",
      };
      const newer = {
        id: randomUUID(),
        messageId: `<${randomUUID()}@original.example>`,
        body: "The October submission was a rebrand.",
        receivedAt: now() - 1000,
        from: "Marketplace reviewer <reviewer@example.com>",
      };
      mockEmailMessageLookup(provider, message.messageId, receivedBody, true, [
        newer,
        older,
        { ...newer, id: randomUUID() },
        {
          id: randomUUID(),
          messageId: `<${randomUUID()}@original.example>`,
          body: "Already forwarded\r\noriginal text",
          receivedAt: now() - 2000,
        },
        {
          id: randomUUID(),
          messageId: message.messageId,
          body: "A second provider copy of the current message",
          receivedAt: now(),
        },
        {
          id: randomUUID(),
          messageId: `<${randomUUID()}@original.example>`,
          body: "A reply received after the current forward",
          receivedAt: now() + 60_000,
        },
        {
          id: randomUUID(),
          messageId: `<${randomUUID()}@other.example>`,
          body: "Private mail in another conversation",
          receivedAt: now() - 1000,
          conversationId: randomUUID(),
        },
        {
          id: randomUUID(),
          messageId: `<${randomUUID()}@original.example>`,
          body: "An unsent draft in this conversation",
          receivedAt: now() - 1000,
          isDraft: true,
        },
      ]);
      const prompt = await readActiveEmailPrompt(execution, message);
      const history = emailThreadMessages(prompt);
      expect(history).toHaveLength(3);
      expect(history[0]).toContain("- RELATIVE_INDEX: -3");
      expect(history[0]).toContain(
        "- SENDER: {id: Application team <applications@example.com>}",
      );
      expect(history[0]).toContain(
        `- PROVIDER_MESSAGE_ID: ${JSON.stringify(older.id)}`,
      );
      expect(history[0]).toContain(older.body);
      expect(history[0]).toContain("- BODY_ALREADY_INCLUDED: false");
      expect(history[1]).toContain("- RELATIVE_INDEX: -2");
      expect(history[1]).toContain("- BODY_ALREADY_INCLUDED: true");
      expect(history[2]).toContain("- RELATIVE_INDEX: -1");
      expect(history[2]).toContain(
        "- SENDER: {id: Marketplace reviewer <reviewer@example.com>}",
      );
      expect(history[2]).toContain(
        `- PROVIDER_MESSAGE_ID: ${JSON.stringify(newer.id)}`,
      );
      expect(history[2]).toContain(newer.body);
      expect(history[2]).toContain("- BODY_ALREADY_INCLUDED: false");
      expect(prompt).toContain("- HISTORY_MESSAGE_COUNT: 3");
      expect(prompt).toContain("- HISTORY_TRUNCATED: false");
      expect(history.join("\n")).not.toContain("Already forwarded");
      expect(prompt).not.toContain("second provider copy");
      expect(prompt).not.toContain("after the current forward");
      expect(prompt).not.toContain("Private mail");
      expect(prompt).not.toContain("unsent draft");
    },
  );

  it.each(["gmail", "outlook-mail"] as const)(
    "bounds %s history and explicitly reports omitted messages and body truncation",
    async (provider) => {
      const { actor, group } = await entitledActor();
      await connectEmailMailbox(actor, provider, actor.email);
      verifiedDirectory(actor);
      if (provider === "gmail") {
        await setGmailContextReadPermission("allow");
      }
      const { execution, messageId } = await startEmailRun(actor, group);
      const message = incoming({ sender: actor.email, inReplyTo: messageId });
      const history = Array.from({ length: 25 }, (_, index) => {
        return {
          id: randomUUID(),
          messageId: `<${randomUUID()}@original.example>`,
          body: `${index}: ` + String(index).repeat(9000),
          receivedAt: now() - (25 - index) * 1000,
        };
      });
      mockEmailMessageLookup(
        provider,
        message.messageId,
        "Current reply",
        true,
        history,
      );
      const prompt = await readActiveEmailPrompt(execution, message);
      const loaded = emailThreadMessages(prompt);
      expect(prompt).toContain("- HISTORY_STATUS: found");
      expect(prompt).toContain("- HISTORY_TRUNCATED: true");
      expect(prompt).toContain("- HISTORY_MESSAGE_COUNT: 20");
      expect(loaded).toHaveLength(20);
      expect(loaded[0]).toContain("- RELATIVE_INDEX: -20");
      expect(loaded[0]).toContain(
        `- PROVIDER_MESSAGE_ID: ${JSON.stringify(history[5]?.id)}`,
      );
      expect(loaded.at(-1)).toContain("- RELATIVE_INDEX: -1");
      expect(loaded.at(-1)).toContain("- BODY_TRUNCATED: true");
      const bodies = loaded.join("\n").match(/\d+: \d+/g) ?? [];
      expect(bodies.at(-1)).toHaveLength(8000);
      expect(
        bodies.reduce((total, body) => {
          return total + body.length;
        }, 0),
      ).toBeLessThanOrEqual(40_000);
    },
  );

  it("retains the exact message and reports denied thread history without reading it", async () => {
    const { actor, group } = await entitledActor();
    await connectEmailMailbox(actor, "gmail", actor.email);
    verifiedDirectory(actor);
    await setGmailContextReadPermission("allow");
    await accept(
      setupApp({ context, routes: connectorPermissionsRoutes })(
        connectorPermissionsContract,
      ).apply({
        headers: authHeaders(),
        body: {
          target: { kind: "builtin", connectorSlug: "gmail" },
          mode: "patch",
          grants: [{ permission: "threads.read", action: "deny" }],
        },
      }),
      [200],
    );
    const { execution, messageId } = await startEmailRun(actor, group);
    const message = incoming({ sender: actor.email, inReplyTo: messageId });
    const source = mockEmailMessageLookup(
      "gmail",
      message.messageId,
      "Exact message retained",
    );
    server.use(
      http.get(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${source.providerConversationId}`,
        () => {
          throw new Error("Denied history must not be requested");
        },
      ),
    );
    const prompt = await readActiveEmailPrompt(execution, message);
    expect(prompt).toContain("Exact message retained");
    expect(prompt).toContain("- HISTORY_STATUS: permission-required");
  });

  it.each([
    { status: 404, expected: "not-found" },
    { status: 503, expected: "provider-unavailable" },
    { status: 200, expected: "provider-unavailable" },
  ])(
    "retains the exact message when the history response has status $status or invalid data",
    async ({ status, expected }) => {
      const { actor, group } = await entitledActor();
      await connectEmailMailbox(actor, "gmail", actor.email);
      verifiedDirectory(actor);
      await setGmailContextReadPermission("allow");
      const { execution, messageId } = await startEmailRun(actor, group);
      const message = incoming({ sender: actor.email, inReplyTo: messageId });
      const source = mockEmailMessageLookup(
        "gmail",
        message.messageId,
        "Current message survives history failure",
      );
      server.use(
        http.get(
          `https://gmail.googleapis.com/gmail/v1/users/me/threads/${source.providerConversationId}`,
          () => {
            return HttpResponse.json({ error: "unavailable" }, { status });
          },
        ),
      );
      const prompt = await readActiveEmailPrompt(execution, message);
      expect(prompt).toContain("Current message survives history failure");
      expect(prompt).toContain(`- HISTORY_STATUS: ${expected}`);
    },
  );

  it("marks active Outlook history incomplete when the provider has another page", async () => {
    const { actor, group } = await entitledActor();
    await connectEmailMailbox(actor, "outlook-mail", actor.email);
    verifiedDirectory(actor);
    const { execution, messageId } = await startEmailRun(actor, group);
    const message = incoming({ sender: actor.email, inReplyTo: messageId });
    mockEmailMessageLookup(
      "outlook-mail",
      message.messageId,
      "Current message",
    );
    server.use(
      http.get(
        "https://graph.microsoft.com/v1.0/me/messages",
        ({ request }) => {
          if (
            !new URL(request.url).searchParams
              .get("$filter")
              ?.startsWith("receivedDateTime le ")
          ) {
            return;
          }
          return HttpResponse.json({
            value: [],
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/me/messages?$skip=10",
          });
        },
      ),
    );
    const prompt = await readActiveEmailPrompt(execution, message);
    expect(prompt).toContain("- HISTORY_STATUS: found");
    expect(prompt).toContain("- HISTORY_TRUNCATED: true");
    expect(prompt).toContain("- HISTORY_MESSAGE_COUNT: 0");
  });

  it("retains the exact message when thread history exceeds the lookup deadline", async () => {
    const { actor, group } = await entitledActor();
    await connectEmailMailbox(actor, "gmail", actor.email);
    verifiedDirectory(actor);
    await setGmailContextReadPermission("allow");
    const { execution, messageId } = await startEmailRun(actor, group);
    const message = incoming({ sender: actor.email, inReplyTo: messageId });
    const source = mockEmailMessageLookup(
      "gmail",
      message.messageId,
      "Current message survives a slow history provider",
    );
    server.use(
      http.get(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${source.providerConversationId}`,
        async ({ request }) => {
          const blocked = createDeferredPromise<Response>(context.signal);
          const finish = () => {
            blocked.resolve(
              HttpResponse.json({ error: "cancelled" }, { status: 504 }),
            );
          };
          if (request.signal.aborted) {
            finish();
          } else {
            request.signal.addEventListener("abort", finish, { once: true });
          }
          return await blocked.promise;
        },
      ),
    );
    const prompt = await readActiveEmailPrompt(execution, message);
    expect(prompt).toContain(
      "Current message survives a slow history provider",
    );
    expect(prompt).toContain("- HISTORY_STATUS: lookup-timed-out");
  }, 15_000);

  it.each(["gmail", "outlook-mail"] as const)(
    "retains the received email when %s has no exact RFC Message-ID match",
    async (provider) => {
      const { actor, group } = await entitledActor();
      await connectEmailMailbox(actor, provider, actor.email);
      verifiedDirectory(actor);
      const { execution, messageId } = await startEmailRun(actor, group);
      const message = incoming({
        sender: actor.email,
        inReplyTo: messageId,
        text: "Only the received forward is available",
      });
      mockEmailMessageLookup(provider, message.messageId, "", false);
      const prompt = await readActiveEmailPrompt(execution, message);
      expect(prompt).toContain("Only the received forward is available");
      expect(prompt).toContain("- LOOKUP_STATUS: not-found");
    },
  );

  it("refreshes rejected Gmail credentials before fetching and appending the exact message", async () => {
    const { actor, group } = await entitledActor();

    await connectEmailMailbox(actor, "gmail", actor.email);
    verifiedDirectory(actor);
    await setGmailContextReadPermission("allow");
    const { execution, messageId } = await startEmailRun(actor, group);
    const message = incoming({ sender: actor.email, inReplyTo: messageId });
    const source = mockEmailMessageLookup(
      "gmail",
      message.messageId,
      "Body read after OAuth refresh",
    );
    server.use(
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        expect(
          new URLSearchParams(await request.text()).get("grant_type"),
        ).toBe("refresh_token");
        return HttpResponse.json({
          access_token: "refreshed-email-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }),
      http.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        ({ request }) => {
          return request.headers.get("Authorization") ===
            "Bearer refreshed-email-token"
            ? HttpResponse.json({
                messages: [{ id: source.providerMessageId }],
              })
            : HttpResponse.json({ error: "expired" }, { status: 401 });
        },
      ),
    );
    const prompt = await readActiveEmailPrompt(execution, message);
    expect(prompt).toContain("Body read after OAuth refresh");
  });

  it("retains the received email when the mailbox provider is unavailable", async () => {
    const { actor, group } = await entitledActor();
    await connectEmailMailbox(actor, "outlook-mail", actor.email);
    verifiedDirectory(actor);
    server.use(
      http.get("https://graph.microsoft.com/v1.0/me/messages", () => {
        return HttpResponse.json(
          { error: "temporarily unavailable" },
          { status: 503 },
        );
      }),
    );
    const { execution, messageId } = await startEmailRun(actor, group);
    const message = incoming({
      sender: actor.email,
      inReplyTo: messageId,
      text: "Continue from this received message",
    });
    const prompt = await readActiveEmailPrompt(execution, message);
    expect(prompt).toContain("Continue from this received message");
    expect(prompt).toContain("- LOOKUP_STATUS: provider-unavailable");
  });

  it("retains the received email when the mailbox response stream terminates", async () => {
    const { actor, group } = await entitledActor();
    await connectEmailMailbox(actor, "outlook-mail", actor.email);
    verifiedDirectory(actor);
    server.use(
      http.get("https://graph.microsoft.com/v1.0/me/messages", () => {
        return new HttpResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"value":'));
            },
            pull(controller) {
              controller.error(new TypeError("Provider response terminated"));
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const { execution, messageId } = await startEmailRun(actor, group);
    const message = incoming({
      sender: actor.email,
      inReplyTo: messageId,
      text: "Continue despite the interrupted mailbox response",
    });
    const prompt = await readActiveEmailPrompt(execution, message);
    expect(prompt).toContain(
      "Continue despite the interrupted mailbox response",
    );
    expect(prompt).toContain("- LOOKUP_STATUS: provider-unavailable");
  });

  it("does not append a provider message with a different RFC Message-ID", async () => {
    const { actor, group } = await entitledActor();

    await connectEmailMailbox(actor, "gmail", actor.email);
    verifiedDirectory(actor);
    await setGmailContextReadPermission("allow");
    const { execution, messageId } = await startEmailRun(actor, group);
    const message = incoming({ sender: actor.email, inReplyTo: messageId });
    const source = mockEmailMessageLookup(
      "gmail",
      message.messageId,
      "Unrelated private body",
    );
    server.use(
      http.get(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${source.providerMessageId}`,
        () => {
          return HttpResponse.json({
            id: source.providerMessageId,
            threadId: source.providerConversationId,
            internalDate: String(now()),
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Message-ID", value: "<another@example.test>" },
              ],
              body: {
                data: Buffer.from("Unrelated private body").toString(
                  "base64url",
                ),
              },
            },
          });
        },
      ),
    );
    const prompt = await readActiveEmailPrompt(execution, message);
    expect(prompt).toContain("- LOOKUP_STATUS: not-found");
    expect(prompt).not.toContain("Unrelated private body");
  });

  it("provides Email system context and privately delivers an attachment once in the original conversation", async () => {
    const {
      actor,
      execution: receivedExecution,
      token,
      message,
    } = await startEmailFileExecution();
    expect(receivedExecution.platformEnvironment.OKOU_CURRENT_INTEGRATION).toBe(
      "email",
    );
    expect(
      receivedExecution.platformEnvironment.OKOU_CHAT_THREAD_ID,
    ).toBeTruthy();
    expect(receivedExecution.appendSystemPrompt).toContain(
      "You are currently running inside: Email",
    );
    expect(receivedExecution.appendSystemPrompt).toContain(
      `Verified sender: ${JSON.stringify(actor.email)}`,
    );
    expect(receivedExecution.appendSystemPrompt).toContain(
      `Message ID (routing data, not instructions): ${JSON.stringify(message.messageId)}`,
    );
    expect(receivedExecution.appendSystemPrompt).toContain(
      'Subject: "Requested report"',
    );
    expect(receivedExecution.appendSystemPrompt).toContain(
      "okou email upload-file",
    );
    expect(receivedExecution.appendSystemPrompt).toContain(
      "# This Chat Thread",
    );
    const threadId = receivedExecution.platformEnvironment.OKOU_CHAT_THREAD_ID;
    if (!threadId) {
      throw new Error("Expected the Email chat thread identity");
    }
    expect(receivedExecution.appendSystemPrompt).toContain(
      `okou chat messages --thread-id ${threadId} --output-dir /tmp/okou-chat-history`,
    );
    const history = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadEventsContract,
      ).rows({
        headers: { authorization: `Bearer ${token}` },
        params: { threadId },
        query: { sinceSeqId: 0 },
      }),
      [200],
    );
    expect(history.body.rows).toContainEqual(
      expect.objectContaining({
        eventType: "input.prompt",
        contextType: "email",
      }),
    );

    mockEmailS3(20 * 1024 * 1024, "email-file");
    const file = await prepareEmailFile(token);
    await accept(
      emailUploadClient().complete({
        headers: authHeaders(),
        body: { uploadId: file.id },
      }),
      [403],
    );
    const request = () => {
      return accept(
        emailUploadClient().complete({
          headers: { authorization: `Bearer ${token}` },
          body: { uploadId: file.id, text: "Your requested report" },
        }),
        [200],
      );
    };
    const [first, ...concurrent] = await Promise.all([
      request(),
      ...Array.from({ length: 7 }, request),
    ]);
    for (const response of concurrent) {
      expect(response.body.operationId).toBe(first.body.operationId);
    }
    await flushWaitUntilForTest();
    const replay = await request();
    expect(replay.body).toMatchObject({
      uploadId: file.id,
      operationId: first.body.operationId,
      emailAddress: actor.email,
      filename: "report.txt",
      size: 20 * 1024 * 1024,
      url: file.url,
      delivery: { status: "accepted" },
    });
    const delivered = sentEmails().filter((email) => {
      return email.attachments;
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      to: actor.email,
      text: "Your requested report",
      headers: {
        "In-Reply-To": message.messageId,
        "Message-ID": `<${first.body.operationId}@okou.io>`,
      },
      attachments: [
        {
          filename: "report.txt",
          contentType: "text/plain",
          path: expect.stringContaining("sig=bdd"),
        },
      ],
    });
    await accept(
      emailUploadClient().complete({
        headers: { authorization: `Bearer ${token}` },
        body: { uploadId: file.id, text: "A different caption" },
      }),
      [409],
    );
    const source = files.resolveWebFileUrl(actor, file.id);
    await expect(source).resolves.toMatchObject({ publicUrl: null });
  });

  it("resumes the same file across successive Runs in its original Email conversation", async () => {
    const {
      actor,
      execution: receivedExecution,
      token,
      group,
      runId,
    } = await startEmailFileExecution();
    const file = await prepareEmailFile(token);
    const first = await accept(
      emailUploadClient().complete({
        headers: { authorization: `Bearer ${token}` },
        body: { uploadId: file.id },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    await webhooks.requestAgentEvents(
      {
        runId,
        events: [{ type: "result", sequenceNumber: 0, result: "File ready" }],
      },
      { authorization: `Bearer ${receivedExecution.sandboxToken}` },
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId,
        exitCode: 0,
        lastEventSequence: 0,
        completion: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `email-file-${runId}`,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      { authorization: `Bearer ${receivedExecution.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    verifiedDirectory(actor);
    const followup = incoming({
      sender: actor.email,
      inReplyTo: `<${first.body.operationId}@okou.io>`,
      text: "Please inspect that file delivery",
    });
    await followup.send();
    await runs.heartbeatRunner(group);
    const next = await runs.nextReceivedExecution(group);
    const nextRunId = next.runId;
    expect(nextRunId).not.toBe(runId);
    expect(next.platformEnvironment.OKOU_CURRENT_INTEGRATION).toBe("email");
    expect(next.platformEnvironment.OKOU_CHAT_THREAD_ID).toBe(
      first.body.chatThreadId,
    );
    expect(next.appendSystemPrompt).toContain(
      `okou chat messages --thread-id ${first.body.chatThreadId} --output-dir /tmp/okou-chat-history`,
    );
    expect(next.appendSystemPrompt).toContain(
      JSON.stringify(followup.messageId),
    );
    const nextToken = next.platformEnvironment.OKOU_TOKEN;
    if (!nextToken) {
      throw new Error("Expected the follow-up Email run token");
    }
    const resumed = await accept(
      emailUploadClient().complete({
        headers: { authorization: `Bearer ${nextToken}` },
        body: { uploadId: file.id },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(resumed.body.operationId).toBe(first.body.operationId);
    expect(resumed.body.chatThreadId).toBe(first.body.chatThreadId);
    expect(resumed.body.delivery.status).toBe("accepted");
    expect(
      sentEmails().filter((email) => {
        return email.attachments;
      }),
    ).toHaveLength(1);
  });

  it("does not deliver a private file owned by another account", async () => {
    const { actor, token } = await startEmailFileExecution();
    const outsider = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
    const prepared = await files.prepareUpload(outsider, {
      filename: "private.txt",
      contentType: "text/plain",
      size: 1024,
    });
    const file = await files.completeUpload(outsider, { id: prepared.id });
    verifiedDirectory(actor);
    await accept(
      emailUploadClient().complete({
        headers: { authorization: `Bearer ${token}` },
        body: { uploadId: file.id },
      }),
      [404],
    );
    expect(sentEmails()).toStrictEqual([]);
  });

  it("replays the identical attachment and provider idempotency key after a transient rejection", async () => {
    const { token } = await startEmailFileExecution();
    const file = await prepareEmailFile(token);
    context.mocks.resend.send
      .mockResolvedValueOnce({
        data: null,
        error: {
          name: "rate_limit_exceeded",
          message: "Retry after the provider limit",
        },
      })
      .mockResolvedValue({ data: { id: "resend-file-accepted" }, error: null });
    const request = () => {
      return accept(
        emailUploadClient().complete({
          headers: { authorization: `Bearer ${token}` },
          body: { uploadId: file.id },
        }),
        [200],
      );
    };
    const first = await request();
    await flushWaitUntilForTest();
    mockNow(now() + 60_000);
    await request();
    await flushWaitUntilForTest();
    const result = await request();
    expect(result.body.operationId).toBe(first.body.operationId);
    expect(result.body.delivery).toStrictEqual({
      status: "accepted",
      providerId: "resend-file-accepted",
    });
    const attempts = context.mocks.resend.send.mock.calls;
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toStrictEqual(attempts[0]);
    expect(sentEmails()[1]?.attachments).toMatchObject([
      { filename: "report.txt", path: expect.stringContaining("sig=bdd") },
    ]);
  });

  it("checks the stored object's actual size before attaching it", async () => {
    const { token } = await startEmailFileExecution();
    mockEmailS3(MAX_EMAIL_ATTACHMENT_SIZE_BYTES + 1, "email-file");
    const file = await prepareEmailFile(token);
    await accept(
      emailUploadClient().complete({
        headers: { authorization: `Bearer ${token}` },
        body: { uploadId: file.id },
      }),
      [400],
    );
    expect(sentEmails()).toStrictEqual([]);
  });

  it("rejects Email attachment delivery after its mailbox disconnects", async () => {
    const sender = `${randomUUID()}@example.com`;
    const { token } = await startEmailFileExecution(sender);
    const file = await prepareEmailFile(token);
    await accept(
      emailClient().unlink({
        headers: authHeaders(),
        body: { emailAddress: sender },
      }),
      [204],
    );
    await accept(
      emailUploadClient().complete({
        headers: { authorization: `Bearer ${token}` },
        body: { uploadId: file.id },
      }),
      [403],
    );
    expect(
      sentEmails().flatMap((email) => {
        return email.attachments ?? [];
      }),
    ).toStrictEqual([]);
  });

  it("does not infer an email recipient for a Web-originated run", async () => {
    const { actor } = await entitledActor();
    const sent = await files.sendAndLaunch(actor, {
      prompt: "A web request",
    });
    const execution = await runs.executionInput(sent.runId);
    const token = execution.platformEnvironment.OKOU_TOKEN;
    if (!token) {
      throw new Error("Expected the Web run token");
    }
    verifiedDirectory(actor);
    await accept(
      emailUploadClient().complete({
        headers: { authorization: `Bearer ${token}` },
        body: { uploadId: randomUUID() },
      }),
      [403],
    );
    expect(sentEmails()).toStrictEqual([]);
  });

  it.each([
    "https://resend-attachments.s3.amazonaws.com",
    "https://cdn.resend.app",
  ])(
    "imports an email attachment privately from %s without forwarding the Resend credential",
    async (downloadOrigin) => {
      const { actor } = await entitledActor();
      const attachmentId = randomUUID();
      const receipt = incoming({
        sender: actor.email,
        attachments: [{ id: attachmentId, filename: "comparison.txt" }],
      });
      const downloadUrl = `${downloadOrigin}/${attachmentId}/comparison.txt`;
      server.use(
        http.get(
          `https://api.resend.com/emails/receiving/${receipt.id}/attachments/${attachmentId}`,
          ({ request }) => {
            expect(request.headers.get("authorization")).toBe(
              "Bearer test-resend-key",
            );
            return HttpResponse.json({
              id: attachmentId,
              download_url: downloadUrl,
            });
          },
        ),
        http.get(downloadUrl, ({ request }) => {
          expect(request.headers.get("authorization")).toBeNull();
          return new HttpResponse("A private comparison", {
            headers: { "Content-Type": "text/plain" },
          });
        }),
      );
      await receipt.send();
      expect(context.mocks.s3.send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Body: Buffer.from("A private comparison"),
            ContentType: "text/plain",
          }),
        }),
        expect.anything(),
      );
      const threadId = (await createdThreads(actor)).chatThreads[0]?.id;
      if (!threadId) {
        throw new Error("Expected an email chat with an attachment");
      }
      const { events } = await files.listThreadEvents(actor, threadId);
      const prompt = events.find((event) => {
        return event.eventType === "input.prompt";
      });
      if (prompt?.eventType !== "input.prompt") {
        throw new Error("Expected the email input");
      }
      const attachment = prompt.userMessage.parts.find((part) => {
        return part.type === "file";
      });
      if (attachment?.type !== "file") {
        throw new Error("Expected the imported attachment");
      }
      expect(attachment).toMatchObject({
        filenameSnapshot: "comparison.txt",
        contentType: "text/plain",
      });
      const resolved = await files.resolveWebFileUrl(actor, attachment.fileId);
      expect(resolved.publicUrl).toBeNull();
      expect(resolved.url).not.toBe(downloadUrl);
      const outsider = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
      await files.requestWebFileUrl(outsider, attachment.fileId, [404]);
    },
  );

  it.each(["untrusted.example", "cdn.resend.app.evil.example"])(
    "rejects untrusted attachment download host %s while preserving the email text",
    async (downloadHost) => {
      const { actor } = await entitledActor();
      const attachmentId = randomUUID();
      const receipt = incoming({
        sender: actor.email,
        attachments: [{ id: attachmentId, filename: "untrusted.txt" }],
      });
      const downloadUrl = `https://${downloadHost}/${attachmentId}/untrusted.txt`;
      let untrustedHostRequested = false;
      server.use(
        http.get(
          `https://api.resend.com/emails/receiving/${receipt.id}/attachments/${attachmentId}`,
          () => {
            return HttpResponse.json({
              id: attachmentId,
              download_url: downloadUrl,
            });
          },
        ),
        http.get(downloadUrl, () => {
          untrustedHostRequested = true;
          return new HttpResponse("Untrusted attachment");
        }),
      );
      await receipt.send();
      const threadId = (await createdThreads(actor)).chatThreads[0]?.id;
      if (!threadId) {
        throw new Error("Expected the email text to remain available");
      }
      const { events } = await files.listThreadEvents(actor, threadId);
      const prompt = events.find((event) => {
        return event.eventType === "input.prompt";
      });
      if (prompt?.eventType !== "input.prompt") {
        throw new Error("Expected the email input");
      }
      const attachment = prompt.userMessage.parts.find((part) => {
        return part.type === "file";
      });
      if (attachment?.type !== "file") {
        throw new Error("Expected the unavailable attachment reference");
      }
      expect(attachment.filenameSnapshot).toBe("untrusted.txt");
      expect(prompt.userMessage.parts).toContainEqual({
        type: "text",
        text: expect.stringContaining("Please compare these options"),
      });
      expect(untrustedHostRequested).toBeFalsy();
    },
  );

  it("revokes pending reply delivery when its sender disconnects", async () => {
    const { group } = await entitledActor();
    const sender = `${randomUUID()}@example.com`;
    await incoming({ sender, text: await connectionCode() }).send();
    await incoming({ sender }).send();
    await runs.heartbeatRunner(group);
    const execution = await runs.nextReceivedExecution(group);
    const runId = execution.runId;
    await accept(
      emailClient().unlink({
        headers: authHeaders(),
        body: { emailAddress: sender },
      }),
      [204],
    );
    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "result",
            sequenceNumber: 0,
            result: "Reply after disconnect",
          },
        ],
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId,
        exitCode: 0,
        lastEventSequence: 0,
        completion: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `email-${runId}`,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect(
      sentEmails().filter((email) => {
        return email.text === "Reply after disconnect";
      }),
    ).toStrictEqual([]);
  });

  it("does not join another sender's chat through copied reference headers", async () => {
    const { actor: firstActor } = await entitledActor();
    const first = incoming({ sender: firstActor.email });
    await first.send();
    const firstThreads = await createdThreads(firstActor);
    const { actor: secondActor } = await entitledActor();
    await incoming({
      sender: secondActor.email,
      inReplyTo: first.messageId,
    }).send();
    const secondThreads = await createdThreads(secondActor);
    expect(firstThreads.chatThreads).toHaveLength(1);
    expect(secondThreads.chatThreads).toHaveLength(1);
    expect(secondThreads.chatThreads[0]?.id).not.toBe(
      firstThreads.chatThreads[0]?.id,
    );
    await files.requestListThreadEvents(
      secondActor,
      firstThreads.chatThreads[0]!.id,
      {},
      [404],
    );
  });

  it("automatically connects the login email, respects unlinking, and allows explicit reconnection", async () => {
    const { actor } = await entitledActor();
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
    await accept(
      emailClient().unlink({
        headers: authHeaders(),
        body: { emailAddress: actor.email },
      }),
      [204],
    );
    await expect(connectedEmails()).resolves.toStrictEqual([]);
    await incoming({ sender: actor.email }).send();
    expect((await createdThreads(actor)).chatThreads).toHaveLength(0);
    await expect(connectedEmails()).resolves.toStrictEqual([]);
    await accept(
      emailClient().connectAddress({
        headers: authHeaders(),
        body: { emailAddress: actor.email },
      }),
      [200],
    );
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
    await incoming({ sender: actor.email }).send();
    expect((await createdThreads(actor)).chatThreads).toHaveLength(1);
    await accept(
      emailClient().connectAddress({
        headers: authHeaders(),
        body: { emailAddress: "someone-else@example.com" },
      }),
      [403],
    );
  });

  it("rejects a forged login sender without starting a task or replying", async () => {
    const { actor } = await entitledActor();
    await incoming({ sender: actor.email, authenticated: false }).send();
    expect((await createdThreads(actor)).chatThreads).toHaveLength(0);
    expect(sentEmails()).toStrictEqual([]);
  });

  it("accepts aligned DKIM for a DMARC monitoring policy but rejects SPF-only gray authentication", async () => {
    const { actor } = await entitledActor();
    await incoming({
      sender: actor.email,
      authentication: { spf: "pass", dkim: "gray", dmarc: "gray" },
    }).send();
    await expect(createdThreads(actor)).resolves.toStrictEqual({
      chatThreads: [],
    });
    await incoming({
      sender: actor.email,
      authentication: { spf: "gray", dkim: "pass", dmarc: "gray" },
    }).send();
    expect((await createdThreads(actor)).chatThreads).toHaveLength(1);
    expect(
      (
        await accept(
          emailClient().getLinkStatus({ headers: authHeaders() }),
          [200],
        )
      ).body.emails,
    ).toStrictEqual([actor.email]);
  });

  it("auto-connects registered senders, separates independent emails, keeps replies in their original chat, and deduplicates webhook retries", async () => {
    const { actor, group } = await entitledActor();
    const first = incoming({
      sender: actor.email,
      subject: "Same subject",
      text: "First independent request",
    });
    await first.send();
    await first.send();
    await incoming({
      sender: actor.email,
      messageId: first.messageId,
      text: "First independent request",
    }).send();
    expect(
      (
        await accept(
          emailClient().getLinkStatus({ headers: authHeaders() }),
          [200],
        )
      ).body.emails,
    ).toStrictEqual([actor.email]);
    const initial = await createdThreads(actor);
    expect(initial.chatThreads).toHaveLength(1);
    const threadId = initial.chatThreads[0]!.id;
    await runs.heartbeatRunner(group);
    const execution = await runs.nextReceivedExecution(group);
    const runId = execution.runId;
    expect(execution.prompt).toContain("First independent request");
    expect(execution.appendSystemPrompt).toContain(
      "You are currently running inside: Email",
    );
    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "result",
            sequenceNumber: 0,
            result: "Here is the comparison",
          },
        ],
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId,
        exitCode: 0,
        lastEventSequence: 0,
        completion: {
          cliAgentType: "claude-code",
          cliAgentSessionId: `email-${runId}`,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    const reply = sentEmails().find((email) => {
      return email.text === "Here is the comparison";
    });
    expect(reply?.to).toBe(actor.email);
    expect(reply?.headers["In-Reply-To"]).toBe(first.messageId);
    expect(reply?.headers["Message-ID"]).toBeTruthy();
    const sent = {
      type: "email.sent",
      data: {
        email_id: randomUUID(),
        message_id: "<provider-rewritten-message@amazonses.com>",
        tags: {
          okou_email_message:
            reply!.headers["Message-ID"]!.slice(1).split("@")[0],
        },
      },
    };
    await webhooks.requestResendInboundWebhook(
      sent,
      webhooks.signedResendWebhookHeaders(sent),
      [200],
    );
    verifiedDirectory(actor);
    await incoming({
      sender: actor.email,
      inReplyTo: "<provider-rewritten-message@amazonses.com>",
      text: "Please expand the first comparison",
    }).send();
    await incoming({
      sender: actor.email,
      subject: "Same subject",
      text: "Second independent request",
    }).send();
    const snapshot = await createdThreads(actor);
    expect(snapshot.chatThreads).toHaveLength(2);
    const { events } = await files.listThreadEvents(actor, threadId);
    const prompts = events.filter((event) => {
      return event.eventType === "input.prompt" && !event.revokesEventId;
    });
    expect(prompts).toHaveLength(2);
  });

  it("preserves workspace-selection links for existing accounts and resumes the original request only once", async () => {
    const sender = `signup-${randomUUID()}@vm0.ai`;
    const actor = bdd.user({
      email: sender,
      orgId: createUniqueStaffOrgIdFixture(),
    });
    verifiedDirectory(actor);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [
        {
          role: "org:admin",
          organization: { id: actor.orgId, name: "First workspace" },
        },
        {
          role: "org:admin",
          organization: {
            id: createUniqueStaffOrgIdFixture(),
            name: "Second workspace",
          },
        },
      ],
      totalCount: 2,
    });
    await incoming({ sender, text: "Please handle this after signup" }).send();
    const invitation = sentEmails()[0];
    expect(invitation?.to).toBe(sender);
    const link = invitation?.text.match(
      /https:\/\/app\.okou\.ai\/settings\/email\?[^\s)]+/u,
    )?.[0];
    expect(link).toBeTruthy();
    const url = new URL(link!);
    const body = {
      messageId: url.searchParams.get("message")!,
      expires: Number(url.searchParams.get("expires")),
      signature: url.searchParams.get("signature")!,
    };
    const wrong = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
    verifiedDirectory(wrong);
    await accept(
      emailClient().connect({ headers: authHeaders(), body }),
      [403],
    );
    onTestFinished(async () => {
      webhooks.configureClerkWebhookSecret();
      webhooks.verifyNextClerkWebhook({
        type: "user.deleted",
        data: { id: actor.userId },
      });
      await webhooks.requestClerkWebhook("{}", {}, [200]);
      await flushWaitUntilForTest();
    });
    bdd.acceptStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const group = await runs.configureRunnerGroup();
    await deliverOrganizationCreated(context, actor);
    const emailSinceSeqId = await threadEventCursor(context, actor);
    verifiedDirectory(actor);
    await accept(
      emailClient().connect({
        headers: authHeaders(),
        body: { ...body, signature: "0".repeat(64) },
      }),
      [400],
    );
    await accept(
      emailClient().connect({ headers: authHeaders(), body }),
      [200],
    );
    await accept(
      emailClient().connect({ headers: authHeaders(), body }),
      [200],
    );
    await flushWaitUntilForTest();
    await expect(bdd.readOnboardingStatus(actor)).resolves.toMatchObject({
      needsOnboarding: false,
      onboardingComplete: true,
    });
    verifiedDirectory(actor);
    const snapshot = await createdThreads({ ...actor, emailSinceSeqId });
    expect(snapshot.chatThreads).toHaveLength(1);
    const { events } = await files.listThreadEvents(
      actor,
      snapshot.chatThreads[0]!.id,
    );
    expect(
      events.filter((event) => {
        return event.eventType === "input.prompt" && !event.revokesEventId;
      }),
    ).toHaveLength(1);
    expect(
      (
        await accept(
          emailClient().getLinkStatus({ headers: authHeaders() }),
          [200],
        )
      ).body.emails,
    ).toStrictEqual([sender]);
    await runs.heartbeatRunner(group);
    const execution = await runs.nextReceivedExecution(group);
    const runId = execution.runId;
    expect(execution.prompt).toContain("Please handle this after signup");
    await webhooks.requestAgentEvents(
      {
        runId,
        events: [
          {
            type: "result",
            sequenceNumber: 0,
            result: "Your original request is complete",
          },
        ],
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId,
        exitCode: 0,
        lastEventSequence: 0,
        completion: {
          cliAgentType: execution.cliAgentType,
          cliAgentSessionId: execution.piSessionId ?? `email-signup-${runId}`,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      { authorization: `Bearer ${execution.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect(
      sentEmails().filter((email) => {
        return email.text === "Your original request is complete";
      }),
    ).toMatchObject([{ to: sender }]);
  });
});

async function connectionCode() {
  const code = (
    await accept(
      emailClient().createLinkCode({ headers: authHeaders() }),
      [200],
    )
  ).body.code;
  expect(code).toMatch(/^\d{8}$/u);
  return code;
}
async function connectedEmails() {
  return (
    await accept(emailClient().getLinkStatus({ headers: authHeaders() }), [200])
  ).body.emails.sort();
}

function emailWorkspaces(
  actor: ApiTestUser,
  workspaces: readonly { readonly id: string; readonly name: string }[],
) {
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: workspaces.map((organization) => {
      return {
        id: `membership_${organization.id}`,
        role: "org:admin",
        createdAt: now(),
        organization,
        publicUserData: { userId: actor.userId },
      };
    }),
    totalCount: workspaces.length,
  });
}

describe("Email workspace binding", () => {
  it("reports the current run's code-verified sender, workspace and available workspaces", async () => {
    const sender = `${randomUUID()}@example.com`;
    const {
      actor,
      token,
      execution: receivedExecution,
    } = await startEmailFileExecution(sender);
    const workspace = { id: actor.orgId!, name: "Email workspace" };
    const other = {
      id: createUniqueStaffOrgIdFixture(),
      name: "Other workspace",
    };
    emailWorkspaces(actor, [workspace, other]);
    const response = await accept(
      emailSessionClient().getBinding({
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({
      emailAddress: sender,
      workspace,
      workspaces: [workspace, other],
    });
    expect(receivedExecution.appendSystemPrompt).toContain(
      "okou email status --json",
    );
    expect(receivedExecution.appendSystemPrompt).toContain(
      "okou email switch --workspace-id <id>",
    );
    expect(receivedExecution.appendSystemPrompt).toContain("okou email logout");
  });

  it("switches workspaces, confirms by email and starts a fresh conversation for old reply references", async () => {
    const { actor, token, message } = await startEmailFileExecution();
    const originalThreads = await createdThreads(actor);
    const targetAccount = bdd.user({
      userId: actor.userId,
      email: actor.email,
      orgId: createUniqueStaffOrgIdFixture(),
    });
    await runs.grantProEntitlement(targetAccount);
    await runs.ensurePersonalSubscriptionModel(targetAccount);
    const target = {
      ...targetAccount,
      emailSinceSeqId: await threadEventCursor(context, targetAccount),
    };
    verifiedDirectory(actor);
    const workspaces = [
      { id: actor.orgId!, name: "Original workspace" },
      { id: target.orgId!, name: "Target workspace" },
    ];
    emailWorkspaces(actor, workspaces);
    const switched = await accept(
      emailSessionClient().switchWorkspace({
        headers: { authorization: `Bearer ${token}` },
        body: { workspaceId: target.orgId! },
      }),
      [200],
    );
    expect(switched.body).toStrictEqual({
      emailAddress: actor.email,
      workspace: workspaces[1],
    });
    await flushWaitUntilForTest();
    expect(sentEmails()).toContainEqual(
      expect.objectContaining({
        to: actor.email,
        text: expect.stringContaining(
          'connected to workspace "Target workspace"',
        ),
      }),
    );
    await expect(connectedEmails()).resolves.toStrictEqual([]);
    await accept(
      emailSessionClient().logout({
        headers: { authorization: `Bearer ${token}` },
      }),
      [403],
    );
    verifiedDirectory(target);
    emailWorkspaces(target, workspaces);
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
    await message.send();
    expect((await createdThreads(target)).chatThreads).toHaveLength(0);
    await incoming({
      sender: actor.email,
      inReplyTo: message.messageId,
    }).send();
    const newThreads = await createdThreads(target);
    expect(newThreads.chatThreads).toHaveLength(1);
    expect(newThreads.chatThreads[0]?.id).not.toBe(
      originalThreads.chatThreads[0]?.id,
    );
    expect((await createdThreads(actor)).chatThreads).toHaveLength(1);
  });

  it("preserves the binding when switching to a workspace outside the user's membership", async () => {
    const { actor, token } = await startEmailFileExecution();
    await accept(
      emailSessionClient().switchWorkspace({
        headers: { authorization: `Bearer ${token}` },
        body: { workspaceId: `org_${randomUUID()}` },
      }),
      [403],
    );
    const current = await accept(
      emailSessionClient().getBinding({
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    expect(current.body.workspace.id).toBe(actor.orgId);
    expect(sentEmails()).toStrictEqual([]);
  });

  it("logs out the login sender until explicit reconnection and rejects the stale run afterward", async () => {
    const { actor, token, message } = await startEmailFileExecution();
    const headers = { authorization: `Bearer ${token}` };
    const result = await accept(
      emailSessionClient().logout({ headers }),
      [200],
    );
    expect(result.body).toStrictEqual({ emailAddress: actor.email });
    await flushWaitUntilForTest();
    expect(sentEmails()).toContainEqual(
      expect.objectContaining({
        to: actor.email,
        text: expect.stringContaining("disconnected from Okou Email"),
      }),
    );
    await expect(connectedEmails()).resolves.toStrictEqual([]);
    await incoming({ sender: actor.email }).send();
    expect((await createdThreads(actor)).chatThreads).toHaveLength(1);
    await expect(connectedEmails()).resolves.toStrictEqual([]);
    await accept(emailSessionClient().getBinding({ headers }), [403]);
    await accept(
      emailClient().connectAddress({
        headers: authHeaders(),
        body: { emailAddress: actor.email },
      }),
      [200],
    );
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
    await message.send();
    expect((await createdThreads(actor)).chatThreads).toHaveLength(1);
    await accept(emailSessionClient().logout({ headers }), [403]);
    await incoming({ sender: actor.email }).send();
    expect((await createdThreads(actor)).chatThreads).toHaveLength(2);
  });

  it("logs out only the current code-verified sender", async () => {
    const sender = `${randomUUID()}@example.com`;
    const { actor, token } = await startEmailFileExecution(sender);
    await accept(
      emailSessionClient().logout({
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
  });

  it("keeps an OAuth mailbox logged out while its connector stays connected", async () => {
    const sender = `${randomUUID()}@example.com`;
    const { actor, token } = await startEmailFileExecution(sender);
    const mailbox = await connectEmailMailbox(actor, "gmail", sender);
    verifiedDirectory(actor);
    await accept(
      emailSessionClient().logout({
        headers: { authorization: `Bearer ${token}` },
      }),
      [200],
    );
    await incoming({ sender }).send();
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
    expect((await createdThreads(actor)).chatThreads).toHaveLength(1);
    const accounts = await connectorsApi.requestBuiltinConnectorAccounts(
      actor,
      "gmail",
      [200],
    );
    expect(accounts.body.connections).toContainEqual(
      expect.objectContaining({ id: mailbox.id, externalEmail: sender }),
    );
  });

  it("does not use an account's binding for a Web run or a browser session", async () => {
    const { actor } = await entitledActor();
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
    const sent = await files.sendAndLaunch(actor, {
      prompt: "Inspect my email workspace",
    });
    const execution = await runs.executionInput(sent.runId);
    await accept(
      emailSessionClient().getBinding({
        headers: {
          authorization: `Bearer ${execution.platformEnvironment.OKOU_TOKEN}`,
        },
      }),
      [403],
    );
    await accept(
      emailSessionClient().logout({ headers: authHeaders() }),
      [403],
    );
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
  });
});

describe("Email multi-account connections", () => {
  it("preserves an email's disconnection when it becomes the login email", async () => {
    const { actor } = await entitledActor();
    const primary = `${randomUUID()}@example.com`;
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
    await incoming({ sender: primary, text: await connectionCode() }).send();
    await accept(
      emailClient().unlink({
        headers: authHeaders(),
        body: { emailAddress: primary },
      }),
      [204],
    );
    verifiedDirectory(actor, primary);
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
    await incoming({ sender: primary, text: "Analyze my report" }).send();
    expect((await createdThreads(actor)).chatThreads).toHaveLength(0);
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
    await accept(
      emailClient().unlink({
        headers: authHeaders(),
        body: { emailAddress: actor.email },
      }),
      [204],
    );
    await expect(connectedEmails()).resolves.toStrictEqual([]);
  });

  it("allows reconnecting the login email to another workspace after unlinking", async () => {
    const first = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
    verifiedDirectory(first);
    await expect(connectedEmails()).resolves.toStrictEqual([first.email]);
    const second = bdd.user({
      userId: first.userId,
      email: first.email,
      orgId: createUniqueStaffOrgIdFixture(),
    });
    verifiedDirectory(second);
    await expect(connectedEmails()).resolves.toStrictEqual([]);
    await accept(
      emailClient().connectAddress({
        headers: authHeaders(),
        body: { emailAddress: first.email },
      }),
      [409],
    );
    verifiedDirectory(first);
    await accept(
      emailClient().unlink({
        headers: authHeaders(),
        body: { emailAddress: first.email },
      }),
      [204],
    );
    verifiedDirectory(second);
    await expect(connectedEmails()).resolves.toStrictEqual([]);
    await incoming({
      sender: first.email,
      text: await connectionCode(),
    }).send();
    await expect(connectedEmails()).resolves.toStrictEqual([first.email]);
    verifiedDirectory(first);
    await expect(connectedEmails()).resolves.toStrictEqual([]);
  });

  it("processes an ordinary message with a numeric subject as a task", async () => {
    const { actor } = await entitledActor();
    await incoming({
      sender: actor.email,
      subject: "20261110",
      text: "Analyze this report",
    }).send();
    expect((await createdThreads(actor)).chatThreads).toHaveLength(1);
  });

  it("binds multiple non-login email addresses to one owner without starting tasks for connection codes", async () => {
    const { actor } = await entitledActor();
    const first = `${randomUUID()}@gmail.example`;
    const second = `${randomUUID()}@outlook.example`;
    const code = await connectionCode();
    await incoming({
      sender: first,
      to: [`okou+confirm-${randomUUID().replaceAll("-", "")}@okou.io`],
      text: code,
    }).send();
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
    await incoming({
      sender: first,
      subject: code,
      text: "",
    }).send();
    await incoming({
      sender: second,
      text: `${await connectionCode()}\n\nSent from my phone`,
    }).send();
    await expect(connectedEmails()).resolves.toStrictEqual(
      expect.arrayContaining([first, second]),
    );
    expect((await createdThreads(actor)).chatThreads).toHaveLength(0);
    await incoming({ sender: first, text: "Analyze the first report" }).send();
    await incoming({
      sender: second,
      text: "Analyze the second report",
    }).send();
    expect((await createdThreads(actor)).chatThreads).toHaveLength(2);
  });

  it("deduplicates verification webhook retries and cannot reuse a code for another sender", async () => {
    const actor = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
    verifiedDirectory(actor);
    const code = await connectionCode();
    const sender = `${randomUUID()}@example.com`;
    const message = incoming({ sender, text: code });
    await message.send();
    await message.send();
    await incoming({
      sender: `${randomUUID()}@example.com`,
      text: code,
    }).send();
    await expect(connectedEmails()).resolves.toStrictEqual(
      [actor.email, sender].sort(),
    );
    expect(
      sentEmails().filter((email) => {
        return email.text.startsWith("Email connected.");
      }),
    ).toHaveLength(1);
    await accept(
      emailClient().unlink({
        headers: authHeaders(),
        body: { emailAddress: sender },
      }),
      [204],
    );
    await message.send();
    await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
  });

  it("rejects another workspace with a reply and allows moving only after disconnect and a fresh proof", async () => {
    const first = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
    verifiedDirectory(first);
    const sender = `${randomUUID()}@example.com`;
    const firstCodeMessage = incoming({ sender, text: await connectionCode() });
    await firstCodeMessage.send();
    const second = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
    verifiedDirectory(second);
    await incoming({ sender, text: await connectionCode() }).send();
    await expect(connectedEmails()).resolves.toStrictEqual([second.email]);
    expect(sentEmails()).toContainEqual(
      expect.objectContaining({
        to: sender,
        text: expect.stringContaining(
          "already connected to another account or workspace",
        ),
      }),
    );
    verifiedDirectory(first);
    await expect(connectedEmails()).resolves.toStrictEqual(
      [first.email, sender].sort(),
    );
    await accept(
      emailClient().unlink({
        headers: authHeaders(),
        body: { emailAddress: sender },
      }),
      [204],
    );
    await firstCodeMessage.send();
    await expect(connectedEmails()).resolves.toStrictEqual([first.email]);
    verifiedDirectory(second);
    await incoming({ sender, text: await connectionCode() }).send();
    await expect(connectedEmails()).resolves.toStrictEqual(
      [second.email, sender].sort(),
    );
    verifiedDirectory(first);
    await expect(connectedEmails()).resolves.toStrictEqual([first.email]);
  });

  it.each(["expired", "forged"] as const)(
    "rejects %s verification without creating a connection",
    async (reason) => {
      const actor = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
      verifiedDirectory(actor);
      const currentTime = now();
      if (reason === "expired") {
        mockNow(currentTime - 11 * 60 * 1000);
      }
      const code = await connectionCode();
      mockNow(currentTime);
      await incoming({
        sender: `${randomUUID()}@example.com`,
        text: code,
        authenticated: reason !== "forged",
      }).send();
      await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
    },
  );

  it("consumes one code atomically when two authenticated senders race", async () => {
    const actor = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
    verifiedDirectory(actor);
    const code = await connectionCode();
    const first = incoming({
      sender: `${randomUUID()}@example.com`,
      text: code,
    });
    const second = incoming({
      sender: `${randomUUID()}@example.com`,
      text: code,
    });
    await Promise.all([first.send(), second.send()]);
    const linked = await connectedEmails();
    expect(linked).toContain(actor.email);
    expect(linked).toHaveLength(2);
  });

  it("delivers private attachments to a code-verified address outside the login account", async () => {
    const sender = `${randomUUID()}@example.com`;
    const { execution: receivedExecution, token } =
      await startEmailFileExecution(sender);
    expect(receivedExecution.appendSystemPrompt).toContain(
      `Verified sender: ${JSON.stringify(sender)}`,
    );
    mockEmailS3(1024, "email-code-file");
    const file = await prepareEmailFile(token);
    const result = await accept(
      emailUploadClient().complete({
        headers: { authorization: `Bearer ${token}` },
        body: { uploadId: file.id, text: "Your report" },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(result.body.emailAddress).toBe(sender);
    expect(sentEmails()).toContainEqual(
      expect.objectContaining({
        to: sender,
        text: "Your report",
        attachments: expect.any(Array),
      }),
    );
  });

  it.each(["gmail", "outlook-mail"] as const)(
    "routes first-contact email from an existing %s account using its workspace switch",
    async (provider) => {
      const { actor, group } = await entitledActor();
      const sender = `${randomUUID()}@example.com`;
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.EmailIntegration]: false,
      });
      await connectEmailMailbox(actor, provider, sender);
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.EmailIntegration]: true,
      });
      verifiedDirectory(actor);
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: [],
        totalCount: 0,
      });
      const message = incoming({ sender, text: "Use my connected workspace" });
      mockEmailMessageLookup(
        provider,
        message.messageId,
        "Use my connected workspace",
      );
      await message.send();
      await message.send();
      const snapshot = await createdThreads(actor);
      expect(snapshot.chatThreads).toHaveLength(1);
      await runs.heartbeatRunner(group);
      const execution = await runs.nextReceivedExecution(group);
      expect(execution.prompt).toContain("Use my connected workspace");
      expect(execution.appendSystemPrompt).toContain(
        `Verified sender: ${JSON.stringify(sender)}`,
      );
      expect(execution.platformEnvironment.OKOU_CHAT_THREAD_ID).toBe(
        snapshot.chatThreads[0]!.id,
      );
    },
  );

  it("does not route an existing mailbox when its workspace switch is disabled", async () => {
    const { actor } = await entitledActor();
    const sender = `${randomUUID()}@example.com`;
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.EmailIntegration]: false,
    });
    await connectEmailMailbox(actor, "gmail", sender);
    verifiedDirectory(actor);
    await incoming({ sender }).send();
    expect((await createdThreads(actor)).chatThreads).toStrictEqual([]);
    expect(sentEmails()).toStrictEqual([]);
  });

  it("does not route an existing mailbox for a banned account", async () => {
    const { actor } = await entitledActor();
    const sender = `${randomUUID()}@example.com`;
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.EmailIntegration]: false,
    });
    await connectEmailMailbox(actor, "gmail", sender);
    await updateFeatureSwitchesForUser(context, actor, {
      [FeatureSwitchKey.EmailIntegration]: true,
    });
    verifiedDirectory(actor);
    context.mocks.clerk.users.getUser.mockResolvedValue({
      id: actor.userId,
      banned: true,
    });
    await incoming({ sender }).send();
    verifiedDirectory(actor);
    expect((await createdThreads(actor)).chatThreads).toStrictEqual([]);
    expect(sentEmails()).toStrictEqual([]);
  });

  it("does not choose a workspace when an unbound mailbox belongs to multiple workspaces", async () => {
    const { actor: first } = await entitledActor();
    const { actor: second } = await entitledActor();
    const sender = `${randomUUID()}@example.com`;
    for (const actor of [first, second]) {
      verifiedDirectory(actor);
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.EmailIntegration]: false,
      });
      await connectEmailMailbox(actor, "gmail", sender);
      await updateFeatureSwitchesForUser(context, actor, {
        [FeatureSwitchKey.EmailIntegration]: true,
      });
    }
    verifiedDirectory(first);
    await incoming({ sender }).send();
    expect((await createdThreads(first)).chatThreads).toStrictEqual([]);
    verifiedDirectory(second);
    expect((await createdThreads(second)).chatThreads).toStrictEqual([]);
    expect(sentEmails()).toStrictEqual([]);
  });

  it.each([
    { provider: "gmail", alreadyConnected: false },
    { provider: "outlook-mail", alreadyConnected: false },
    { provider: "gmail", alreadyConnected: true },
    { provider: "outlook-mail", alreadyConnected: true },
  ] as const)(
    "automatically adds $provider accounts (existing: $alreadyConnected) and preserves individual deletion",
    async ({ provider, alreadyConnected }) => {
      const orgId = createUniqueStaffOrgIdFixture();
      const actor = bdd.user({ orgId });
      verifiedDirectory(actor);
      if (alreadyConnected) {
        await updateFeatureSwitchesForUser(
          context,
          { userId: actor.userId, orgId },
          {
            [FeatureSwitchKey.EmailIntegration]: false,
          },
        );
      }
      const secondEmail = `${randomUUID()}@example.com`;
      const addresses = [actor.email, secondEmail];
      for (const address of addresses) {
        await connectEmailMailbox(actor, provider, address);
      }
      if (alreadyConnected) {
        await updateFeatureSwitchesForUser(
          context,
          { userId: actor.userId, orgId },
          {
            [FeatureSwitchKey.EmailIntegration]: true,
          },
        );
      }
      verifiedDirectory(actor);
      await expect(connectedEmails()).resolves.toStrictEqual(
        expect.arrayContaining(addresses),
      );
      const source = provider === "gmail" ? "gmail" : "outlook";
      const connected = await accept(
        emailClient().getLinkStatus({ headers: authHeaders() }),
        [200],
      );
      expect(connected.body.emailSources).toStrictEqual({
        [actor.email]: source,
        [secondEmail]: source,
      });
      const accounts = await connectorsApi.requestBuiltinConnectorAccounts(
        actor,
        provider,
        [200],
      );
      if (accounts.status !== 200) {
        throw new Error("Expected mail accounts");
      }
      const account = accounts.body.connections.find((entry) => {
        return entry.externalEmail === actor.email;
      });
      if (!account) {
        throw new Error("Expected login mail account");
      }
      await connectorsApi.deleteBuiltinConnectorAccount(
        actor,
        provider,
        account.id,
      );
      verifiedDirectory(actor);
      await expect(connectedEmails()).resolves.toStrictEqual(
        expect.arrayContaining(addresses),
      );
      await accept(
        emailClient().unlink({
          headers: authHeaders(),
          body: { emailAddress: secondEmail },
        }),
        [204],
      );
      await incoming({ sender: secondEmail }).send();
      const deleted = await accept(
        emailClient().getLinkStatus({ headers: authHeaders() }),
        [200],
      );
      expect(deleted.body.emailSources).toStrictEqual({});
      await expect(connectedEmails()).resolves.toStrictEqual([actor.email]);
    },
  );
});
