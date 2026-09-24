import { isDeepStrictEqual } from "node:util";
import { command } from "ccstate";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { publicBrandSchema } from "@okouai/api-contracts/contracts/public-brand";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { agentphoneMessages } from "@okouai/db/schema/agentphone-message";
import { agentphoneUserLinks } from "@okouai/db/schema/agentphone-user-link";

import type { Tx } from "../../lib/db-types";
import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  isAgentPhoneApiError,
  sendAgentPhoneMessage,
} from "../external/agentphone-client";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
} from "../external/realtime";
import { settleIncludingAbort, tapError } from "../utils";
import {
  claimBackgroundJob,
  checkpointBackgroundJob,
  completeBackgroundJob,
  failBackgroundJob,
  retryBackgroundJob,
  type ClaimedBackgroundJob,
} from "./background-job.service";
import {
  buildAgentPhoneConnectUrl,
  linkAgentPhoneUser,
  publishAgentPhoneUserChanged,
  storeInboundAgentPhoneMessage,
  type AgentPhoneMessageEvent,
} from "./agentphone.service";
import {
  normalizeAgentPhoneHandle,
  resolveAgentPhoneUserLink,
  storeOutboundAgentPhoneMessage,
  type AgentPhoneUserLink,
} from "./agentphone-shared.service";
import { bindAgentPhoneWelcomeChatThreadRoute } from "./agentphone-chat-ingress.service";
import { agentPhoneConnectedMessages } from "./agentphone-welcome.service";
import { resolveAgentPhoneSignupIdentity$ } from "./agentphone-signup-identity.service";
import { ensureOrgLimitedFreeBootstrap$ } from "./org-limited-free-bootstrap.service";
import { completeOnboarding$ } from "./onboarding.service";
import { deliverWelcomeChatThread$ } from "./welcome-chat-thread.service";
import { admitPiStableContextSubjects } from "./pi-stable-context-erasure.service";

const L = logger("agentphone-signup");
const JOB_KIND = "agentphone-signup";
const RECEIPT_KIND = "agentphone-signup-receipt";
const HANDLER_VERSION = 1;
const JOB_NAMESPACE = "dc300f4b-cd3e-42f5-894a-c4a8ce9e4e94";
const MAX_ATTEMPTS = 5;

const inputSchema = z.object({
  messageId: z.string().min(1),
  agentphoneAgentId: z.string().min(1),
  phoneHandle: z.string().regex(/^\+[1-9]\d{7,14}$/u),
  toNumber: z.string().min(1),
  conversationId: z.string().nullable(),
  publicBrand: publicBrandSchema,
  initialUserLink: z
    .object({ id: z.uuid(), userId: z.string(), orgId: z.string() })
    .nullable(),
});
type SignupInput = z.infer<typeof inputSchema>;

const identitySchema = z.object({
  userId: z.string(),
  orgId: z.string(),
  role: z.enum(["admin", "member"]),
  initializeWorkspace: z.boolean(),
});
const checkpointSchema = z.object({
  attempts: z.number().int().nonnegative().default(0),
  userId: z.string().optional(),
  identity: identitySchema.optional(),
  initialized: z.boolean().optional(),
  userLinkId: z.uuid().optional(),
  welcomeThreadId: z.uuid().optional(),
  // Message order/count is part of this versioned handler's delivery protocol.
  welcomeMessageCount: z.number().int().min(0).max(4).default(0),
  delivery: z.enum(["sending", "sent"]).optional(),
});
type SignupCheckpoint = z.infer<typeof checkpointSchema>;

class SignupAdmissionClosedError extends Error {}

function isAgentPhoneSignupMessage(body: string): boolean {
  return /^\/?signup$/iu.test(body.trim());
}

function signupReceiptId(messageId: string): string {
  return uuidv5(`receipt:${messageId}`, JOB_NAMESPACE);
}

async function rejectErasedSignupReplay(
  tx: Tx,
  messageId: string,
  userLink: AgentPhoneUserLink | null,
): Promise<boolean> {
  const id = uuidv5(messageId, JOB_NAMESPACE);
  const receiptId = signupReceiptId(messageId);
  const rows = await tx
    .select()
    .from(backgroundJobs)
    .where(inArray(backgroundJobs.id, [id, receiptId]));
  const receipt = rows.find((row) => {
    return row.id === receiptId;
  });
  const work = rows.find((row) => {
    return row.id === id;
  });
  if (receipt && !work) {
    return true;
  }
  if (
    work?.userId &&
    userLink &&
    (work.userId !== userLink.userId ||
      (work.orgId !== "" && work.orgId !== userLink.orgId))
  ) {
    return true;
  }
  if (work?.userId) {
    return !(await admitPiStableContextSubjects(tx, [
      { subjectKind: "user", subjectId: work.userId },
      ...(work.orgId
        ? [{ subjectKind: "organization" as const, subjectId: work.orgId }]
        : []),
    ]));
  }
  return false;
}

async function enqueueSignup(
  db: Tx,
  input: SignupInput,
  allowNew: boolean,
  signal: AbortSignal,
): Promise<string | null> {
  const id = uuidv5(input.messageId, JOB_NAMESPACE);
  // Identity is initially unknown. The same leased checkpoint that resolves it
  // adopts the durable row into normal account-erasure ownership.
  if (
    allowNew &&
    input.initialUserLink &&
    !(await admitPiStableContextSubjects(db, [
      { subjectKind: "user", subjectId: input.initialUserLink.userId },
      { subjectKind: "organization", subjectId: input.initialUserLink.orgId },
    ]))
  ) {
    return null;
  }
  if (allowNew) {
    // This terminal marker contains no handle, account, message body, or raw
    // provider ID. Keep it when erasure removes the owned job and inbox: an old
    // provider redelivery must never become a new signup consent event.
    const [receipt] = await db
      .insert(backgroundJobs)
      .values({
        id: signupReceiptId(input.messageId),
        kind: RECEIPT_KIND,
        handlerVersion: HANDLER_VERSION,
        userId: "",
        orgId: "",
        input: {},
        status: "completed",
        completedAt: nowDate(),
      })
      .onConflictDoNothing({ target: backgroundJobs.id })
      .returning({ id: backgroundJobs.id });
    if (!receipt) {
      return null;
    }
    await db
      .insert(backgroundJobs)
      .values({
        id,
        kind: JOB_KIND,
        handlerVersion: HANDLER_VERSION,
        userId: input.initialUserLink?.userId ?? "",
        orgId: input.initialUserLink?.orgId ?? "",
        input,
      })
      .onConflictDoNothing({ target: backgroundJobs.id });
  }
  signal.throwIfAborted();
  const [existing] = await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, id))
    .limit(1);
  signal.throwIfAborted();
  if (!existing && !allowNew) {
    return null;
  }
  if (
    !existing ||
    existing.kind !== JOB_KIND ||
    existing.handlerVersion !== HANDLER_VERSION
  ) {
    throw new Error("AgentPhone signup receipt conflicts with its handler");
  }
  const saved = inputSchema.parse(existing.input);
  // A replay can arrive after signup connected the sender. Keep the first
  // receipt's link snapshot; every provider-controlled input must still match.
  if (
    !isDeepStrictEqual(
      { ...saved, initialUserLink: null },
      { ...input, initialUserLink: null },
    )
  ) {
    throw new Error("AgentPhone signup receipt conflicts with its input");
  }
  return id;
}

async function saveCheckpoint(
  db: Db,
  job: ClaimedBackgroundJob,
  checkpoint: SignupCheckpoint,
  signal: AbortSignal,
): Promise<void> {
  await db.transaction(async (tx) => {
    const userId =
      checkpoint.identity?.userId ?? checkpoint.userId ?? job.userId;
    const orgId = checkpoint.identity?.orgId ?? job.orgId;
    if (userId) {
      if (
        !(await admitPiStableContextSubjects(tx, [
          { subjectKind: "user", subjectId: userId },
          ...(orgId
            ? [{ subjectKind: "organization" as const, subjectId: orgId }]
            : []),
        ]))
      ) {
        throw new Error("AgentPhone signup account is no longer available");
      }
    }
    if (!(await checkpointBackgroundJob(tx, { job, checkpoint }, signal))) {
      throw new Error("AgentPhone signup lost its job lease");
    }
    if (userId) {
      await tx
        .update(backgroundJobs)
        .set({
          userId,
          orgId,
        })
        .where(
          and(
            eq(backgroundJobs.id, job.id),
            eq(backgroundJobs.leaseId, job.leaseId),
          ),
        );
      signal.throwIfAborted();
    }
  });
  signal.throwIfAborted();
}

async function adoptSignupUser(
  db: Db,
  job: ClaimedBackgroundJob,
  checkpoint: SignupCheckpoint,
  userId: string,
  signal: AbortSignal,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const orgId = checkpoint.identity?.orgId ?? job.orgId;
    if (
      !(await admitPiStableContextSubjects(tx, [
        { subjectKind: "user", subjectId: userId },
        ...(orgId
          ? [{ subjectKind: "organization" as const, subjectId: orgId }]
          : []),
      ]))
    ) {
      // The row may still be anonymous. Commit its terminal outcome before
      // throwing outside this transaction, so retry cannot replace this user.
      if (
        !(await failBackgroundJob(
          tx,
          { job, error: "signup_account_unavailable" },
          AbortSignal.timeout(5000),
        ))
      ) {
        throw new Error("AgentPhone signup lost its job lease");
      }
      return false;
    }
    await saveCheckpoint(tx, job, checkpoint, signal);
    return true;
  });
}

function connectMessage(input: SignupInput): string {
  const url = buildAgentPhoneConnectUrl({
    phoneHandle: input.phoneHandle,
    agentphoneAgentId: input.agentphoneAgentId,
    channel: "imessage",
    secret: env("SECRETS_ENCRYPTION_KEY"),
  });
  return `Choose your workspace and connect this phone number: ${url}`;
}

async function sendSignupReply(
  db: Db,
  args: {
    readonly job: ClaimedBackgroundJob;
    readonly input: SignupInput;
    readonly checkpoint: SignupCheckpoint;
    readonly body: string;
    readonly mediaUrls?: readonly string[];
    readonly welcomeIndex?: number;
  },
  signal: AbortSignal,
): Promise<SignupCheckpoint> {
  const { job, input, checkpoint, body, mediaUrls, welcomeIndex } = args;
  const nextCheckpoint: SignupCheckpoint =
    welcomeIndex === undefined
      ? { ...checkpoint, delivery: "sent" }
      : {
          ...checkpoint,
          welcomeMessageCount: welcomeIndex + 1,
          ...(welcomeIndex + 1 === agentPhoneConnectedMessages().length
            ? { delivery: "sent" as const }
            : {}),
        };
  await db.transaction(async (tx) => {
    await saveCheckpoint(
      tx,
      job,
      { ...checkpoint, delivery: "sending" },
      signal,
    );
    await requireSignupLink(tx, input, checkpoint);
  });
  signal.throwIfAborted();
  const sent = await settleIncludingAbort(
    db.transaction(async (tx) => {
      // The committed marker survives a process failure. Re-admit before the
      // external send and hold this bounded transaction until delivery settles,
      // so erasure/disconnect cannot finish and then receive a stale welcome.
      await saveCheckpoint(
        tx,
        job,
        { ...checkpoint, delivery: "sending" },
        signal,
      );
      await requireSignupLink(tx, input, checkpoint);
      signal.throwIfAborted();
      const delivered = await sendAgentPhoneMessage(
        {
          agentphoneAgentId: input.agentphoneAgentId,
          toNumber: input.phoneHandle,
          replyToMessageId:
            welcomeIndex === undefined || welcomeIndex === 0
              ? input.messageId
              : undefined,
          mediaUrls,
          body,
        },
        signal,
      );
      if (delivered.id === "unknown" || delivered.id.length === 0) {
        throw new Error("AgentPhone did not acknowledge a welcome message ID");
      }
      if (checkpoint.userLinkId) {
        await storeOutboundAgentPhoneMessage(tx, {
          agentphoneMessageId: delivered.id,
          conversationId: input.conversationId,
          agentphoneAgentId: input.agentphoneAgentId,
          publicBrand: input.publicBrand,
          userLinkId: checkpoint.userLinkId,
          phoneHandle: input.phoneHandle,
          fromNumber: input.toNumber,
          toNumber: input.phoneHandle,
          body,
          channel: delivered.channel,
          userChannel: "imessage",
          mediaUrl: mediaUrls?.[0],
        });
        signal.throwIfAborted();
      }
      await saveCheckpoint(tx, job, nextCheckpoint, signal);
    }),
  );
  if (!sent.ok) {
    // AgentPhone has no documented idempotency key for sends. A definite
    // refusal may retry; transport errors/5xx may already have sent the text.
    if (
      isAgentPhoneApiError(sent.error) &&
      sent.error.status >= 400 &&
      sent.error.status < 500 &&
      sent.error.status !== 408
    ) {
      await saveCheckpoint(db, job, checkpoint, AbortSignal.timeout(5000));
    }
    throw sent.error;
  }
  return nextCheckpoint;
}

async function requireSignupLink(
  tx: Tx,
  input: SignupInput,
  checkpoint: SignupCheckpoint,
): Promise<void> {
  const expectedId = checkpoint.userLinkId ?? input.initialUserLink?.id;
  if (!expectedId) {
    return;
  }
  const [current] = await tx
    .select({ id: agentphoneUserLinks.id })
    .from(agentphoneUserLinks)
    .where(
      and(
        eq(agentphoneUserLinks.id, expectedId),
        eq(agentphoneUserLinks.phoneHandle, input.phoneHandle),
      ),
    )
    .for("update");
  if (!current) {
    throw new Error("AgentPhone signup connection was revoked");
  }
}

async function connectSignup(
  db: Db,
  args: {
    readonly job: ClaimedBackgroundJob;
    readonly input: SignupInput;
    readonly checkpoint: SignupCheckpoint;
    readonly identity: z.infer<typeof identitySchema>;
  },
  signal: AbortSignal,
): Promise<AgentPhoneUserLink | null> {
  const { job, input, checkpoint, identity } = args;
  return await db.transaction(async (tx) => {
    await saveCheckpoint(tx, job, checkpoint, signal);
    // Serialize different signup message IDs for this phone, then check the
    // original connection under its row lock. Disconnect cannot be undone by
    // a worker that started provisioning before the user disconnected.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agentphone-signup:${input.phoneHandle}`}, 0))`,
    );
    await requireSignupLink(tx, input, checkpoint);
    const params = {
      phoneHandle: input.phoneHandle,
      channel: "imessage" as const,
      userId: identity.userId,
      orgId: identity.orgId,
      publicBrand: input.publicBrand,
    };
    let linked = await linkAgentPhoneUser(tx, params);
    signal.throwIfAborted();
    if (!linked.ok && linked.reason === "conflict") {
      // A normal Web connect can win the unique insert. Read its canonical
      // owner using the same linker; this never steals or replaces a link.
      linked = await linkAgentPhoneUser(tx, params);
      signal.throwIfAborted();
    }
    if (!linked.ok) {
      return null;
    }
    await saveCheckpoint(
      tx,
      job,
      { ...checkpoint, userLinkId: linked.userLink.id },
      signal,
    );
    await tx
      .update(agentphoneMessages)
      .set({ agentphoneUserLinkId: linked.userLink.id })
      .where(eq(agentphoneMessages.agentphoneMessageId, input.messageId));
    signal.throwIfAborted();
    return linked.userLink;
  });
}

const initializeSignupWorkspace$ = command(
  async (
    { set },
    identity: z.infer<typeof identitySchema>,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!identity.initializeWorkspace) {
      return;
    }
    // Bootstrap spans local transactions and object storage. Hold admission
    // until those bounded writes settle so account erasure can clean all of
    // them together. Its callees do not acquire a second admission lock.
    await set(writeDb$).transaction(async (tx) => {
      if (
        !(await admitPiStableContextSubjects(tx, [
          { subjectKind: "user", subjectId: identity.userId },
          { subjectKind: "organization", subjectId: identity.orgId },
        ]))
      ) {
        throw new Error("AgentPhone signup account is no longer available");
      }
      await set(
        ensureOrgLimitedFreeBootstrap$,
        {
          orgId: identity.orgId,
          ownerUserId: identity.userId,
        },
        signal,
      );
    });
    signal.throwIfAborted();
    // Onboarding owns admission for its writes; do not nest its shared locks
    // on another connection behind an erasure request's exclusive lock.
    const onboarding = await set(
      completeOnboarding$,
      {
        orgId: identity.orgId,
        member: { userId: identity.userId, role: identity.role },
      },
      signal,
    );
    if (onboarding.status !== 200) {
      throw new Error("AgentPhone signup onboarding is unavailable");
    }
  },
);

const provisionSignup$ = command(
  async (
    { set },
    args: {
      readonly job: ClaimedBackgroundJob;
      readonly input: SignupInput;
      readonly checkpoint: SignupCheckpoint;
      readonly identity: z.infer<typeof identitySchema>;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const { job, input, identity } = args;
    let { checkpoint } = args;
    checkpoint = {
      ...checkpoint,
      identity: {
        userId: identity.userId,
        orgId: identity.orgId,
        role: identity.role,
        initializeWorkspace: identity.initializeWorkspace,
      },
    };
    await saveCheckpoint(db, job, checkpoint, signal);
    if (!checkpoint.initialized) {
      await set(initializeSignupWorkspace$, identity, signal);
      checkpoint = { ...checkpoint, initialized: true };
      await saveCheckpoint(db, job, checkpoint, signal);
    }
    const linked = await connectSignup(
      db,
      { job, input, checkpoint, identity },
      signal,
    );
    if (!linked) {
      await sendSignupReply(
        db,
        {
          job,
          input,
          checkpoint,
          body: "This account or phone number is already connected elsewhere. Open Okou to manage the existing connection.",
        },
        signal,
      );
      await completeBackgroundJob(db, { job }, signal);
      return;
    }
    checkpoint = { ...checkpoint, userLinkId: linked.id };
    await publishAgentPhoneUserChanged(identity.userId);
    signal.throwIfAborted();
    const welcome = await set(deliverWelcomeChatThread$, identity, signal);
    if (
      welcome.outcome === "skipped" &&
      welcome.reason === "account-unavailable"
    ) {
      throw new Error("AgentPhone signup account is no longer available");
    }
    if (welcome.outcome === "skipped") {
      await sendSignupReply(
        db,
        {
          job,
          input,
          checkpoint,
          body: "Your phone is connected. Ask a workspace admin to configure the default agent, then send signup again.",
        },
        signal,
      );
      await completeBackgroundJob(db, { job }, signal);
      return;
    }
    checkpoint = { ...checkpoint, welcomeThreadId: welcome.threadId };
    await saveCheckpoint(db, job, checkpoint, signal);
    await bindAgentPhoneWelcomeChatThreadRoute(db, {
      userLink: linked,
      chatThreadId: welcome.threadId,
      conversationId: input.conversationId,
    });
    signal.throwIfAborted();
    await publishThreadListChanged(identity);
    signal.throwIfAborted();
    await publishChatThreadMessageCreatedSafely({
      ...identity,
      threadId: welcome.threadId,
      syncThroughSeqId: 1,
    });
    signal.throwIfAborted();
    for (const [index, message] of agentPhoneConnectedMessages().entries()) {
      if (index < checkpoint.welcomeMessageCount) {
        continue;
      }
      checkpoint = await sendSignupReply(
        db,
        {
          job,
          input,
          checkpoint,
          body: message.body,
          mediaUrls: message.mediaUrls,
          welcomeIndex: index,
        },
        signal,
      );
    }
    if (!(await completeBackgroundJob(db, { job }, signal))) {
      throw new Error("AgentPhone signup lost its job lease");
    }
  },
);

const runSignup$ = command(
  async (
    { set },
    job: ClaimedBackgroundJob,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const input = inputSchema.parse(job.input);
    let checkpoint = checkpointSchema.parse(job.checkpoint);
    if (checkpoint.delivery === "sending") {
      await failBackgroundJob(
        db,
        {
          job,
          error:
            "welcome_delivery_unknown; a new signup command can request another welcome",
        },
        signal,
      );
      return;
    }
    if (checkpoint.delivery === "sent") {
      if (!(await completeBackgroundJob(db, { job }, signal))) {
        throw new Error("AgentPhone signup lost its job lease");
      }
      return;
    }
    const currentLink = await resolveAgentPhoneUserLink(
      db,
      input.phoneHandle,
      "imessage",
    );
    signal.throwIfAborted();
    const expectedLinkId = checkpoint.userLinkId ?? input.initialUserLink?.id;
    if (expectedLinkId && currentLink?.id !== expectedLinkId) {
      // An explicit disconnect/rebind after the receipt revokes pending signup.
      await failBackgroundJob(db, { job, error: "phone_link_changed" }, signal);
      return;
    }
    const identity = await set(
      resolveAgentPhoneSignupIdentity$,
      {
        phoneHandle: input.phoneHandle,
        linkedUser: currentLink,
        resolvedUserId: checkpoint.userId,
        onUserResolved: async (userId, callbackSignal) => {
          checkpoint = { ...checkpoint, userId };
          if (
            !(await adoptSignupUser(
              db,
              job,
              checkpoint,
              userId,
              callbackSignal,
            ))
          ) {
            throw new SignupAdmissionClosedError();
          }
        },
      },
      signal,
    );
    if (identity.kind !== "ready") {
      await sendSignupReply(
        db,
        {
          job,
          input,
          checkpoint,
          body:
            identity.kind === "connect-required"
              ? connectMessage(input)
              : "This account is unavailable. Open Okou to check your account before connecting.",
        },
        signal,
      );
      await completeBackgroundJob(db, { job }, signal);
      return;
    }
    if (checkpoint.identity && checkpoint.identity.orgId !== identity.orgId) {
      throw new Error(
        "AgentPhone signup workspace changed during provisioning",
      );
    }
    await set(provisionSignup$, { job, input, checkpoint, identity }, signal);
  },
);

async function finishSignupAttempt(
  db: Db,
  args: { readonly job: ClaimedBackgroundJob; readonly attempt: number },
  work: Promise<void>,
): Promise<void> {
  const { job, attempt } = args;
  // Releasing the lease after cancellation needs its own bounded deadline.
  const result = await settleIncludingAbort(work);
  if (!result.ok && result.error instanceof SignupAdmissionClosedError) {
    return;
  }
  if (!result.ok) {
    L.warn("AgentPhone signup attempt failed", {
      jobId: job.id,
      attempt,
    });
    const persistenceSignal = AbortSignal.timeout(5000);
    const saved =
      attempt >= MAX_ATTEMPTS
        ? await failBackgroundJob(
            db,
            { job, error: "signup_attempts_exhausted" },
            persistenceSignal,
          )
        : await retryBackgroundJob(
            db,
            { job, error: "signup_attempt_failed", availableAt: nowDate() },
            persistenceSignal,
          );
    if (!saved) {
      throw new Error("AgentPhone signup lost its job lease");
    }
  }
}

export const executeAgentPhoneSignupWork$ = command(
  async (
    { set },
    args: { readonly jobId?: string },
    signal: AbortSignal,
  ): Promise<{ readonly processed: number }> => {
    if (!isFeatureEnabled(FeatureSwitchKey.AgentPhoneSignup, {})) {
      return { processed: 0 };
    }
    const db = set(writeDb$);
    const job = await claimBackgroundJob(
      db,
      { ...args, kind: JOB_KIND, handlerVersion: HANDLER_VERSION },
      signal,
    );
    if (!job) {
      return { processed: 0 };
    }
    const workSignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
    const checkpoint = checkpointSchema.parse(job.checkpoint);
    const attempt = checkpoint.attempts + 1;
    if (attempt > MAX_ATTEMPTS) {
      await failBackgroundJob(
        db,
        { job, error: "signup_attempts_exhausted" },
        signal,
      );
      return { processed: 1 };
    }
    const attemptedJob = {
      ...job,
      checkpoint: { ...checkpoint, attempts: attempt },
    };
    await finishSignupAttempt(
      db,
      { job, attempt },
      (async () => {
        await saveCheckpoint(db, job, attemptedJob.checkpoint, workSignal);
        await set(runSignup$, attemptedJob, workSignal);
      })(),
    );
    signal.throwIfAborted();
    return { processed: 1 };
  },
);

async function sendSecureConnectFallback(
  event: AgentPhoneMessageEvent,
  signal: AbortSignal,
): Promise<void> {
  const phoneHandle = normalizeAgentPhoneHandle(
    event.fromNumber,
    event.channel,
  );
  const url = buildAgentPhoneConnectUrl({
    phoneHandle,
    agentphoneAgentId: event.agentphoneAgentId,
    channel: event.channel,
    secret: env("SECRETS_ENCRYPTION_KEY"),
  });
  await sendAgentPhoneMessage(
    {
      agentphoneAgentId: event.agentphoneAgentId,
      toNumber: phoneHandle,
      body: `Connect this account securely in Okou: ${url}`,
    },
    signal,
  );
}

export const handleAgentPhoneSignup$ = command(
  async (
    { set },
    args: {
      readonly event: AgentPhoneMessageEvent;
      readonly userLink: AgentPhoneUserLink | null;
      readonly publicBrand: z.infer<typeof publicBrandSchema>;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const { event, userLink, publicBrand } = args;
    if (
      !isAgentPhoneSignupMessage(event.body) ||
      !isFeatureEnabled(FeatureSwitchKey.AgentPhoneSignup, {})
    ) {
      return false;
    }
    if (event.agentphoneAgentId !== optionalEnv("AGENTPHONE_AGENT_ID")) {
      return true;
    }
    const phoneHandle = normalizeAgentPhoneHandle(
      event.fromNumber,
      event.channel,
    );
    const trusted =
      !event.isGroup &&
      event.channel === "imessage" &&
      /^\+[1-9]\d{7,14}$/u.test(phoneHandle);
    const accepted = await set(writeDb$).transaction(async (tx) => {
      if (
        userLink &&
        !(await admitPiStableContextSubjects(tx, [
          { subjectKind: "user", subjectId: userLink.userId },
          { subjectKind: "organization", subjectId: userLink.orgId },
        ]))
      ) {
        return { inserted: false, jobId: null };
      }
      if (
        trusted &&
        (await rejectErasedSignupReplay(tx, event.messageId, userLink))
      ) {
        return { inserted: false, jobId: null };
      }
      signal.throwIfAborted();
      const stored = await storeInboundAgentPhoneMessage(tx, {
        event,
        userLinkId: userLink?.id ?? null,
        publicBrand,
      });
      signal.throwIfAborted();
      const jobId = trusted
        ? await enqueueSignup(
            tx,
            {
              messageId: event.messageId,
              agentphoneAgentId: event.agentphoneAgentId,
              phoneHandle,
              toNumber: normalizeAgentPhoneHandle(event.toNumber, "sms"),
              conversationId: event.conversationId,
              publicBrand,
              initialUserLink: userLink
                ? {
                    id: userLink.id,
                    userId: userLink.userId,
                    orgId: userLink.orgId,
                  }
                : null,
            },
            stored.inserted,
            signal,
          )
        : null;
      return { ...stored, jobId };
    });
    signal.throwIfAborted();
    if (accepted.jobId) {
      const jobId = accepted.jobId;
      waitUntil(
        tapError(set(executeAgentPhoneSignupWork$, { jobId }, signal), () => {
          L.error("AgentPhone signup worker failed", { jobId });
        }),
      );
    } else if (!trusted && !event.isGroup && accepted.inserted) {
      await sendSecureConnectFallback(event, signal);
    }
    return true;
  },
);

/** Bound retention of anonymous phone receipts, including while rollout is off. */
export async function cleanupAgentPhoneSignupJobs(db: Db): Promise<number> {
  const cutoff = new Date(nowDate().getTime() - 48 * 60 * 60 * 1000);
  const expired = await db
    .select({ id: backgroundJobs.id })
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.kind, JOB_KIND),
        eq(backgroundJobs.handlerVersion, HANDLER_VERSION),
        lt(backgroundJobs.createdAt, cutoff),
        or(
          inArray(backgroundJobs.status, [
            "pending",
            "completed",
            "failed",
            "cancelled",
          ]),
          lt(
            backgroundJobs.leaseExpiresAt,
            sql`timezone('UTC', clock_timestamp())`,
          ),
        ),
      ),
    )
    .limit(500);
  if (expired.length === 0) {
    return 0;
  }
  // Repeat the lease predicate: a cron claimant may have won since selection.
  const deleted = await db
    .delete(backgroundJobs)
    .where(
      and(
        inArray(
          backgroundJobs.id,
          expired.map(({ id }) => {
            return id;
          }),
        ),
        or(
          inArray(backgroundJobs.status, [
            "pending",
            "completed",
            "failed",
            "cancelled",
          ]),
          lt(
            backgroundJobs.leaseExpiresAt,
            sql`timezone('UTC', clock_timestamp())`,
          ),
        ),
      ),
    )
    .returning({ id: backgroundJobs.id });
  return deleted.length;
}
