import { createHash, randomBytes } from "node:crypto";
import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { browserAuthorizationRequests } from "@okouai/db/schema/browser-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { appendChatThreadEvent } from "./chat-thread-event.service";

const BROWSER_AUTHORIZATION_REQUEST_TTL_MS = 60 * 60 * 1000;
const BROWSER_AUTHORIZATION_URL_PREFIX = "vm0_browser_authorization_request";

type BrowserAuthorizationRequestRow =
  typeof browserAuthorizationRequests.$inferSelect;

type CreateBrowserAuthorizationRequestResult =
  | {
      readonly status: "created";
      readonly authorizationUrl: string;
      readonly expiresAt: string;
    }
  | { readonly status: "run_not_found" }
  | { readonly status: "unsupported_context" };

type ReadBrowserAuthorizationRequestResult =
  | {
      readonly status: "found";
      readonly expiresAt: string;
      readonly completedAt: string | null;
      readonly cloudBrowserEnabled: boolean;
    }
  | { readonly status: "not_found" }
  | { readonly status: "expired" };

type ApplyBrowserAuthorizationRequestResult =
  | { readonly status: "applied" }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "scope_not_found" };

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateOpaqueToken(): string {
  return `${BROWSER_AUTHORIZATION_URL_PREFIX}_${randomBytes(32).toString("base64url")}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function authorizationUrl(requestToken: string): string {
  return `${env("APP_URL")}/browser/authorize/${encodeURIComponent(
    requestToken,
  )}`;
}

async function resolveChatThreadId(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}): Promise<string | "run_not_found" | "unsupported_context"> {
  if (!isUuid(args.runId)) {
    return "run_not_found";
  }
  const [run] = await args.db
    .select({ chatThreadId: agentRuns.chatThreadId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.userId, args.userId),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .limit(1);
  if (!run) {
    return "run_not_found";
  }
  return run.chatThreadId ?? "unsupported_context";
}

async function loadRequestByToken(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly requestToken: string;
  readonly now: Date;
}): Promise<
  | {
      readonly status: "found";
      readonly request: BrowserAuthorizationRequestRow;
    }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
> {
  const [request] = await args.db
    .select()
    .from(browserAuthorizationRequests)
    .where(
      and(
        eq(
          browserAuthorizationRequests.requestTokenHash,
          hashSecret(args.requestToken),
        ),
        eq(browserAuthorizationRequests.orgId, args.orgId),
        eq(browserAuthorizationRequests.userId, args.userId),
      ),
    )
    .limit(1);
  if (!request) {
    return { status: "not_found" };
  }
  if (request.expiresAt.getTime() <= args.now.getTime()) {
    return { status: "expired" };
  }
  return { status: "found", request };
}

export const createBrowserAuthorizationRequest$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string;
    },
    signal: AbortSignal,
  ): Promise<CreateBrowserAuthorizationRequestResult> => {
    const db = set(writeDb$);
    const chatThreadId = await resolveChatThreadId({ db, ...args });
    signal.throwIfAborted();
    if (chatThreadId === "run_not_found") {
      return { status: "run_not_found" };
    }
    if (chatThreadId === "unsupported_context") {
      return { status: "unsupported_context" };
    }

    const requestToken = generateOpaqueToken();
    const now = nowDate();
    const expiresAt = new Date(
      now.getTime() + BROWSER_AUTHORIZATION_REQUEST_TTL_MS,
    );
    await db.insert(browserAuthorizationRequests).values({
      requestTokenHash: hashSecret(requestToken),
      orgId: args.orgId,
      userId: args.userId,
      runId: args.runId,
      chatThreadId,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    signal.throwIfAborted();

    return {
      status: "created",
      authorizationUrl: authorizationUrl(requestToken),
      expiresAt: expiresAt.toISOString(),
    };
  },
);

export const readBrowserAuthorizationRequest$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
    },
    signal: AbortSignal,
  ): Promise<ReadBrowserAuthorizationRequestResult> => {
    const db = set(writeDb$);
    const loaded = await loadRequestByToken({
      db,
      ...args,
      now: nowDate(),
    });
    signal.throwIfAborted();
    if (loaded.status !== "found") {
      return loaded;
    }

    const [thread] = await db
      .select({ cloudBrowserEnabled: chatThreads.cloudBrowserEnabled })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, loaded.request.chatThreadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!thread) {
      return { status: "not_found" };
    }
    return {
      status: "found",
      expiresAt: loaded.request.expiresAt.toISOString(),
      completedAt: loaded.request.completedAt?.toISOString() ?? null,
      cloudBrowserEnabled: thread.cloudBrowserEnabled,
    };
  },
);

export const applyBrowserAuthorizationRequest$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
    },
    signal: AbortSignal,
  ): Promise<ApplyBrowserAuthorizationRequestResult> => {
    const db = set(writeDb$);
    const now = nowDate();
    const loaded = await loadRequestByToken({ db, ...args, now });
    signal.throwIfAborted();
    if (loaded.status !== "found") {
      return loaded;
    }

    const applied = await db.transaction(async (tx) => {
      const [thread] = await tx
        .update(chatThreads)
        .set({
          computerUseHostId: null,
          cloudBrowserEnabled: true,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatThreads.id, loaded.request.chatThreadId),
            eq(chatThreads.userId, args.userId),
            isNotNull(chatThreads.agentId),
          ),
        )
        .returning({
          id: chatThreads.id,
          agentId: chatThreads.agentId,
        });
      if (!thread?.agentId) {
        return false;
      }
      await appendChatThreadEvent(tx, {
        kind: "computer_use_host_updated",
        userId: args.userId,
        orgId: args.orgId,
        chatThreadId: thread.id,
        agentId: thread.agentId,
        computerUseHostId: null,
        cloudBrowserEnabled: true,
        createdAt: now,
      });
      await tx
        .update(browserAuthorizationRequests)
        .set({ completedAt: now, updatedAt: now })
        .where(eq(browserAuthorizationRequests.id, loaded.request.id));
      return true;
    });
    signal.throwIfAborted();
    if (!applied) {
      return { status: "scope_not_found" };
    }

    await publishThreadListChanged({
      userId: args.userId,
      orgId: args.orgId,
    });
    signal.throwIfAborted();
    return { status: "applied" };
  },
);
