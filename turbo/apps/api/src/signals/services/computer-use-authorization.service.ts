import { createHash, randomBytes } from "node:crypto";

import { command } from "ccstate";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type {
  ComputerUseAuthorizationSource,
  ComputerUseHostListResponse,
} from "@okouai/api-contracts/contracts/computer-use";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import {
  computerUseAuthorizationRequests,
  computerUseHosts,
} from "@okouai/db/schema/computer-use-host";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";

import type { Tx } from "../../lib/db-types";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import {
  ChatThreadContentOwnershipChangedError,
  type ChatThreadContentIdentity,
  withChatThreadContentWrite,
} from "./chat-thread-content-erasure-admission.service";
import { appendChatThreadEvent } from "./chat-thread-event.service";
import {
  computerUseHostIsOnline,
  listComputerUseHosts$,
} from "./computer-use.service";

const COMPUTER_USE_AUTHORIZATION_REQUEST_TTL_MS = 60 * 60 * 1000;
const COMPUTER_USE_AUTHORIZATION_URL_PREFIX =
  "vm0_computer_use_authorization_request";

type AuthorizationRequestRow =
  typeof computerUseAuthorizationRequests.$inferSelect;

interface ComputerUseAuthorizationRunLocator {
  readonly chatThreadId: string;
  readonly triggerSource: string;
}

type CreateComputerUseAuthorizationRequestResult =
  | {
      readonly status: "created";
      readonly authorizationUrl: string;
      readonly source: ComputerUseAuthorizationSource;
      readonly expiresAt: string;
    }
  | { readonly status: "run_not_found" }
  | { readonly status: "unsupported_context" };

type ReadComputerUseAuthorizationRequestResult =
  | {
      readonly status: "found";
      readonly source: ComputerUseAuthorizationSource;
      readonly expiresAt: string;
      readonly completedAt: string | null;
      readonly computerUseHostId: string | null;
      readonly hosts: ComputerUseHostListResponse["hosts"];
    }
  | { readonly status: "not_found" }
  | { readonly status: "expired" };

type ApplyComputerUseAuthorizationRequestResult =
  | {
      readonly status: "applied";
      readonly source: ComputerUseAuthorizationSource;
      readonly computerUseHostId: string;
    }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
  | { readonly status: "host_not_found" }
  | { readonly status: "scope_not_found" };

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function generateOpaqueToken(): string {
  return `${COMPUTER_USE_AUTHORIZATION_URL_PREFIX}_${randomBytes(32).toString("base64url")}`;
}

function requiredChatThreadId(request: AuthorizationRequestRow): string {
  if (!request.chatThreadId) {
    throw new Error(
      `Chat authorization request ${request.id} is missing its thread ID`,
    );
  }
  return request.chatThreadId;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function authorizationUrl(requestToken: string): string {
  return `${env("APP_URL")}/computer-use/authorize/${encodeURIComponent(
    requestToken,
  )}`;
}

async function resolveRunLocator(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}): Promise<
  ComputerUseAuthorizationRunLocator | "run_not_found" | "unsupported_context"
> {
  if (!isUuid(args.runId)) {
    return "run_not_found";
  }

  const [run] = await args.db
    .select({
      chatThreadId: agentRuns.chatThreadId,
      triggerSource: agentRuns.triggerSource,
    })
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

  if (!run || run.triggerSource === null) {
    return "run_not_found";
  }
  if (run.chatThreadId === null) {
    return "unsupported_context";
  }
  return {
    chatThreadId: run.chatThreadId,
    triggerSource: run.triggerSource,
  };
}

/**
 * Retains the canonical thread and exact original run for request creation.
 *
 * The shared helper's thread KEY SHARE blocks deletion but permits non-key
 * user/Agent updates. This caller can then wait for the run, so it locally
 * upgrades the thread to SHARE and rechecks the admitted identity first. A
 * mismatch retries the whole bounded admission before any newly discovered
 * subject can be locked out of order. The run comes last and also needs SHARE:
 * all labels checked below are non-key, and the locator is never retargeted.
 */
async function retainComputerUseAuthorizationCreationIdentity(
  tx: Tx,
  args: {
    readonly identity: ChatThreadContentIdentity;
    readonly locator: ComputerUseAuthorizationRunLocator;
    readonly orgId: string;
    readonly userId: string;
    readonly runId: string;
  },
): Promise<boolean> {
  const [thread] = await tx
    .select({
      userId: chatThreads.userId,
      agentId: chatThreads.agentId,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, args.locator.chatThreadId))
    .limit(1)
    .for("share");
  if (
    !thread ||
    thread.userId !== args.identity.userId ||
    thread.agentId !== args.identity.agentId
  ) {
    throw new ChatThreadContentOwnershipChangedError();
  }

  const [run] = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.userId, args.userId),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.chatThreadId, args.locator.chatThreadId),
        eq(agentRuns.triggerSource, args.locator.triggerSource),
      ),
    )
    .limit(1)
    .for("share");
  return run !== undefined;
}

async function loadRequestByToken(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly requestToken: string;
  readonly now: Date;
}): Promise<
  | { readonly status: "found"; readonly request: AuthorizationRequestRow }
  | { readonly status: "not_found" }
  | { readonly status: "expired" }
> {
  const [request] = await args.db
    .select()
    .from(computerUseAuthorizationRequests)
    .where(
      and(
        eq(
          computerUseAuthorizationRequests.requestTokenHash,
          hashSecret(args.requestToken),
        ),
        eq(computerUseAuthorizationRequests.orgId, args.orgId),
        eq(computerUseAuthorizationRequests.userId, args.userId),
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

async function onlineHostExists(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly hostId: string;
  readonly now: Date;
}): Promise<boolean> {
  const [host] = await args.db
    .select({
      lastSeenAt: computerUseHosts.lastSeenAt,
      revokedAt: computerUseHosts.revokedAt,
      status: computerUseHosts.status,
    })
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.id, args.hostId),
        eq(computerUseHosts.orgId, args.orgId),
        eq(computerUseHosts.userId, args.userId),
        isNull(computerUseHosts.revokedAt),
      ),
    )
    .limit(1);
  return host !== undefined && computerUseHostIsOnline(host, args.now);
}

async function loadTeamsChatThread(args: {
  readonly db: Pick<Db, "select">;
  readonly request: AuthorizationRequestRow;
  readonly userId: string;
}) {
  const connectionId = args.request.teamsConnectionId;
  const conversationId = args.request.teamsConversationId;
  const threadId = args.request.teamsThreadId;
  if (!connectionId || !conversationId || !threadId) {
    return undefined;
  }

  const [thread] = await args.db
    .select({
      id: chatThreads.id,
      agentId: chatThreads.agentId,
      computerUseHostId: chatThreads.computerUseHostId,
    })
    .from(teamsChatThreadRoutes)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, teamsChatThreadRoutes.chatThreadId),
    )
    .where(
      and(
        eq(teamsChatThreadRoutes.connectionId, connectionId),
        eq(teamsChatThreadRoutes.conversationId, conversationId),
        eq(teamsChatThreadRoutes.threadId, threadId),
        eq(teamsChatThreadRoutes.userId, args.userId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .limit(1);
  return thread;
}

async function loadAuthorizedComputerUseHostId(args: {
  readonly db: Db;
  readonly request: AuthorizationRequestRow;
  readonly userId: string;
}): Promise<string | null> {
  if (!args.request.completedAt) {
    return null;
  }

  if (args.request.source === "chat") {
    const [thread] = await args.db
      .select({ computerUseHostId: chatThreads.computerUseHostId })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, requiredChatThreadId(args.request)),
          eq(chatThreads.userId, args.userId),
          isNotNull(chatThreads.agentId),
        ),
      )
      .limit(1);
    return thread?.computerUseHostId ?? null;
  }

  if (
    args.request.source === "teams" &&
    args.request.teamsConnectionId &&
    args.request.teamsConversationId &&
    args.request.teamsThreadId
  ) {
    const thread = await loadTeamsChatThread(args);
    return thread?.computerUseHostId ?? null;
  }

  return null;
}

async function teamsScopeExists(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
}): Promise<boolean> {
  const [connection] = await args.db
    .select({ id: teamsOrgConnections.id })
    .from(teamsOrgConnections)
    .innerJoin(
      teamsOrgInstallations,
      eq(
        teamsOrgInstallations.teamsTenantId,
        teamsOrgConnections.teamsTenantId,
      ),
    )
    .where(
      and(
        eq(teamsOrgConnections.id, args.connectionId),
        eq(teamsOrgConnections.userId, args.userId),
        eq(teamsOrgInstallations.orgId, args.orgId),
      ),
    )
    .limit(1);
  return connection !== undefined;
}

/**
 * Retains the exact admitted thread identity with the write-compatible lock the
 * selection UPDATE below already needs. The shared helper's KEY SHARE protects
 * deletion but permits non-key user/Agent changes; a stronger SHARE lock would
 * make concurrent applies upgrade against one another and can deadlock. NO KEY
 * UPDATE instead serializes those writers without an avoidable lock upgrade.
 */
async function retainComputerUseAuthorizationApplyThread(
  tx: Tx,
  identity: ChatThreadContentIdentity,
): Promise<void> {
  const [thread] = await tx
    .select({
      userId: chatThreads.userId,
      agentId: chatThreads.agentId,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, identity.chatThreadId))
    .limit(1)
    .for("no key update");
  if (
    !thread ||
    thread.userId !== identity.userId ||
    thread.agentId !== identity.agentId
  ) {
    throw new ChatThreadContentOwnershipChangedError();
  }
}

/**
 * Revalidates and pins the exact canonical-chat request only after B1 subject,
 * Agent and thread admission. The request labels are a locator rather than
 * authority; the fixed id/hash/user/org/source/thread tuple can never retarget
 * this apply while it waits. Thread selection, sidebar sequence/event and
 * request completion then share this transaction and one accepted timestamp.
 */
async function applyAuthorizedComputerUseSelection(
  tx: Tx,
  args: {
    readonly identity: ChatThreadContentIdentity & {
      readonly agentId: string;
    };
    readonly request: AuthorizationRequestRow;
    readonly requestToken: string;
    readonly orgId: string;
    readonly userId: string;
    readonly computerUseHostId: string;
  },
  signal: AbortSignal,
): Promise<ApplyComputerUseAuthorizationRequestResult> {
  await retainComputerUseAuthorizationApplyThread(tx, args.identity);
  signal.throwIfAborted();

  const [request] = await tx
    .select({ expiresAt: computerUseAuthorizationRequests.expiresAt })
    .from(computerUseAuthorizationRequests)
    .where(
      and(
        eq(computerUseAuthorizationRequests.id, args.request.id),
        eq(
          computerUseAuthorizationRequests.requestTokenHash,
          hashSecret(args.requestToken),
        ),
        eq(computerUseAuthorizationRequests.orgId, args.orgId),
        eq(computerUseAuthorizationRequests.userId, args.userId),
        eq(computerUseAuthorizationRequests.source, "chat"),
        eq(
          computerUseAuthorizationRequests.chatThreadId,
          args.identity.chatThreadId,
        ),
      ),
    )
    .limit(1)
    .for("no key update");
  signal.throwIfAborted();
  if (!request) {
    return { status: "not_found" };
  }

  // The request pin can wait. Read the clock afterwards so a link that lapses
  // during that wait cannot update the thread or complete the request.
  const appliedAt = nowDate();
  if (request.expiresAt.getTime() <= appliedAt.getTime()) {
    return { status: "expired" };
  }
  // Completed requests intentionally remain repeatable.

  const [thread] = await tx
    .update(chatThreads)
    .set({
      computerUseHostId: args.computerUseHostId,
      cloudBrowserEnabled: false,
      updatedAt: appliedAt,
    })
    .where(
      and(
        eq(chatThreads.id, args.identity.chatThreadId),
        eq(chatThreads.userId, args.identity.userId),
        eq(chatThreads.agentId, args.identity.agentId),
      ),
    )
    .returning({ id: chatThreads.id, agentId: chatThreads.agentId });
  signal.throwIfAborted();
  if (!thread?.agentId) {
    return { status: "scope_not_found" };
  }

  await appendChatThreadEvent(tx, {
    kind: "computer_use_host_updated",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentId: thread.agentId,
    computerUseHostId: args.computerUseHostId,
    cloudBrowserEnabled: false,
    createdAt: appliedAt,
  });
  signal.throwIfAborted();

  const completed = await tx
    .update(computerUseAuthorizationRequests)
    .set({ completedAt: appliedAt, updatedAt: appliedAt })
    .where(
      and(
        eq(computerUseAuthorizationRequests.id, args.request.id),
        eq(
          computerUseAuthorizationRequests.requestTokenHash,
          hashSecret(args.requestToken),
        ),
        eq(computerUseAuthorizationRequests.orgId, args.orgId),
        eq(computerUseAuthorizationRequests.userId, args.userId),
        eq(computerUseAuthorizationRequests.source, "chat"),
        eq(
          computerUseAuthorizationRequests.chatThreadId,
          args.identity.chatThreadId,
        ),
      ),
    )
    .returning({ id: computerUseAuthorizationRequests.id });
  signal.throwIfAborted();
  if (completed.length !== 1) {
    throw new Error("Failed to complete Computer Use authorization request");
  }
  return {
    status: "applied",
    source: "chat",
    computerUseHostId: args.computerUseHostId,
  };
}

async function applyChatAuthorizationScope(
  args: {
    readonly db: Db;
    readonly request: AuthorizationRequestRow;
    readonly requestToken: string;
    readonly orgId: string;
    readonly userId: string;
    readonly computerUseHostId: string;
  },
  signal: AbortSignal,
): Promise<ApplyComputerUseAuthorizationRequestResult> {
  const chatThreadId = requiredChatThreadId(args.request);
  const result = await withChatThreadContentWrite(
    args.db,
    {
      chatThreadId,
      authorize: (identity) => {
        return (
          identity.userId === args.userId &&
          identity.agentId !== null &&
          identity.orgId === args.orgId
        );
      },
    },
    async (tx, identity) => {
      if (identity.agentId === null) {
        return { status: "scope_not_found" as const };
      }
      return await applyAuthorizedComputerUseSelection(
        tx,
        {
          identity: { ...identity, agentId: identity.agentId },
          request: args.request,
          requestToken: args.requestToken,
          orgId: args.orgId,
          userId: args.userId,
          computerUseHostId: args.computerUseHostId,
        },
        signal,
      );
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.outcome !== "written") {
    return { status: "scope_not_found" };
  }
  return result.value;
}

async function applyTeamsAuthorizationScope(args: {
  readonly db: Db;
  readonly request: AuthorizationRequestRow;
  readonly orgId: string;
  readonly userId: string;
  readonly computerUseHostId: string;
  readonly now: Date;
}): Promise<boolean> {
  const connectionId = args.request.teamsConnectionId;
  const conversationId = args.request.teamsConversationId;
  const threadId = args.request.teamsThreadId;
  if (
    !connectionId ||
    !conversationId ||
    !threadId ||
    !(await teamsScopeExists({
      db: args.db,
      orgId: args.orgId,
      userId: args.userId,
      connectionId,
    }))
  ) {
    return false;
  }

  return await args.db.transaction(async (tx) => {
    const existing = await loadTeamsChatThread({
      db: tx,
      request: args.request,
      userId: args.userId,
    });
    if (!existing) {
      return false;
    }
    const [thread] = await tx
      .update(chatThreads)
      .set({
        computerUseHostId: args.computerUseHostId,
        cloudBrowserEnabled: false,
        updatedAt: args.now,
      })
      .where(
        and(
          eq(chatThreads.id, existing.id),
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
      computerUseHostId: args.computerUseHostId,
      cloudBrowserEnabled: false,
      createdAt: args.now,
    });
    return true;
  });
}

export const createComputerUseAuthorizationRequest$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string;
    },
    signal: AbortSignal,
  ): Promise<CreateComputerUseAuthorizationRequestResult> => {
    const db = set(writeDb$);
    const locator = await resolveRunLocator({ db, ...args });
    signal.throwIfAborted();

    if (locator === "run_not_found") {
      return { status: "run_not_found" };
    }
    if (locator === "unsupported_context") {
      return { status: "unsupported_context" };
    }

    // The token is opaque and never persisted. Reusing it across a bounded
    // ownership retry is safe because only an accepted attempt can insert its
    // hash, and no URL is returned until that transaction commits.
    const requestToken = generateOpaqueToken();
    const result = await withChatThreadContentWrite(
      db,
      {
        chatThreadId: locator.chatThreadId,
        authorize: (identity) => {
          return (
            identity.userId === args.userId &&
            identity.agentId !== null &&
            identity.orgId === args.orgId
          );
        },
      },
      async (
        tx,
        identity,
      ): Promise<CreateComputerUseAuthorizationRequestResult> => {
        const retained = await retainComputerUseAuthorizationCreationIdentity(
          tx,
          {
            identity,
            locator,
            ...args,
          },
        );
        if (!retained) {
          return { status: "run_not_found" };
        }
        signal.throwIfAborted();

        // Required locks can wait on deletion and identity writers. Start the
        // one-hour validity only after those waits, immediately before INSERT.
        const now = nowDate();
        const expiresAt = new Date(
          now.getTime() + COMPUTER_USE_AUTHORIZATION_REQUEST_TTL_MS,
        );
        await tx.insert(computerUseAuthorizationRequests).values({
          requestTokenHash: hashSecret(requestToken),
          orgId: args.orgId,
          userId: args.userId,
          runId: args.runId,
          // Canonical Slack and Teams runs intentionally retain the historical
          // chat source contract; creation does not revive legacy locators.
          source: "chat",
          chatThreadId: locator.chatThreadId,
          slackConnectionId: null,
          slackChannelId: null,
          slackThreadTs: null,
          teamsConnectionId: null,
          teamsConversationId: null,
          teamsThreadId: null,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        });

        return {
          status: "created",
          authorizationUrl: authorizationUrl(requestToken),
          source: "chat",
          expiresAt: expiresAt.toISOString(),
        };
      },
      signal,
    );
    if (result.outcome !== "written") {
      return { status: "run_not_found" };
    }
    return result.value;
  },
);

export const readComputerUseAuthorizationRequest$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
    },
    signal: AbortSignal,
  ): Promise<ReadComputerUseAuthorizationRequestResult> => {
    const db = set(writeDb$);
    const loaded = await loadRequestByToken({
      db,
      orgId: args.orgId,
      userId: args.userId,
      requestToken: args.requestToken,
      now: nowDate(),
    });
    signal.throwIfAborted();

    if (loaded.status !== "found") {
      return loaded;
    }

    const computerUseHostId = await loadAuthorizedComputerUseHostId({
      db,
      request: loaded.request,
      userId: args.userId,
    });
    signal.throwIfAborted();

    const hosts = await set(
      listComputerUseHosts$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: "found",
      source: loaded.request.source as ComputerUseAuthorizationSource,
      expiresAt: loaded.request.expiresAt.toISOString(),
      completedAt: loaded.request.completedAt?.toISOString() ?? null,
      computerUseHostId,
      hosts: hosts.hosts.filter((host) => {
        return host.status === "online";
      }),
    };
  },
);

export const applyComputerUseAuthorizationRequest$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
      readonly computerUseHostId: string;
    },
    signal: AbortSignal,
  ): Promise<ApplyComputerUseAuthorizationRequestResult> => {
    const db = set(writeDb$);
    const now = nowDate();
    const loaded = await loadRequestByToken({
      db,
      orgId: args.orgId,
      userId: args.userId,
      requestToken: args.requestToken,
      now,
    });
    signal.throwIfAborted();

    if (loaded.status !== "found") {
      return loaded;
    }

    if (
      !(await onlineHostExists({
        db,
        orgId: args.orgId,
        userId: args.userId,
        hostId: args.computerUseHostId,
        now,
      }))
    ) {
      return { status: "host_not_found" };
    }
    signal.throwIfAborted();

    const request = loaded.request;
    if (request.source === "chat") {
      const applied = await applyChatAuthorizationScope(
        {
          db,
          request,
          requestToken: args.requestToken,
          orgId: args.orgId,
          userId: args.userId,
          computerUseHostId: args.computerUseHostId,
        },
        signal,
      );
      signal.throwIfAborted();
      if (applied.status !== "applied") {
        return applied;
      }
      await publishThreadListChanged({
        userId: args.userId,
        orgId: args.orgId,
      });
      signal.throwIfAborted();
      return applied;
    }

    // Legacy Teams authorization retains its existing route/connection
    // authority and two-transaction completion semantics. R14 changes only the
    // canonical source:chat path shared by web, Slack and Teams runs.
    const applied =
      request.source === "teams"
        ? await applyTeamsAuthorizationScope({
            db,
            request,
            orgId: args.orgId,
            userId: args.userId,
            computerUseHostId: args.computerUseHostId,
            now,
          })
        : false;
    signal.throwIfAborted();
    if (!applied) {
      return { status: "scope_not_found" };
    }

    await db
      .update(computerUseAuthorizationRequests)
      .set({ completedAt: now, updatedAt: now })
      .where(eq(computerUseAuthorizationRequests.id, request.id));
    signal.throwIfAborted();
    await publishThreadListChanged({ userId: args.userId, orgId: args.orgId });
    signal.throwIfAborted();
    return {
      status: "applied",
      source: request.source as ComputerUseAuthorizationSource,
      computerUseHostId: args.computerUseHostId,
    };
  },
);
