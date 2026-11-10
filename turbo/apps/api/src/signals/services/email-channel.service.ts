import {
  materializeIntegrationInputAssets$,
  integrationInputMessageFiles,
  canonicalInputFilePrompt,
  type IntegrationInputFile,
} from "./integration-input-assets.service";
import { command } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { array, object, string, uuid, record, type infer as zInfer } from "zod";
import { accept } from "@okouai/connectors/accept";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  emailChannelMessages,
  emailChatThreadRoutes,
  emailUserLinks,
} from "@okouai/db/schema/email-integration";
import { env } from "../../lib/env";
import { now, nowDate } from "../../lib/time";
import { plainTextFromHtml } from "../../lib/email-markdown";
import { writeDb$ } from "../external/db";
import { clerk$, type ClerkUser } from "../external/clerk";
import { findClerkUser } from "../external/clerk-users";
import { waitUntil } from "../context/wait-until";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { resolveOrgDefaultComposeId$ } from "./agentphone-shared.service";
import { ensureOrgLimitedFreeBootstrap$ } from "./org-limited-free-bootstrap.service";
import { completeOnboarding$ } from "./onboarding.service";
import type { ApiOrgRole } from "../../types/auth";
import { getMemberRoleAndUpdateCache$ } from "./auth.service";
import { resolveDefaultModelFirstPin$ } from "./model-selection.service";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import {
  integrationChatThreadValues,
  integrationChatThreadInsertFromRouteSql,
  integrationThreadCreatedEventSql,
} from "./integration-chat-thread-publication";
import { resolveEnqueuedChatInputModel$ } from "./chat-input-model.service";
import { createUserMessageDocument } from "./chat-user-message.service";
import { enqueueIntegrationChatInput$ } from "./integration-chat-queue.service";
import {
  pickEnqueuedChatThread$,
  notifyRunningChatRunOfPendingInput$,
} from "./chat-thread-queue-drain.service";
import { enqueueEmailText$ } from "./email-channel-delivery.service";
import {
  linkEmailIdentity$,
  consumeEmailConnectionCode$,
  emailConnectionCodeFromText,
} from "./email-connection.service";

export const EMAIL_CHANNEL_ADDRESS = "okou@okou.io";
const EVENT_NAMESPACE = "511cc626-e844-4718-80d1-9d38d994e1ac";
const LINK_TTL_SECONDS = 24 * 60 * 60;

const receivedChannelEmailSchema = object({
  id: uuid(),
  from: string(),
  to: array(string()),
  message_id: string()
    .max(998)
    .regex(/^<[^<>\s]+>$/u),
  subject: string()
    .max(998)
    .regex(/^[^\r\n]*$/u),
  text: string().nullable(),
  html: string().nullable(),
  headers: record(string(), string()),
  authentication: object({
    spf: string(),
    dkim: string(),
    dmarc: string(),
  }).nullable(),
  attachments: array(object({ id: string(), filename: string().nullable() })),
});

function normalizeMailbox(value: string): string | null {
  const match = /^(?:[^<>\r\n]*<)?([^<>\s,@]+@[^<>\s,@]+\.[^<>\s,@]+)>?$/u.exec(
    value.trim(),
  );
  return match?.[1]?.toLowerCase() ?? null;
}

function header(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  return Object.entries(headers).find(([key]) => {
    return key.toLowerCase() === name;
  })?.[1];
}

function messageReferences(value: string | undefined): string[] {
  return value?.match(/<[^<>\s]+>/gu)?.slice(-100) ?? [];
}

function ownsVerifiedEmail(user: ClerkUser, email: string): boolean {
  return (
    !user.banned &&
    user.emailAddresses.some((entry) => {
      return (
        entry.emailAddress.toLowerCase() === email &&
        entry.verification?.status === "verified"
      );
    })
  );
}

function emailConnectionSignature(
  messageId: string,
  sender: string,
  expires: number,
): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`email-connect:v1:${messageId}:${sender}:${expires}`)
    .digest("hex");
}

export function validEmailConnectionSignature(
  message: typeof emailChannelMessages.$inferSelect,
  expires: number,
  signature: string,
): boolean {
  if (
    expires < Math.floor(now() / 1000) ||
    expires > Math.floor(now() / 1000) + LINK_TTL_SECONDS ||
    !/^[a-f0-9]{64}$/u.test(signature)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(
      emailConnectionSignature(message.id, message.sender, expires),
      "hex",
    ),
  );
}

const sendEmailConnectPrompt$ = command(
  async (
    { set },
    message: typeof emailChannelMessages.$inferSelect,
    signal: AbortSignal,
  ) => {
    const expires =
      Math.floor(message.createdAt.getTime() / 1000) + LINK_TTL_SECONDS;
    if (expires <= Math.floor(now() / 1000)) {
      return;
    }
    const url = new URL("/settings/email", env("APP_URL"));
    url.searchParams.set("message", message.id);
    url.searchParams.set("expires", String(expires));
    url.searchParams.set(
      "signature",
      emailConnectionSignature(message.id, message.sender, expires),
    );
    await set(
      enqueueEmailText$,
      {
        id: uuidv5(`connect:${message.id}`, EVENT_NAMESPACE),
        to: message.sender,
        subject: /^re:/iu.test(message.subject)
          ? message.subject
          : `Re: ${message.subject}`,
        messageId: `<connect.${message.id}@okou.io>`,
        inReplyTo: message.messageId,
        references: message.references,
        text: `Hi, I'm Okou. Open this private link to sign in or create your account with this email address. I'll connect your email and continue your original request automatically, so you don't need to resend it.\n\n[Continue with Okou](${url.toString()})\n\nEach new email starts a separate conversation. Reply within an email conversation to keep its context. This integration does not support HIPAA-regulated use.`,
      },
      signal,
    );
    signal.throwIfAborted();
  },
);

const ensureEmailThread$ = command(
  async (
    { set },
    args: {
      readonly link: typeof emailUserLinks.$inferSelect;
      readonly rootMessageId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const where = and(
      eq(emailChatThreadRoutes.userLinkId, args.link.id),
      eq(emailChatThreadRoutes.rootMessageId, args.rootMessageId),
    );
    const [existing] = await db
      .select()
      .from(emailChatThreadRoutes)
      .where(where)
      .limit(1);
    signal.throwIfAborted();
    if (existing) {
      return existing;
    }
    const agentId = await set(resolveOrgDefaultComposeId$, args.link.orgId);
    signal.throwIfAborted();
    if (!agentId) {
      throw new Error("Workspace default agent is unavailable");
    }
    const creation = {
      orgId: args.link.orgId,
      userId: args.link.userId,
      agentId,
      currentTime: nowDate(),
      initialModel: await set(
        resolveDefaultModelFirstPin$,
        {
          orgId: args.link.orgId,
          userId: args.link.userId,
          orgPlanCapabilities: undefined,
        },
        signal,
      ),
    };
    signal.throwIfAborted();
    const defaults = await set(
      loadNewChatThreadDefaults$,
      { orgId: args.link.orgId, userId: args.link.userId },
      signal,
    );
    signal.throwIfAborted();
    const thread = integrationChatThreadValues(
      creation,
      randomUUID(),
      defaults,
    );
    const insertRoute = db
      .insert(emailChatThreadRoutes)
      .values({
        userLinkId: args.link.id,
        rootMessageId: args.rootMessageId,
        chatThreadId: thread.id,
      })
      .onConflictDoNothing()
      .returning();
    const insertedRoute = db.$with("email_route").as(insertRoute);
    // The route, canonical thread, and created event publish in one statement.
    await db.execute(
      integrationThreadCreatedEventSql(args.link.orgId, thread, {
        cte: sql`email_route AS (${insertRoute.getSQL()}), email_thread AS (${integrationChatThreadInsertFromRouteSql(thread, insertedRoute)} RETURNING ${chatThreads.agentId})`,
        gate: sql`EXISTS (SELECT 1 FROM email_thread)`,
        agentId: sql`(SELECT agent_id FROM email_thread)`,
        result: sql`SELECT id FROM email_route WHERE EXISTS (SELECT 1 FROM inserted)`,
      }),
    );
    signal.throwIfAborted();
    const [route] = await db
      .select()
      .from(emailChatThreadRoutes)
      .where(where)
      .limit(1);
    signal.throwIfAborted();
    if (!route) {
      throw new Error("Email thread route is unavailable");
    }
    return route;
  },
);

const resolveEmailMessageRoute$ = command(
  async (
    { set },
    {
      message,
      link,
    }: {
      readonly message: typeof emailChannelMessages.$inferSelect;
      readonly link: typeof emailUserLinks.$inferSelect;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const refs = [
      ...message.references,
      ...(message.inReplyTo ? [message.inReplyTo] : []),
    ];
    const [referenced] = refs.length
      ? await db
          .select({ rootMessageId: emailChatThreadRoutes.rootMessageId })
          .from(emailChannelMessages)
          .innerJoin(
            emailChatThreadRoutes,
            eq(emailChatThreadRoutes.id, emailChannelMessages.routeId),
          )
          .where(
            and(
              eq(emailChannelMessages.sender, message.sender),
              eq(emailChatThreadRoutes.userLinkId, link.id),
              inArray(emailChannelMessages.messageId, refs),
            ),
          )
          .limit(1)
      : [];
    signal.throwIfAborted();
    const route = await set(
      ensureEmailThread$,
      {
        link,
        rootMessageId:
          referenced?.rootMessageId ??
          message.references[0] ??
          message.inReplyTo ??
          message.messageId,
      },
      signal,
    );
    signal.throwIfAborted();
    await db
      .update(emailChannelMessages)
      .set({ routeId: route.id })
      .where(eq(emailChannelMessages.id, message.id));
    signal.throwIfAborted();
    return route;
  },
);

function emailInputFiles(
  message: typeof emailChannelMessages.$inferSelect,
  link: typeof emailUserLinks.$inferSelect,
): readonly IntegrationInputFile[] {
  const files: readonly IntegrationInputFile[] = message.attachmentIds.map(
    (id, index) => {
      const filename = message.attachmentNames[index];
      if (filename === undefined) {
        throw new Error(
          "Email attachment filename is missing from its receipt",
        );
      }
      return {
        sourceId: id,
        filename,
        maxBytes: 10 * 1024 * 1024,
        provenance: {
          provider: "email",
          installationId: link.id,
          messageId: message.messageId,
          externalFileId: `${message.providerEmailId}:${id}`,
        },
        resource: {
          provider: "email",
          emailId: message.providerEmailId,
          attachmentId: id,
        },
      };
    },
  );
  return files;
}

const initializeEmailWorkspace$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly role: ApiOrgRole;
    },
    signal: AbortSignal,
  ) => {
    const defaultAgentId = await set(resolveOrgDefaultComposeId$, args.orgId);
    signal.throwIfAborted();
    if (args.role === "admin" && !defaultAgentId) {
      // Signup can reach this continuation before Clerk's organization webhook.
      // Reuse the same workspace bootstrap as the normal signup workflow.
      await set(
        ensureOrgLimitedFreeBootstrap$,
        { orgId: args.orgId, ownerUserId: args.userId },
        signal,
      );
      signal.throwIfAborted();
    }
    await set(
      completeOnboarding$,
      {
        orgId: args.orgId,
        member: { userId: args.userId, role: args.role },
        isAdmin: args.role === "admin",
      },
      signal,
    );
    signal.throwIfAborted();
  },
);

export const processEmailChannelMessage$ = command(
  async (
    { get, set },
    args: {
      readonly message: typeof emailChannelMessages.$inferSelect;
      readonly link: typeof emailUserLinks.$inferSelect;
    },
    signal: AbortSignal,
  ) => {
    const { message, link } = args;
    if (!message.text.trim() && message.attachmentIds.length === 0) {
      return;
    }
    if (
      !message.authenticated ||
      link.disconnectedAt ||
      message.sender !== link.emailAddress
    ) {
      return;
    }
    const user = await findClerkUser(get(clerk$), link.userId, signal);
    signal.throwIfAborted();
    if (!user || user.banned) {
      return;
    }
    const role = await set(
      getMemberRoleAndUpdateCache$,
      link.orgId,
      link.userId,
      signal,
    );
    signal.throwIfAborted();
    if (role.kind !== "member") {
      return;
    }
    const features = await set(
      loadUserFeatureSwitchContext$,
      link.orgId,
      link.userId,
      signal,
    );
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.EmailIntegration, features)) {
      return;
    }
    await set(
      initializeEmailWorkspace$,
      {
        orgId: link.orgId,
        userId: link.userId,
        role: role.role,
      },
      signal,
    );
    signal.throwIfAborted();
    const db = set(writeDb$);
    const route = await set(resolveEmailMessageRoute$, args, signal);
    signal.throwIfAborted();
    const model = await set(
      resolveEnqueuedChatInputModel$,
      { threadId: route.chatThreadId, userId: link.userId, orgId: link.orgId },
      signal,
    );
    signal.throwIfAborted();
    const files = emailInputFiles(message, link);
    const assets = await set(
      materializeIntegrationInputAssets$,
      {
        userId: link.userId,
        orgId: link.orgId,
        chatThreadId: route.chatThreadId,
        files,
      },
      signal,
    );
    signal.throwIfAborted();
    const text = [
      `Subject: ${message.subject}\n\n${message.text}`,
      ...assets.map(({ asset }) => {
        return canonicalInputFilePrompt(asset);
      }),
    ].join("\n\n");
    const eventId = await set(
      enqueueIntegrationChatInput$,
      {
        orgId: link.orgId,
        threadModelReplacement: model.threadModelReplacement,
        input: {
          id: uuidv5(`input:${message.id}`, EVENT_NAMESPACE),
          chatThreadId: route.chatThreadId,
          eventType: "input.prompt",
          modelSelection: model.modelSelection,
          runId: null,
          userMessage: createUserMessageDocument({
            text: `Subject: ${message.subject}\n\n${message.text}`,
            files: integrationInputMessageFiles(assets),
          }),
          emailContext: {
            userLinkId: link.id,
            emailMessageId: message.id,
            messageText: text,
          },
          createdAt: message.createdAt,
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if (eventId) {
      await db
        .update(emailChannelMessages)
        .set({ text: "", attachmentIds: [], attachmentNames: [] })
        .where(eq(emailChannelMessages.id, message.id));
      signal.throwIfAborted();
      waitUntil(
        set(
          pickEnqueuedChatThread$,
          { orgId: link.orgId, chatThreadId: route.chatThreadId },
          signal,
        ),
      );
      waitUntil(
        set(notifyRunningChatRunOfPendingInput$, route.chatThreadId, signal),
      );
    }
  },
);

const resolveEmailSender$ = command(
  async ({ get, set }, sender: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    let [link] = await db
      .select()
      .from(emailUserLinks)
      .where(eq(emailUserLinks.emailAddress, sender))
      .limit(1);
    signal.throwIfAborted();
    if (link) {
      if (link.disconnectedAt) {
        return { kind: "ignored" } as const;
      }
      const features = await set(
        loadUserFeatureSwitchContext$,
        link.orgId,
        link.userId,
        signal,
      );
      signal.throwIfAborted();
      return isFeatureEnabled(FeatureSwitchKey.EmailIntegration, features)
        ? ({ kind: "connected", link } as const)
        : ({ kind: "ignored" } as const);
    }
    const users = await get(clerk$).users.getUserList(
      { emailAddress: [sender], limit: 2 },
      undefined,
      signal,
    );
    signal.throwIfAborted();
    const matchingUsers = users.data.filter((entry) => {
      return ownsVerifiedEmail(entry, sender);
    });
    if (
      matchingUsers.length > 1 ||
      users.data.some((entry) => {
        return entry.banned;
      })
    ) {
      return { kind: "ignored" } as const;
    }
    const user = matchingUsers[0];
    let mayOnboard = isFeatureEnabled(FeatureSwitchKey.EmailIntegration, {
      email: sender,
    });
    if (!link && user) {
      const memberships = await get(clerk$).users.getOrganizationMembershipList(
        { userId: user.id, limit: 100 },
        undefined,
        signal,
      );
      signal.throwIfAborted();
      for (const membership of memberships.data) {
        const context = await set(
          loadUserFeatureSwitchContext$,
          membership.organization.id,
          user.id,
          signal,
        );
        signal.throwIfAborted();
        if (isFeatureEnabled(FeatureSwitchKey.EmailIntegration, context)) {
          mayOnboard = true;
        }
      }
      if (memberships.totalCount === 1 && memberships.data[0]) {
        const orgId = memberships.data[0].organization.id;
        const features = await set(
          loadUserFeatureSwitchContext$,
          orgId,
          user.id,
          signal,
        );
        signal.throwIfAborted();
        if (!isFeatureEnabled(FeatureSwitchKey.EmailIntegration, features)) {
          return { kind: "ignored" } as const;
        }
        link =
          (await set(
            linkEmailIdentity$,
            { email: sender, userId: user.id, orgId },
            signal,
          )) ?? undefined;
        signal.throwIfAborted();
      }
    }
    const allowed = link
      ? isFeatureEnabled(
          FeatureSwitchKey.EmailIntegration,
          await set(
            loadUserFeatureSwitchContext$,
            link.orgId,
            link.userId,
            signal,
          ),
        )
      : mayOnboard;
    signal.throwIfAborted();
    if (!allowed) {
      return { kind: "ignored" } as const;
    }
    return link
      ? ({ kind: "connected", link } as const)
      : ({ kind: "unconnected" } as const);
  },
);

function isAutomatedEmail(headers: Readonly<Record<string, string>>): boolean {
  const autoSubmitted = header(headers, "auto-submitted");
  return Boolean(
    (autoSubmitted && autoSubmitted.toLowerCase() !== "no") ||
    header(headers, "list-id") ||
    /^(bulk|junk|list)$/iu.test(header(headers, "precedence") ?? ""),
  );
}

function isAuthenticatedSender(
  authentication: {
    readonly dmarc: string;
    readonly dkim: string;
  } | null,
): boolean {
  // Resend reports DMARC gray for p=none/missing policies; DKIM pass still
  // verifies a signature whose signing domain matches the From domain.
  return (
    authentication?.dmarc === "pass" ||
    (authentication?.dmarc === "gray" && authentication.dkim === "pass")
  );
}

const handleEmailConnectionCode$ = command(
  async (
    { set },
    args: {
      readonly received: zInfer<typeof receivedChannelEmailSchema>;
      readonly sender: string;
      readonly text: string;
    },
    signal: AbortSignal,
  ) => {
    const { received, sender } = args;
    const id = received.id;
    const code =
      emailConnectionCodeFromText(received.subject) ??
      emailConnectionCodeFromText(args.text);
    if (!code) {
      return false;
    }
    const result = await set(
      consumeEmailConnectionCode$,
      { code, sender, providerEmailId: id },
      signal,
    );
    signal.throwIfAborted();
    if (result.kind === "unknown") {
      return (
        emailConnectionCodeFromText(args.text) !== null || !args.text.trim()
      );
    }
    if (result.kind === "ignored") {
      return true;
    }
    await set(
      enqueueEmailText$,
      {
        id: uuidv5(`email-code:${id}`, EVENT_NAMESPACE),
        to: sender,
        subject: /^re:/iu.test(received.subject)
          ? received.subject
          : `Re: ${received.subject}`,
        messageId: `<email-code.${id}@okou.io>`,
        inReplyTo: received.message_id,
        references: messageReferences(header(received.headers, "references")),
        ...(result.kind === "linked" ? { userLinkId: result.link.id } : {}),
        text:
          result.kind === "linked"
            ? "Email connected. Send a new email to Okou to start a chat in this workspace. Reply within that email conversation to keep its context."
            : result.kind === "conflict"
              ? "This email is already connected to another account or workspace. Disconnect it there first, then generate and send a new connection code."
              : "This connection code has expired or already been used. Generate a new code in Email connections and send it from the email address you want to connect.",
      },
      signal,
    );
    return true;
  },
);

export const handleReceivedChannelEmail$ = command(
  async ({ set }, providerEmailId: string, signal: AbortSignal) => {
    const id = uuid().parse(providerEmailId);
    const response = await accept(
      fetch(`https://api.resend.com/emails/receiving/${id}`, {
        headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}` },
        signal,
      }),
      [200],
    );
    signal.throwIfAborted();
    const received = receivedChannelEmailSchema.parse(await response.json());
    signal.throwIfAborted();
    const sender = normalizeMailbox(received.from);
    // Only provider-computed authentication is authority. Message headers are forgeable.
    if (
      received.id !== id ||
      !received.to.some((to) => {
        return normalizeMailbox(to) === EMAIL_CHANNEL_ADDRESS;
      }) ||
      !sender ||
      sender === EMAIL_CHANNEL_ADDRESS ||
      !isAuthenticatedSender(received.authentication)
    ) {
      return;
    }
    if (isAutomatedEmail(received.headers)) {
      return;
    }
    const body =
      received.text ?? (received.html ? plainTextFromHtml(received.html) : "");
    const text = body;
    if (
      await set(handleEmailConnectionCode$, { received, sender, text }, signal)
    ) {
      return;
    }
    signal.throwIfAborted();
    if (
      (!text.trim() && received.attachments.length === 0) ||
      received.attachments.length > 20
    ) {
      return;
    }
    const db = set(writeDb$);
    const senderState = await set(resolveEmailSender$, sender, signal);
    signal.throwIfAborted();
    if (senderState.kind === "ignored") {
      return;
    }
    const link =
      senderState.kind === "connected" ? senderState.link : undefined;
    await db
      .insert(emailChannelMessages)
      .values({
        providerEmailId: id,
        sender,
        messageId: received.message_id,
        subject: received.subject,
        text,
        authenticated: true,
        attachmentIds: received.attachments.map((item) => {
          return item.id;
        }),
        attachmentNames: received.attachments.map((item) => {
          return item.filename ?? `attachment-${item.id}`;
        }),
        inReplyTo:
          messageReferences(header(received.headers, "in-reply-to"))[0] ?? null,
        references: messageReferences(header(received.headers, "references")),
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
    const [message] = await db
      .select()
      .from(emailChannelMessages)
      .where(
        and(
          eq(emailChannelMessages.sender, sender),
          eq(emailChannelMessages.messageId, received.message_id),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!message) {
      throw new Error("Email ingress receipt is unavailable");
    }
    if (link) {
      await set(processEmailChannelMessage$, { message, link }, signal);
      signal.throwIfAborted();
    } else {
      await set(sendEmailConnectPrompt$, message, signal);
      signal.throwIfAborted();
    }
  },
);

export { ownsVerifiedEmail };
