import { randomBytes, randomUUID } from "node:crypto";

import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { emailInboundContract } from "@okouai/api-contracts/contracts/email";
import { integrationsEmailContract } from "@okouai/api-contracts/contracts/integrations-email";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse, http } from "msw";
import { Webhook } from "svix";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { env, mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createUniqueEmailSignupAddressFixture } from "../../../test-fixtures/email-signup-identity";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { chatThreadRoutes } from "../chat-threads";
import { connectorAccountRoutes } from "../connector-accounts";
import { emailInboundRoutes } from "../email-inbound";
import { integrationsEmailRoutes } from "../integrations-email";
import { webFileUrlRoutes } from "../web-file-url";
import { createBddApi } from "./helpers/api-bdd";
import {
  createConnectorBddApi,
  mockGmailConnectorOAuth,
} from "./helpers/api-bdd-connectors";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { readProjectedChatEvents } from "./helpers/chat-event-test-reader";
import { ClerkUserNotFoundTestError } from "./helpers/clerk-users";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { createRouteMocks } from "./helpers/route-test";
import {
  generatedStripeCustomerId,
  generatedStripeSubscriptionId,
  postSubscriptionInvoicePaid,
} from "./helpers/stripe-billing-webhook";

const context = testContext();

const AUTH_HEADERS = Object.freeze({ authorization: "Bearer clerk-session" });
const EMAIL_CHANNEL_ADDRESS = "okou@okou.io";
const S3_DOWNLOAD_ORIGIN = "https://resend-attachments.s3.amazonaws.com";

interface ClerkDirectoryUser {
  readonly id: string;
  readonly email: string;
  readonly verified?: boolean;
  readonly banned?: boolean;
  readonly orgIds: readonly string[];
}

interface SentEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly replyTo: string | undefined;
}

interface InboundEmailSpec {
  readonly emailId?: string;
  readonly from: string;
  readonly to?: readonly string[];
  readonly messageId?: string;
  readonly subject?: string;
  readonly text?: string | null;
  readonly html?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly authentication?: {
    readonly spf: string;
    readonly dkim: string;
    readonly dmarc: string;
  } | null;
  readonly attachments?: readonly {
    readonly id: string;
    readonly filename: string | null;
  }[];
  readonly flush?: boolean;
}

interface S3PutCapture {
  readonly bucket: string | undefined;
  readonly key: string | undefined;
  readonly contentType: string | undefined;
  readonly bodyText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readSentEmail(payload: unknown): SentEmail {
  if (!isRecord(payload)) {
    throw new Error("Expected Resend send payload object");
  }
  const toValue = payload.to;
  const to =
    typeof toValue === "string"
      ? toValue
      : Array.isArray(toValue) && typeof toValue[0] === "string"
        ? toValue[0]
        : "";
  return {
    to,
    subject: typeof payload.subject === "string" ? payload.subject : "",
    text: typeof payload.text === "string" ? payload.text : "",
    replyTo: typeof payload.replyTo === "string" ? payload.replyTo : undefined,
  };
}

function formatClerkUser(user: ClerkDirectoryUser) {
  const emailId = `idn_${user.id}`;
  return {
    id: user.id,
    banned: user.banned ?? false,
    firstName: "Test",
    lastName: "User",
    imageUrl: "",
    primaryEmailAddressId: emailId,
    emailAddresses: [
      {
        id: emailId,
        emailAddress: user.email,
        verification: {
          status: user.verified === false ? "unverified" : "verified",
        },
      },
    ],
  };
}

function createEmailHarness() {
  const realWallNow = now();
  onTestFinished(() => {
    clearMockNow();
  });

  mockEnv("RESEND_API_KEY", `re_test_${randomUUID()}`);
  mockEnv(
    "RESEND_WEBHOOK_SECRET",
    `whsec_${randomBytes(24).toString("base64")}`,
  );
  mockEnv("APP_URL", "https://app.okou.test");

  const sentEmails: SentEmail[] = [];
  const createdUsers: unknown[] = [];
  const createdOrgs: unknown[] = [];
  const directoryUsers: ClerkDirectoryUser[] = [];
  const receivedEmails = new Map<string, Record<string, unknown>>();
  const s3Puts: S3PutCapture[] = [];

  context.mocks.resend.send.mockImplementation((payload: unknown) => {
    sentEmails.push(readSentEmail(payload));
    return Promise.resolve({
      data: { id: `re_sent_${randomUUID()}` },
      error: null,
    });
  });

  context.mocks.clerk.users.createUser.mockImplementation((args: unknown) => {
    createdUsers.push(args);
    return Promise.reject(new Error("Unexpected Clerk user creation"));
  });
  context.mocks.clerk.organizations.createOrganization.mockImplementation(
    (args: unknown) => {
      createdOrgs.push(args);
      return Promise.reject(
        new Error("Unexpected Clerk organization creation"),
      );
    },
  );
  context.mocks.clerk.blocklistIdentifiers.getBlocklistIdentifierList.mockResolvedValue(
    { data: [], totalCount: 0 },
  );
  function installS3Mock(): void {
    context.mocks.s3.send.mockImplementation((cmd: unknown) => {
      if (cmd instanceof PutObjectCommand) {
        const body = cmd.input.Body;
        const bodyText =
          typeof body === "string"
            ? body
            : body instanceof Uint8Array
              ? new TextDecoder().decode(body)
              : "";
        s3Puts.push({
          bucket: cmd.input.Bucket,
          key: cmd.input.Key,
          contentType: cmd.input.ContentType,
          bodyText,
        });
        return Promise.resolve({ ETag: "etag-email" });
      }
      if (cmd instanceof HeadObjectCommand) {
        const found = s3Puts.find((put) => {
          return put.key === cmd.input.Key;
        });
        if (found) {
          return Promise.resolve({
            ContentLength: Buffer.byteLength(found.bodyText, "utf8"),
            ContentType: found.contentType,
          });
        }
        return Promise.resolve({ ContentLength: 0 });
      }
      return Promise.resolve({ Contents: [], IsTruncated: false });
    });
  }

  installS3Mock();

  function syncClerkDirectory(): void {
    const snapshot = [...directoryUsers];
    context.mocks.clerk.users.getUser.mockImplementation((userId: unknown) => {
      const found = snapshot.find((entry) => {
        return entry.id === userId;
      });
      return found
        ? Promise.resolve(formatClerkUser(found))
        : Promise.reject(new ClerkUserNotFoundTestError());
    });
    context.mocks.clerk.users.getUserList.mockImplementation(
      (query: unknown) => {
        const requestedEmails =
          isRecord(query) && Array.isArray(query.emailAddress)
            ? query.emailAddress
                .filter((value): value is string => {
                  return typeof value === "string";
                })
                .map((value) => {
                  return value.toLowerCase();
                })
            : null;
        const matched = snapshot.filter((entry) => {
          return (
            requestedEmails === null ||
            requestedEmails.includes(entry.email.toLowerCase())
          );
        });
        return Promise.resolve({
          data: matched.map(formatClerkUser),
          totalCount: matched.length,
        });
      },
    );
    context.mocks.clerk.users.getOrganizationMembershipList.mockImplementation(
      (query: unknown) => {
        const userId =
          isRecord(query) && typeof query.userId === "string"
            ? query.userId
            : "";
        const found = snapshot.find((entry) => {
          return entry.id === userId;
        });
        const items = (found?.orgIds ?? []).map((orgId) => {
          return {
            id: `orgmem_${orgId.slice(-8)}_${userId.slice(-8)}`,
            role: "org:admin",
            organization: {
              id: orgId,
              slug: `org-${orgId.slice(-8)}`,
              name: "Workspace",
            },
            publicUserData: { userId },
            createdAt: realWallNow,
          };
        });
        return Promise.resolve({ data: items, totalCount: items.length });
      },
    );
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockImplementation(
      (query: unknown) => {
        const orgId =
          isRecord(query) && typeof query.organizationId === "string"
            ? query.organizationId
            : "";
        const items = snapshot
          .filter((entry) => {
            return entry.orgIds.includes(orgId);
          })
          .map((entry) => {
            return {
              id: `orgmem_${orgId.slice(-8)}_${entry.id.slice(-8)}`,
              role: "org:admin",
              organization: {
                id: orgId,
                slug: `org-${orgId.slice(-8)}`,
                name: "Workspace",
              },
              publicUserData: { userId: entry.id },
              createdAt: realWallNow,
            };
          });
        return Promise.resolve({ data: items, totalCount: items.length });
      },
    );
    context.mocks.clerk.organizations.getOrganization.mockImplementation(
      (query: unknown) => {
        const orgId =
          isRecord(query) && typeof query.organizationId === "string"
            ? query.organizationId
            : "";
        const owner = snapshot.find((entry) => {
          return entry.orgIds.includes(orgId);
        });
        return Promise.resolve({
          id: orgId,
          slug: `org-${orgId.slice(-8)}`,
          name: "Workspace",
          createdBy: owner?.id ?? null,
        });
      },
    );
  }

  syncClerkDirectory();

  server.use(
    http.get(
      "https://api.resend.com/emails/receiving/:emailId",
      ({ params, request }) => {
        if (
          request.headers.get("authorization") !==
          `Bearer ${env("RESEND_API_KEY")}`
        ) {
          return HttpResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const emailId = String(params.emailId);
        const found = receivedEmails.get(emailId);
        if (!found) {
          return HttpResponse.json({ error: "Not found" }, { status: 404 });
        }
        return HttpResponse.json(found);
      },
    ),
  );

  function addDirectoryUser(user: ClerkDirectoryUser): void {
    const existingIndex = directoryUsers.findIndex((entry) => {
      return entry.id === user.id;
    });
    if (existingIndex !== -1) {
      directoryUsers[existingIndex] = user;
    } else {
      directoryUsers.push(user);
    }
    syncClerkDirectory();
  }

  function signIn(userId: string, orgId: string): void {
    createRouteMocks(context).clerk.session(userId, orgId, "org:admin");
  }

  async function deliverInboundEmail(spec: InboundEmailSpec): Promise<{
    readonly emailId: string;
    readonly messageId: string;
  }> {
    const emailId = spec.emailId ?? randomUUID();
    const messageId = spec.messageId ?? `<msg-${randomUUID()}@sender.test>`;
    receivedEmails.set(emailId, {
      id: emailId,
      from: spec.from,
      to: spec.to ? [...spec.to] : [EMAIL_CHANNEL_ADDRESS],
      message_id: messageId,
      subject: spec.subject ?? "Hello Okou",
      text: spec.text === undefined ? "Please help me with this." : spec.text,
      html: spec.html ?? null,
      headers: spec.headers ?? {},
      authentication:
        spec.authentication === undefined
          ? { spf: "pass", dkim: "pass", dmarc: "pass" }
          : spec.authentication,
      attachments: spec.attachments ? [...spec.attachments] : [],
    });

    const body = {
      type: "email.received",
      created_at: new Date(realWallNow).toISOString(),
      data: {
        email_id: emailId,
        from: spec.from,
        to: spec.to ? [...spec.to] : [EMAIL_CHANNEL_ADDRESS],
        subject: spec.subject ?? "Hello Okou",
      },
    };
    const msgId = `msg_${randomUUID()}`;
    const timestamp = new Date(realWallNow);
    const webhookSecret = env("RESEND_WEBHOOK_SECRET");
    if (!webhookSecret) {
      throw new Error("Expected RESEND_WEBHOOK_SECRET");
    }
    const signature = new Webhook(webhookSecret).sign(
      msgId,
      timestamp,
      JSON.stringify(body),
    );
    await accept(
      setupApp({ context, routes: emailInboundRoutes })(
        emailInboundContract,
      ).post({
        headers: {
          "svix-id": msgId,
          "svix-timestamp": String(Math.floor(realWallNow / 1000)),
          "svix-signature": signature,
        },
        body,
      }),
      [200],
    );
    if (spec.flush !== false) {
      await flushWaitUntilForTest();
    }
    return { emailId, messageId };
  }

  function emailClient() {
    return setupApp({ context, routes: integrationsEmailRoutes })(
      integrationsEmailContract,
    );
  }

  async function getLinkStatus(userId: string, orgId: string) {
    signIn(userId, orgId);
    return (
      await accept(
        emailClient().getLinkStatus({ headers: AUTH_HEADERS }),
        [200],
      )
    ).body;
  }

  async function createLinkCode(userId: string, orgId: string) {
    signIn(userId, orgId);
    return (
      await accept(
        emailClient().createLinkCode({ headers: AUTH_HEADERS }),
        [200],
      )
    ).body;
  }

  async function unlinkEmail(
    userId: string,
    orgId: string,
    emailAddress: string,
  ) {
    signIn(userId, orgId);
    return await accept(
      emailClient().unlink({
        headers: AUTH_HEADERS,
        body: { emailAddress },
      }),
      [204],
    );
  }

  async function connectAddress(
    userId: string,
    orgId: string,
    emailAddress: string,
    statuses: readonly (200 | 403 | 409)[],
  ) {
    signIn(userId, orgId);
    return await accept(
      emailClient().connectAddress({
        headers: AUTH_HEADERS,
        body: { emailAddress },
      }),
      statuses,
    );
  }

  async function listThreadIds(
    userId: string,
    orgId: string,
  ): Promise<readonly string[]> {
    signIn(userId, orgId);
    const response = await accept(
      setupApp({ context, routes: chatThreadRoutes })(
        chatThreadsContract,
      ).events({
        headers: AUTH_HEADERS,
        query: {},
      }),
      [200],
    );
    return response.body.events.flatMap((event) => {
      return event.kind === "created" ? [event.chatThreadId] : [];
    });
  }

  async function configureRunner(): Promise<void> {
    const runs = createRunsApi(context);
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    await runs.configureRunnerGroup();
    installS3Mock();
    syncClerkDirectory();
  }

  async function provisionProAdmin(
    options: {
      readonly email?: string;
      readonly enableEmailSwitch?: boolean;
      readonly useRolloutAddress?: boolean;
    } = {},
  ) {
    const userId = `user_email_${randomUUID()}`;
    const orgId = `org_email_${randomUUID()}`;
    const email =
      options.email ??
      (options.useRolloutAddress
        ? createUniqueEmailSignupAddressFixture()
        : `admin-${randomUUID()}@workspace.test`);
    addDirectoryUser({ id: userId, email, orgIds: [orgId] });
    await Promise.all([
      postSubscriptionInvoicePaid(context.signal, {
        orgId,
        userId,
        tier: "pro",
        customerId: generatedStripeCustomerId(),
        subscriptionId: generatedStripeSubscriptionId(),
        currentPeriodEnd: new Date(realWallNow + 30 * 24 * 60 * 60 * 1000),
      }),
      options.enableEmailSwitch !== false && !options.useRolloutAddress
        ? updateFeatureSwitchesForUser(
            context,
            { userId, orgId, orgRole: "org:admin" },
            { [FeatureSwitchKey.EmailIntegration]: true },
          )
        : Promise.resolve(),
    ]);
    syncClerkDirectory();
    return { userId, orgId, email };
  }

  async function connectGmailMailbox(
    user: { readonly userId: string; readonly orgId: string },
    mailboxEmail: string,
    subject = `sub-${randomUUID()}`,
  ): Promise<string> {
    mockGmailConnectorOAuth({
      subject,
      email: mailboxEmail,
      accessToken: `gmail-access-${subject}`,
    });
    const connectorApi = createConnectorBddApi(context);
    const actor = createBddApi(context).user({
      userId: user.userId,
      orgId: user.orgId,
      orgRole: "org:admin",
      email: mailboxEmail,
    });
    const started = await connectorApi.startOauth(actor, "gmail", "oauth");
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Missing OAuth state in Gmail authorization URL");
    }
    const callback = await connectorApi.completeOauthCallbackResult("gmail", {
      code: "authorized",
      state,
    });
    expect(callback.body.status).toBe("success");
    signIn(user.userId, user.orgId);
    const accounts = setupApp({ context, routes: connectorAccountRoutes })(
      connectorAccountsContract,
    );
    const completed = await accept(
      accounts.oauthCompletion({
        headers: AUTH_HEADERS,
        params: { attemptId: started.oauthAttemptId },
        query: { kind: "builtin", connectorSlug: "gmail" },
      }),
      [200],
    );
    syncClerkDirectory();
    return completed.body.connectionId;
  }

  return {
    realWallNow,
    sentEmails,
    createdUsers,
    createdOrgs,
    s3Puts,
    addDirectoryUser,
    syncClerkDirectory,
    signIn,
    deliverInboundEmail,
    getLinkStatus,
    createLinkCode,
    unlinkEmail,
    connectAddress,
    listThreadIds,
    configureRunner,
    provisionProAdmin,
    connectGmailMailbox,
  };
}

describe("email-native signup", () => {
  it("integrations-email-003 refuses a Clerk-blocked sender matching domain before confirming or creating an account", async () => {
    const harness = createEmailHarness();
    const sender = createUniqueEmailSignupAddressFixture();
    const domain = sender.slice(sender.lastIndexOf("@") + 1);
    context.mocks.clerk.blocklistIdentifiers.getBlocklistIdentifierList.mockResolvedValue(
      {
        data: [{ id: "blid_domain", identifier: `*@${domain}` }],
        totalCount: 1,
      },
    );

    await harness.deliverInboundEmail({
      from: sender,
      subject: "Need help",
      text: "Summarize my notes",
    });

    expect(harness.sentEmails).toHaveLength(1);
    expect(harness.sentEmails[0]?.to).toBe(sender);
    expect(harness.sentEmails[0]?.text).toContain(
      "did not pass our security checks",
    );
    expect(harness.sentEmails[0]?.text).not.toContain("CONFIRM");
    expect(harness.createdUsers).toHaveLength(0);
    expect(harness.createdOrgs).toHaveLength(0);
  });

  it("integrations-email-005 refuses email-native signup for a disposable address", async () => {
    const harness = createEmailHarness();
    const userId = `user_disp_${randomUUID()}`;
    const orgOne = `org_disp_1_${randomUUID()}`;
    const orgTwo = `org_disp_2_${randomUUID()}`;
    const email = `disposable-${randomUUID()}@mailinator.com`;
    harness.addDirectoryUser({ id: userId, email, orgIds: [orgOne, orgTwo] });
    await updateFeatureSwitchesForUser(
      context,
      { userId, orgId: orgOne, orgRole: "org:admin" },
      { [FeatureSwitchKey.EmailIntegration]: true },
    );

    await harness.deliverInboundEmail({
      from: email,
      subject: "Hello from disposable",
      text: "Please draft a memo",
    });

    expect(harness.sentEmails).toHaveLength(1);
    expect(harness.sentEmails[0]?.to).toBe(email);
    expect(harness.sentEmails[0]?.text).toContain(
      "did not pass our security checks",
    );
    expect(harness.createdUsers).toHaveLength(0);
    await expect(harness.listThreadIds(userId, orgOne)).resolves.toHaveLength(
      0,
    );
    await expect(harness.listThreadIds(userId, orgTwo)).resolves.toHaveLength(
      0,
    );
    const linkStatus = await harness.getLinkStatus(userId, orgOne);
    expect(linkStatus.emails).toStrictEqual([email]);
  });

  it("integrations-email-006 does not register when the reply only contains or quotes CONFIRM: > CONFIRM", async () => {
    const harness = createEmailHarness();
    const sender = createUniqueEmailSignupAddressFixture();

    await harness.deliverInboundEmail({
      from: sender,
      subject: "Draft an agenda",
      text: "Write a meeting agenda",
    });
    const invitation = harness.sentEmails[0];
    expect(invitation?.replyTo).toBeTruthy();
    if (!invitation?.replyTo) {
      throw new Error("Expected signup confirmation reply-to address");
    }

    await harness.deliverInboundEmail({
      from: sender,
      to: [invitation.replyTo],
      subject: "Re: Draft an agenda",
      text: "> CONFIRM",
    });

    expect(harness.createdUsers).toHaveLength(0);
    const confirmInvitations = harness.sentEmails.filter((item) => {
      return item.text.includes("CONFIRM");
    });
    expect(confirmInvitations).toHaveLength(1);
  });

  it("integrations-email-008 rejects another mailbox's confirmation reply address without creating or running anything", async () => {
    const harness = createEmailHarness();
    const unknownSender = createUniqueEmailSignupAddressFixture();
    const otherUserId = `user_other_${randomUUID()}`;
    const otherOrgId = `org_other_${randomUUID()}`;
    const otherEmail = `other-${randomUUID()}@workspace.test`;
    harness.addDirectoryUser({
      id: otherUserId,
      email: otherEmail,
      orgIds: [otherOrgId],
    });
    await updateFeatureSwitchesForUser(
      context,
      { userId: otherUserId, orgId: otherOrgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.EmailIntegration]: true },
    );

    await harness.deliverInboundEmail({
      from: unknownSender,
      subject: "Start signup",
      text: "Help me plan",
    });
    const invitation = harness.sentEmails[0];
    if (!invitation?.replyTo) {
      throw new Error("Expected signup confirmation reply-to address");
    }

    await harness.deliverInboundEmail({
      from: otherEmail,
      to: [invitation.replyTo],
      subject: "Re: Start signup",
      text: "CONFIRM",
    });

    const lastReply = harness.sentEmails.at(-1);
    expect(lastReply?.to).toBe(otherEmail);
    expect(lastReply?.text).toContain("invalid or expired");
    expect(harness.createdUsers).toHaveLength(0);
    await expect(
      harness.listThreadIds(otherUserId, otherOrgId),
    ).resolves.toHaveLength(0);
  });

  it("integrations-email-009 rejects expired consent and does not create an account", async () => {
    const harness = createEmailHarness();
    const sender = createUniqueEmailSignupAddressFixture();

    await harness.deliverInboundEmail({
      from: sender,
      subject: "Delayed signup",
      text: "Please summarize",
    });
    const invitation = harness.sentEmails[0];
    if (!invitation?.replyTo) {
      throw new Error("Expected signup confirmation reply-to address");
    }

    mockNow(harness.realWallNow + 25 * 60 * 60 * 1000);
    await harness.deliverInboundEmail({
      from: sender,
      to: [invitation.replyTo],
      subject: "Re: Delayed signup",
      text: "CONFIRM",
    });

    const lastReply = harness.sentEmails.at(-1);
    expect(lastReply?.to).toBe(sender);
    expect(lastReply?.text).toContain("invalid or expired");
    expect(harness.createdUsers).toHaveLength(0);
  });

  it("integrations-email-013 bounds unconfirmed signup messages from one sender", async () => {
    const harness = createEmailHarness();
    const sender = createUniqueEmailSignupAddressFixture();

    for (let index = 1; index <= 4; index += 1) {
      await harness.deliverInboundEmail({
        from: sender,
        subject: `Request ${index}`,
        text: `Different request body ${index}`,
      });
    }

    const confirmInvitations = harness.sentEmails.filter((item) => {
      return item.text.includes("CONFIRM");
    });
    expect(confirmInvitations).toHaveLength(3);
    expect(harness.createdUsers).toHaveLength(0);
  });
});

describe("Email integration", () => {
  it("integrations-email-048 rejects a forged login sender without starting a task or replying", async () => {
    const harness = createEmailHarness();
    const admin = await harness.provisionProAdmin();

    await harness.deliverInboundEmail({
      from: admin.email,
      subject: "Spoofed request",
      text: "Do something",
      authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
    });

    await expect(
      harness.listThreadIds(admin.userId, admin.orgId),
    ).resolves.toHaveLength(0);
    expect(harness.sentEmails).toHaveLength(0);
  });

  it("integrations-email-047 (1/2) automatically connects the login email and ignores emails after unlinking", async () => {
    const harness = createEmailHarness();
    const admin = await harness.provisionProAdmin();

    const initial = await harness.getLinkStatus(admin.userId, admin.orgId);
    expect(initial.emails).toStrictEqual([admin.email]);

    await harness.unlinkEmail(admin.userId, admin.orgId, admin.email);
    const afterUnlink = await harness.getLinkStatus(admin.userId, admin.orgId);
    expect(afterUnlink.emails).toStrictEqual([]);

    await harness.deliverInboundEmail({
      from: admin.email,
      subject: "While unlinked",
      text: "Should be ignored",
    });
    await expect(
      harness.listThreadIds(admin.userId, admin.orgId),
    ).resolves.toHaveLength(0);
    const stillUnlinked = await harness.getLinkStatus(
      admin.userId,
      admin.orgId,
    );
    expect(stillUnlinked.emails).toStrictEqual([]);
  });

  it("integrations-email-047 (2/2) allows explicit reconnection of the login email and rejects foreign addresses", async () => {
    const harness = createEmailHarness();
    await harness.configureRunner();
    const admin = await harness.provisionProAdmin({ useRolloutAddress: true });
    await harness.getLinkStatus(admin.userId, admin.orgId);
    await harness.unlinkEmail(admin.userId, admin.orgId, admin.email);

    await harness.connectAddress(admin.userId, admin.orgId, admin.email, [200]);
    const reconnected = await harness.getLinkStatus(admin.userId, admin.orgId);
    expect(reconnected.emails).toStrictEqual([admin.email]);

    await harness.deliverInboundEmail({
      from: admin.email,
      subject: "After reconnect",
      text: "Start a chat now",
    });
    await expect(
      harness.listThreadIds(admin.userId, admin.orgId),
    ).resolves.toHaveLength(1);

    await harness.connectAddress(
      admin.userId,
      admin.orgId,
      "someone-else@example.com",
      [403],
    );
  });

  async function deliverPrivateAttachmentEmail() {
    const harness = createEmailHarness();
    await harness.configureRunner();
    const admin = await harness.provisionProAdmin({ useRolloutAddress: true });
    const emailId = randomUUID();
    const attachmentId = randomUUID();
    const downloadUrl = `${S3_DOWNLOAD_ORIGIN}/attachments/${attachmentId}/comparison.txt`;
    let downloadAuthorizationHeader: string | null = "unseen";

    server.use(
      http.get(
        `https://api.resend.com/emails/receiving/${emailId}/attachments/${attachmentId}`,
        ({ request }) => {
          if (
            request.headers.get("authorization") !==
            `Bearer ${env("RESEND_API_KEY")}`
          ) {
            return HttpResponse.json(
              { error: "Unauthorized" },
              { status: 401 },
            );
          }
          return HttpResponse.json({
            id: attachmentId,
            download_url: downloadUrl,
          });
        },
      ),
      http.get(downloadUrl, ({ request }) => {
        downloadAuthorizationHeader = request.headers.get("authorization");
        return new HttpResponse("A private comparison", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }),
    );

    await harness.deliverInboundEmail({
      emailId,
      from: admin.email,
      subject: "Compare attachment",
      text: "Please inspect the attached file.",
      attachments: [{ id: attachmentId, filename: "comparison.txt" }],
    });

    const threads = await harness.listThreadIds(admin.userId, admin.orgId);
    expect(threads).toHaveLength(1);
    const threadId = threads[0];
    if (!threadId) {
      throw new Error("Expected one created email conversation");
    }
    harness.signIn(admin.userId, admin.orgId);
    const events = await readProjectedChatEvents(context, {
      threadId,
      headers: AUTH_HEADERS,
    });
    const promptEvent = events.find((event) => {
      return event.eventType === "input.prompt";
    });
    if (!promptEvent || promptEvent.eventType !== "input.prompt") {
      throw new Error("Expected input.prompt event");
    }
    const filePart = promptEvent.userMessage.parts.find((part) => {
      return part.type === "file";
    });
    if (!filePart || filePart.type !== "file" || !filePart.fileId) {
      throw new Error("Expected file part with fileId in input.prompt");
    }
    return {
      harness,
      admin,
      downloadUrl,
      downloadAuthorizationHeader,
      filePart,
      fileId: filePart.fileId,
    };
  }

  it("integrations-email-040 (1/2) downloads and stores the attachment without forwarding the Resend credential and records the prompt file part", async () => {
    const { harness, downloadAuthorizationHeader, filePart } =
      await deliverPrivateAttachmentEmail();

    expect(downloadAuthorizationHeader).toBeNull();
    const storedAttachment = harness.s3Puts.find((put) => {
      return put.bodyText === "A private comparison";
    });
    expect(storedAttachment).toBeDefined();
    expect(storedAttachment?.contentType).toBe("text/plain");
    expect(filePart.filenameSnapshot).toBe("comparison.txt");
    expect(filePart.contentType).toBe("text/plain");
  });

  it("integrations-email-040 (2/2) resolves the attachment privately for the owner and denies an outsider", async () => {
    const { harness, admin, downloadUrl, fileId } =
      await deliverPrivateAttachmentEmail();
    const outsiderUserId = `user_outsider_${randomUUID()}`;
    const outsiderOrgId = `org_outsider_${randomUUID()}`;
    harness.addDirectoryUser({
      id: outsiderUserId,
      email: `outsider-${randomUUID()}@workspace.test`,
      orgIds: [outsiderOrgId],
    });
    const fileUrlClient = setupApp({ context, routes: webFileUrlRoutes })(
      webFilesContract,
    );

    harness.signIn(admin.userId, admin.orgId);
    const resolved = await accept(
      fileUrlClient.fileUrl({
        headers: AUTH_HEADERS,
        query: { file_id: fileId },
      }),
      [200],
    );
    expect(resolved.body.publicUrl).toBeNull();
    expect(resolved.body.url).not.toBe(downloadUrl);

    harness.signIn(outsiderUserId, outsiderOrgId);
    await accept(
      fileUrlClient.fileUrl({
        headers: AUTH_HEADERS,
        query: { file_id: fileId },
      }),
      [404],
    );
  });
});

describe("Email multi-account connections", () => {
  it("integrations-email-060 allows reconnecting the login email to another workspace after unlinking", async () => {
    const harness = createEmailHarness();
    const userId = `user_multi_${randomUUID()}`;
    const orgOne = `org_one_${randomUUID()}`;
    const orgTwo = `org_two_${randomUUID()}`;
    const email = `member-${randomUUID()}@workspace.test`;
    harness.addDirectoryUser({ id: userId, email, orgIds: [orgOne, orgTwo] });
    await updateFeatureSwitchesForUser(
      context,
      { userId, orgId: orgOne, orgRole: "org:admin" },
      { [FeatureSwitchKey.EmailIntegration]: true },
    );
    await updateFeatureSwitchesForUser(
      context,
      { userId, orgId: orgTwo, orgRole: "org:admin" },
      { [FeatureSwitchKey.EmailIntegration]: true },
    );

    const firstStatus = await harness.getLinkStatus(userId, orgOne);
    expect(firstStatus.emails).toStrictEqual([email]);

    const secondInitial = await harness.getLinkStatus(userId, orgTwo);
    expect(secondInitial.emails).toStrictEqual([]);
    await harness.connectAddress(userId, orgTwo, email, [409]);

    await harness.unlinkEmail(userId, orgOne, email);
    const secondAfterUnlink = await harness.getLinkStatus(userId, orgTwo);
    expect(secondAfterUnlink.emails).toStrictEqual([]);

    const { code } = await harness.createLinkCode(userId, orgTwo);
    await harness.deliverInboundEmail({
      from: email,
      subject: "Connect my login email",
      text: code,
    });

    const secondFinal = await harness.getLinkStatus(userId, orgTwo);
    expect(secondFinal.emails).toStrictEqual([email]);
    const firstFinal = await harness.getLinkStatus(userId, orgOne);
    expect(firstFinal.emails).toStrictEqual([]);
  });

  it("integrations-email-062 (1/4) ignores connection codes sent to okou+confirm addresses", async () => {
    const harness = createEmailHarness();
    const admin = await harness.provisionProAdmin();
    const firstExternal = `alt1-${randomUUID()}@external.test`;

    const initial = await harness.getLinkStatus(admin.userId, admin.orgId);
    expect(initial.emails).toStrictEqual([admin.email]);

    const firstCode = await harness.createLinkCode(admin.userId, admin.orgId);
    await harness.deliverInboundEmail({
      from: firstExternal,
      to: [`okou+confirm-${"a".repeat(32)}@okou.io`],
      subject: firstCode.code,
      text: "",
    });
    expect(
      (await harness.getLinkStatus(admin.userId, admin.orgId)).emails,
    ).toStrictEqual([admin.email]);
  });

  it("integrations-email-062 (2/4) binds multiple non-login email addresses via subject and body codes without starting tasks", async () => {
    const harness = createEmailHarness();
    const admin = await harness.provisionProAdmin();
    const firstExternal = `alt1-${randomUUID()}@external.test`;
    const secondExternal = `alt2-${randomUUID()}@external.test`;

    await harness.getLinkStatus(admin.userId, admin.orgId);
    const [firstCode, secondCode] = await Promise.all([
      harness.createLinkCode(admin.userId, admin.orgId),
      harness.createLinkCode(admin.userId, admin.orgId),
    ]);
    await harness.deliverInboundEmail({
      from: firstExternal,
      subject: firstCode.code,
      text: "",
    });
    await harness.deliverInboundEmail({
      from: secondExternal,
      subject: "Link second address",
      text: `${secondCode.code}\nSent from my phone`,
    });

    expect(
      (await harness.getLinkStatus(admin.userId, admin.orgId)).emails,
    ).toStrictEqual([admin.email, firstExternal, secondExternal]);
    await expect(
      harness.listThreadIds(admin.userId, admin.orgId),
    ).resolves.toHaveLength(0);
  });

  it("integrations-email-062 (3/4) creates a conversation for an ordinary request from the subject-linked non-login address", async () => {
    const harness = createEmailHarness();
    const [, admin] = await Promise.all([
      harness.configureRunner(),
      harness.provisionProAdmin(),
    ]);
    const firstExternal = `alt1-${randomUUID()}@external.test`;
    const secondExternal = `alt2-${randomUUID()}@external.test`;

    const [firstCode, secondCode] = await Promise.all([
      harness.createLinkCode(admin.userId, admin.orgId),
      harness.createLinkCode(admin.userId, admin.orgId),
    ]);
    await Promise.all([
      harness.deliverInboundEmail({
        from: firstExternal,
        subject: firstCode.code,
        text: "",
        flush: false,
      }),
      harness.deliverInboundEmail({
        from: secondExternal,
        subject: "Link second address",
        text: `${secondCode.code}\nSent from my phone`,
        flush: false,
      }),
    ]);

    await harness.deliverInboundEmail({
      from: firstExternal,
      subject: "First ordinary request",
      text: "Check my notes",
    });

    await expect(
      harness.listThreadIds(admin.userId, admin.orgId),
    ).resolves.toHaveLength(1);
  });

  it("integrations-email-062 (4/4) creates a conversation for an ordinary request from the body-linked non-login address", async () => {
    const harness = createEmailHarness();
    const [, admin] = await Promise.all([
      harness.configureRunner(),
      harness.provisionProAdmin(),
    ]);
    const firstExternal = `alt1-${randomUUID()}@external.test`;
    const secondExternal = `alt2-${randomUUID()}@external.test`;

    const [firstCode, secondCode] = await Promise.all([
      harness.createLinkCode(admin.userId, admin.orgId),
      harness.createLinkCode(admin.userId, admin.orgId),
    ]);
    await Promise.all([
      harness.deliverInboundEmail({
        from: firstExternal,
        subject: firstCode.code,
        text: "",
        flush: false,
      }),
      harness.deliverInboundEmail({
        from: secondExternal,
        subject: "Link second address",
        text: `${secondCode.code}\nSent from my phone`,
        flush: false,
      }),
    ]);

    await harness.deliverInboundEmail({
      from: secondExternal,
      subject: "Second ordinary request",
      text: "Draft an update",
    });

    await expect(
      harness.listThreadIds(admin.userId, admin.orgId),
    ).resolves.toHaveLength(1);
  });

  it("integrations-email-063 deduplicates verification webhook retries and cannot reuse a code for another sender", async () => {
    const harness = createEmailHarness();
    const userId = `user_dedup_${randomUUID()}`;
    const orgId = `org_dedup_${randomUUID()}`;
    const loginEmail = `login-${randomUUID()}@workspace.test`;
    const firstAddress = `new-${randomUUID()}@external.test`;
    const otherAddress = `other-${randomUUID()}@external.test`;
    harness.addDirectoryUser({
      id: userId,
      email: loginEmail,
      orgIds: [orgId],
    });
    await updateFeatureSwitchesForUser(
      context,
      { userId, orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.EmailIntegration]: true },
    );
    await harness.getLinkStatus(userId, orgId);

    const { code } = await harness.createLinkCode(userId, orgId);
    const codeEmailId = randomUUID();
    const codeMessageId = `<code-${randomUUID()}@external.test>`;
    const codeSpec: InboundEmailSpec = {
      emailId: codeEmailId,
      messageId: codeMessageId,
      from: firstAddress,
      subject: "Verify email",
      text: code,
    };

    await harness.deliverInboundEmail(codeSpec);
    await harness.deliverInboundEmail(codeSpec);
    await harness.deliverInboundEmail({
      from: otherAddress,
      subject: "Steal code",
      text: code,
    });

    expect((await harness.getLinkStatus(userId, orgId)).emails).toStrictEqual([
      loginEmail,
      firstAddress,
    ]);
    const connectedConfirmations = harness.sentEmails.filter((item) => {
      return item.text.includes("Email connected.");
    });
    expect(connectedConfirmations).toHaveLength(1);

    await harness.unlinkEmail(userId, orgId, firstAddress);
    await harness.deliverInboundEmail(codeSpec);
    expect((await harness.getLinkStatus(userId, orgId)).emails).toStrictEqual([
      loginEmail,
    ]);
  });

  it("integrations-email-064 rejects another workspace with a reply and allows moving only after disconnect and a fresh proof", async () => {
    const harness = createEmailHarness();
    const firstUserId = `user_ws1_${randomUUID()}`;
    const firstOrgId = `org_ws1_${randomUUID()}`;
    const firstLogin = `owner1-${randomUUID()}@workspace.test`;
    const secondUserId = `user_ws2_${randomUUID()}`;
    const secondOrgId = `org_ws2_${randomUUID()}`;
    const secondLogin = `owner2-${randomUUID()}@workspace.test`;
    const sharedAddress = `shared-${randomUUID()}@external.test`;

    harness.addDirectoryUser({
      id: firstUserId,
      email: firstLogin,
      orgIds: [firstOrgId],
    });
    harness.addDirectoryUser({
      id: secondUserId,
      email: secondLogin,
      orgIds: [secondOrgId],
    });
    await updateFeatureSwitchesForUser(
      context,
      { userId: firstUserId, orgId: firstOrgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.EmailIntegration]: true },
    );
    await updateFeatureSwitchesForUser(
      context,
      { userId: secondUserId, orgId: secondOrgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.EmailIntegration]: true },
    );
    await harness.getLinkStatus(firstUserId, firstOrgId);
    await harness.getLinkStatus(secondUserId, secondOrgId);

    const firstCode = await harness.createLinkCode(firstUserId, firstOrgId);
    const firstCodeSpec: InboundEmailSpec = {
      emailId: randomUUID(),
      messageId: `<first-code-${randomUUID()}@external.test>`,
      from: sharedAddress,
      subject: "Link first workspace",
      text: firstCode.code,
    };
    await harness.deliverInboundEmail(firstCodeSpec);

    const secondCode = await harness.createLinkCode(secondUserId, secondOrgId);
    await harness.deliverInboundEmail({
      from: sharedAddress,
      subject: "Try second workspace",
      text: secondCode.code,
    });

    expect(
      (await harness.getLinkStatus(secondUserId, secondOrgId)).emails,
    ).toStrictEqual([secondLogin]);
    expect(harness.sentEmails.at(-1)?.to).toBe(sharedAddress);
    expect(harness.sentEmails.at(-1)?.text).toContain(
      "already connected to another account or workspace",
    );
    expect(
      (await harness.getLinkStatus(firstUserId, firstOrgId)).emails,
    ).toStrictEqual([firstLogin, sharedAddress]);

    await harness.unlinkEmail(firstUserId, firstOrgId, sharedAddress);
    await harness.deliverInboundEmail(firstCodeSpec);
    expect(
      (await harness.getLinkStatus(firstUserId, firstOrgId)).emails,
    ).toStrictEqual([firstLogin]);

    const freshCode = await harness.createLinkCode(secondUserId, secondOrgId);
    await harness.deliverInboundEmail({
      from: sharedAddress,
      subject: "Move to second workspace",
      text: freshCode.code,
    });
    expect(
      (await harness.getLinkStatus(secondUserId, secondOrgId)).emails,
    ).toStrictEqual([secondLogin, sharedAddress]);
    expect(
      (await harness.getLinkStatus(firstUserId, firstOrgId)).emails,
    ).toStrictEqual([firstLogin]);
  });

  it("integrations-email-065 rejects expired verification without creating a connection", async () => {
    const harness = createEmailHarness();
    const userId = `user_exp_${randomUUID()}`;
    const orgId = `org_exp_${randomUUID()}`;
    const loginEmail = `login-${randomUUID()}@workspace.test`;
    const newAddress = `expired-${randomUUID()}@external.test`;
    harness.addDirectoryUser({
      id: userId,
      email: loginEmail,
      orgIds: [orgId],
    });
    await updateFeatureSwitchesForUser(
      context,
      { userId, orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.EmailIntegration]: true },
    );
    await harness.getLinkStatus(userId, orgId);

    mockNow(harness.realWallNow - 11 * 60 * 1000);
    const { code } = await harness.createLinkCode(userId, orgId);
    clearMockNow();

    await harness.deliverInboundEmail({
      from: newAddress,
      subject: "Expired code",
      text: code,
    });

    expect((await harness.getLinkStatus(userId, orgId)).emails).toStrictEqual([
      loginEmail,
    ]);
  });

  it("integrations-email-066 rejects forged verification without creating a connection", async () => {
    const harness = createEmailHarness();
    const userId = `user_forged_${randomUUID()}`;
    const orgId = `org_forged_${randomUUID()}`;
    const loginEmail = `login-${randomUUID()}@workspace.test`;
    const newAddress = `forged-${randomUUID()}@external.test`;
    harness.addDirectoryUser({
      id: userId,
      email: loginEmail,
      orgIds: [orgId],
    });
    await updateFeatureSwitchesForUser(
      context,
      { userId, orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.EmailIntegration]: true },
    );
    await harness.getLinkStatus(userId, orgId);

    const { code } = await harness.createLinkCode(userId, orgId);
    await harness.deliverInboundEmail({
      from: newAddress,
      subject: "Forged code",
      text: code,
      authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
    });

    expect((await harness.getLinkStatus(userId, orgId)).emails).toStrictEqual([
      loginEmail,
    ]);
  });

  it("integrations-email-071 does not route an existing mailbox when its workspace switch is disabled", async () => {
    const harness = createEmailHarness();
    const admin = await harness.provisionProAdmin({ enableEmailSwitch: false });
    const gmailAddress = `gmail-off-${randomUUID()}@external.test`;
    await harness.connectGmailMailbox(admin, gmailAddress);

    await harness.deliverInboundEmail({
      from: gmailAddress,
      subject: "Switch is off",
      text: "Should not route",
    });

    await expect(
      harness.listThreadIds(admin.userId, admin.orgId),
    ).resolves.toHaveLength(0);
    expect(harness.sentEmails).toHaveLength(0);
  });

  it("integrations-email-072 does not route an existing mailbox for a banned account", async () => {
    const harness = createEmailHarness();
    const admin = await harness.provisionProAdmin({ enableEmailSwitch: true });
    const gmailAddress = `gmail-banned-${randomUUID()}@external.test`;
    await harness.connectGmailMailbox(admin, gmailAddress);
    harness.addDirectoryUser({
      id: admin.userId,
      email: admin.email,
      banned: true,
      orgIds: [admin.orgId],
    });

    await harness.deliverInboundEmail({
      from: gmailAddress,
      subject: "Banned account",
      text: "Should not route",
    });

    await expect(
      harness.listThreadIds(admin.userId, admin.orgId),
    ).resolves.toHaveLength(0);
    expect(harness.sentEmails).toHaveLength(0);
  });

  it("integrations-email-074 (1/2) automatically adds gmail accounts and keeps both listed after deleting the login connector account", async () => {
    const harness = createEmailHarness();
    const userId = `user_gmail_${randomUUID()}`;
    const orgId = `org_gmail_${randomUUID()}`;
    const loginEmail = `login-gmail-${randomUUID()}@gmail.test`;
    const secondEmail = `second-gmail-${randomUUID()}@gmail.test`;
    harness.addDirectoryUser({
      id: userId,
      email: loginEmail,
      orgIds: [orgId],
    });
    await updateFeatureSwitchesForUser(
      context,
      { userId, orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.EmailIntegration]: true },
    );

    const loginConnectionId = await harness.connectGmailMailbox(
      { userId, orgId },
      loginEmail,
      "sub-login-gmail",
    );
    await harness.connectGmailMailbox(
      { userId, orgId },
      secondEmail,
      "sub-second-gmail",
    );

    const initial = await harness.getLinkStatus(userId, orgId);
    expect(initial.emails).toStrictEqual([loginEmail, secondEmail]);
    expect(initial.emailSources).toStrictEqual({
      [loginEmail]: "gmail",
      [secondEmail]: "gmail",
    });

    harness.signIn(userId, orgId);
    await accept(
      setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      ).delete({
        headers: AUTH_HEADERS,
        params: { connectionId: loginConnectionId },
        body: { target: { kind: "builtin", connectorSlug: "gmail" } },
      }),
      [200],
    );
    const afterConnectorDelete = await harness.getLinkStatus(userId, orgId);
    expect(afterConnectorDelete.emails).toStrictEqual([
      loginEmail,
      secondEmail,
    ]);
  });

  it("integrations-email-074 (2/2) preserves individual deletion of a gmail-added email and does not relink it on inbound mail", async () => {
    const harness = createEmailHarness();
    const userId = `user_gmail_${randomUUID()}`;
    const orgId = `org_gmail_${randomUUID()}`;
    const loginEmail = `login-gmail-${randomUUID()}@gmail.test`;
    const secondEmail = `second-gmail-${randomUUID()}@gmail.test`;
    harness.addDirectoryUser({
      id: userId,
      email: loginEmail,
      orgIds: [orgId],
    });
    await updateFeatureSwitchesForUser(
      context,
      { userId, orgId, orgRole: "org:admin" },
      { [FeatureSwitchKey.EmailIntegration]: true },
    );

    const loginConnectionId = await harness.connectGmailMailbox(
      { userId, orgId },
      loginEmail,
      "sub-login-gmail",
    );
    await harness.connectGmailMailbox(
      { userId, orgId },
      secondEmail,
      "sub-second-gmail",
    );

    harness.signIn(userId, orgId);
    await accept(
      setupApp({ context, routes: connectorAccountRoutes })(
        connectorAccountsContract,
      ).delete({
        headers: AUTH_HEADERS,
        params: { connectionId: loginConnectionId },
        body: { target: { kind: "builtin", connectorSlug: "gmail" } },
      }),
      [200],
    );
    await harness.unlinkEmail(userId, orgId, secondEmail);
    await harness.deliverInboundEmail({
      from: secondEmail,
      subject: "After individual deletion",
      text: "Do not relink",
    });

    const finalStatus = await harness.getLinkStatus(userId, orgId);
    expect(finalStatus.emails).toStrictEqual([loginEmail]);
    expect(finalStatus.emailSources).toStrictEqual({});
  });
});
