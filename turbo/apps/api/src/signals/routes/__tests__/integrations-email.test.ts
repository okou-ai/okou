import { now } from "../../../lib/time";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { http, HttpResponse } from "msw";
import { object, string, record } from "zod";
import { integrationsEmailContract } from "@okouai/api-contracts/contracts/integrations-email";
import { chatThreadEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { integrationsEmailRoutes } from "../integrations-email";
import { chatThreadRoutes } from "../chat-threads";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { createRouteMocks } from "./helpers/route-test";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const files = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);
const mocks = createRouteMocks(context);
function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function emailClient() {
  return setupApp({ context, routes: integrationsEmailRoutes })(
    integrationsEmailContract,
  );
}

function verifiedDirectory(actor: ApiTestUser) {
  mocks.clerk.session(actor.userId, actor.orgId, "org:admin");
  mockClerkUsers(context, [
    {
      id: actor.userId,
      primaryEmailAddressId: "email_verified",
      firstName: "Email",
      lastName: "User",
      imageUrl: "",
      username: null,
      privateMetadata: {},
      emailAddresses: [
        {
          id: "email_verified",
          emailAddress: actor.email,
          verification: { status: "verified" },
        },
      ],
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

function incoming(options: {
  readonly sender: string;
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
        to: ["okou@okou.io"],
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
    data: { email_id: id, to: ["okou@okou.io"] },
  };
  return {
    id,
    messageId,
    async send() {
      await webhooks.requestResendInboundWebhook(
        event,
        webhooks.signedResendWebhookHeaders(event),
        [200],
      );
      await flushWaitUntilForTest();
    },
  };
}

async function entitledActor(email?: string) {
  const actor = bdd.user({
    orgId: createUniqueStaffOrgIdFixture(),
    ...(email ? { email } : {}),
  });
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  const group = runs.configureRunnerGroup();
  await runs.grantProEntitlement(actor);
  await runs.ensurePersonalSubscriptionModel(actor);
  verifiedDirectory(actor);
  return { actor, group };
}

async function createdThreads(actor: ApiTestUser) {
  const response = await files.requestThreadEvents(actor, {}, [200]);
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

function sentEmails() {
  return context.mocks.resend.send.mock.calls.map((call) => {
    return object({
      to: string(),
      text: string(),
      headers: record(string(), string()),
    }).parse(call[0]);
  });
}

describe("Email integration", () => {
  it("imports an email attachment privately without forwarding the Resend credential to its download host", async () => {
    const { actor } = await entitledActor();
    const attachmentId = randomUUID();
    const receipt = incoming({
      sender: actor.email,
      attachments: [{ id: attachmentId, filename: "comparison.txt" }],
    });
    const downloadUrl = `https://resend-attachments.s3.amazonaws.com/${attachmentId}/comparison.txt`;
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
  });

  it("rejects untrusted attachment download hosts while preserving the email text", async () => {
    const { actor } = await entitledActor();
    const attachmentId = randomUUID();
    const receipt = incoming({
      sender: actor.email,
      attachments: [{ id: attachmentId, filename: "untrusted.txt" }],
    });
    const downloadUrl = `https://untrusted.example/${attachmentId}/untrusted.txt`;
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
  });

  it("keeps email chats readable through both installed-iOS event endpoints", async () => {
    const { actor } = await entitledActor();
    await incoming({ sender: actor.email }).send();
    const threads = await createdThreads(actor);
    const threadId = threads.chatThreads[0]?.id;
    if (!threadId) {
      throw new Error("Expected an email chat");
    }
    const client = setupApp({ context, routes: chatThreadRoutes })(
      chatThreadEventsContract,
    );
    const extraHeaders = {
      "X-Client-Type": "iOS",
      "X-Client-Version": "99.0.0",
    };
    const rows = await accept(
      client.rows({
        headers: authHeaders(),
        extraHeaders,
        params: { threadId },
        query: { sinceSeqId: 0 },
      }),
      [200],
    );
    expect(
      rows.body.rows.some((row) => {
        return row.eventType === "input.prompt" && row.contextType === "web";
      }),
    ).toBeTruthy();
    expect(
      rows.body.rows.some((row) => {
        return row.contextType === "email";
      }),
    ).toBeFalsy();
    const catchUp = await accept(
      client.catchUp({
        headers: authHeaders(),
        extraHeaders,
        body: [[threadId, 0]],
      }),
      [200],
    );
    expect(
      catchUp.body.events[threadId]?.some((row) => {
        return row.eventType === "input.prompt" && row.contextType === "web";
      }),
    ).toBeTruthy();
    expect(
      catchUp.body.events[threadId]?.some((row) => {
        return row.contextType === "email";
      }),
    ).toBeFalsy();
    const current = await accept(
      client.rows({
        headers: authHeaders(),
        params: { threadId },
        query: { sinceSeqId: 0 },
      }),
      [200],
    );
    expect(
      current.body.rows.some((row) => {
        return row.contextType === "email";
      }),
    ).toBeTruthy();
  });

  it("revokes pending reply delivery when its sender disconnects", async () => {
    const { actor, group } = await entitledActor();
    await incoming({ sender: actor.email }).send();
    await runs.heartbeatRunner(group);
    const polled = await runs.pollRunner(group);
    const runId = polled.body.job?.runId;
    if (!runId) {
      throw new Error("Expected an email run");
    }
    const claim = await runs.claimRunnerJob(runId);
    await accept(
      emailClient().unlink({
        headers: authHeaders(),
        body: { emailAddress: actor.email },
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
      { authorization: `Bearer ${claim.sandboxToken}` },
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
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
    await flushWaitUntilForTest();
    expect(sentEmails()).toStrictEqual([]);
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

  it("connects only verified account addresses and requires explicit reconnection after disconnect", async () => {
    const actor = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
    verifiedDirectory(actor);
    await accept(
      emailClient().connectAddress({
        headers: authHeaders(),
        body: { emailAddress: "someone-else@example.com" },
      }),
      [403],
    );
    await accept(
      emailClient().connectAddress({
        headers: authHeaders(),
        body: { emailAddress: actor.email },
      }),
      [200],
    );
    expect(
      (
        await accept(
          emailClient().getLinkStatus({ headers: authHeaders() }),
          [200],
        )
      ).body.emails,
    ).toStrictEqual([actor.email]);
    await accept(
      emailClient().unlink({
        headers: authHeaders(),
        body: { emailAddress: actor.email },
      }),
      [204],
    );
    await incoming({ sender: actor.email }).send();
    expect(
      (
        await accept(
          emailClient().getLinkStatus({ headers: authHeaders() }),
          [200],
        )
      ).body.emails,
    ).toStrictEqual([]);
    await accept(
      emailClient().connectAddress({
        headers: authHeaders(),
        body: { emailAddress: actor.email },
      }),
      [200],
    );
    expect(
      (
        await accept(
          emailClient().getLinkStatus({ headers: authHeaders() }),
          [200],
        )
      ).body.emails,
    ).toStrictEqual([actor.email]);
  });

  it("does not auto-connect an account from a forged sender", async () => {
    const actor = bdd.user({ orgId: createUniqueStaffOrgIdFixture() });
    verifiedDirectory(actor);
    await incoming({ sender: actor.email, authenticated: false }).send();
    expect(
      (
        await accept(
          emailClient().getLinkStatus({ headers: authHeaders() }),
          [200],
        )
      ).body.emails,
    ).toStrictEqual([]);
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
    expect(
      (
        await accept(
          emailClient().getLinkStatus({ headers: authHeaders() }),
          [200],
        )
      ).body.emails,
    ).toStrictEqual([]);
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
    const polled = await runs.pollRunner(group);
    const runId = polled.body.job?.runId;
    expect(runId).toBeTruthy();
    if (!runId) {
      throw new Error("Expected an email run");
    }
    const claim = await runs.claimRunnerJob(runId);
    expect(claim.prompt).toContain("First independent request");
    expect(claim.appendSystemPrompt).toContain("Email integration");
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
      { authorization: `Bearer ${claim.sandboxToken}` },
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
      { authorization: `Bearer ${claim.sandboxToken}` },
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

  it("preserves the original request through signup and auto-connect, rejects another account, and resumes only once", async () => {
    const sender = "yuma@vm0.ai";
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [],
      totalCount: 0,
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
    const actor = bdd.user({
      email: sender,
      orgId: createUniqueStaffOrgIdFixture(),
    });
    onTestFinished(async () => {
      webhooks.configureClerkWebhookSecret();
      webhooks.verifyNextClerkWebhook({
        type: "user.deleted",
        data: { id: actor.userId },
      });
      await webhooks.requestClerkWebhook("{}", {}, [200]);
      await flushWaitUntilForTest();
    });
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    const group = runs.configureRunnerGroup();
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
      hasDefaultAgent: true,
    });
    verifiedDirectory(actor);
    const snapshot = await createdThreads(actor);
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
    const polled = await runs.pollRunner(group);
    const runId = polled.body.job?.runId;
    if (!runId) {
      throw new Error(
        "Expected the first email to run before browser onboarding",
      );
    }
    const claim = await runs.claimRunnerJob(runId);
    expect(claim.prompt).toContain("Please handle this after signup");
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
      { authorization: `Bearer ${claim.sandboxToken}` },
      [200],
    );
    await webhooks.requestAgentComplete(
      {
        runId,
        exitCode: 0,
        lastEventSequence: 0,
        completion: {
          cliAgentType: claim.cliAgentType,
          cliAgentSessionId: claim.piSessionId ?? `email-signup-${runId}`,
          cliAgentSessionHistoryDisposition: "native_only",
        },
      },
      { authorization: `Bearer ${claim.sandboxToken}` },
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
