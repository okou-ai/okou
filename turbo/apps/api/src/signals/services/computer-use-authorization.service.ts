import { createHash, randomBytes } from "node:crypto";

import { command } from "ccstate";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type {
  ComputerUseAuthorizationSource,
  ComputerUseHostListResponse,
} from "@okouai/api-contracts/contracts/computer-use";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { computerUseAuthorizationRequests } from "@okouai/db/schema/computer-use-host";
import { teamsOrgConnections } from "@okouai/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@okouai/db/schema/teams-org-installation";
import { teamsChatThreadRoutes } from "@okouai/db/schema/teams-chat-thread-route";

import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";
import {
  computerUseHostIsOnline,
  listComputerUseHosts$,
} from "./computer-use.service";

const COMPUTER_USE_AUTHORIZATION_REQUEST_TTL_MS = 60 * 60 * 1000;
const COMPUTER_USE_AUTHORIZATION_URL_PREFIX =
  "vm0_computer_use_authorization_request";

type AuthorizationRequestRow =
  typeof computerUseAuthorizationRequests.$inferSelect;

type AuthorizationRequestScope = {
  readonly source: "chat";
  readonly chatThreadId: string;
};

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

const resolveRequestScope$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId: string;
    },
    signal: AbortSignal,
  ): Promise<
    AuthorizationRequestScope | "run_not_found" | "unsupported_context"
  > => {
    if (!isUuid(args.runId)) {
      return "run_not_found";
    }

    const [run] = await get(db$)
      .select({
        chatThreadId: agentRuns.chatThreadId,
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
    signal.throwIfAborted();

    if (!run) {
      return "run_not_found";
    }
    if (run.chatThreadId) {
      return { source: "chat", chatThreadId: run.chatThreadId };
    }
    return "unsupported_context";
  },
);

const loadRequestByToken$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requestToken: string;
      readonly now: Date;
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly status: "found"; readonly request: AuthorizationRequestRow }
    | { readonly status: "not_found" }
    | { readonly status: "expired" }
  > => {
    const [request] = await get(db$)
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
    signal.throwIfAborted();

    if (!request) {
      return { status: "not_found" };
    }
    if (request.expiresAt.getTime() <= args.now.getTime()) {
      return { status: "expired" };
    }
    return { status: "found", request };
  },
);

const onlineHostExists$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly hostId: string;
      readonly now: Date;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [host] = await get(db$)
      .select({
        appVersion: computerUseHosts.appVersion,
        sessionId: computerUseHosts.sessionId,
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
    signal.throwIfAborted();
    return host !== undefined && computerUseHostIsOnline(host, args.now);
  },
);

function teamsChatThreadCondition(args: {
  readonly connectionId: string;
  readonly conversationId: string;
  readonly threadId: string;
  readonly userId: string;
}) {
  return and(
    eq(teamsChatThreadRoutes.connectionId, args.connectionId),
    eq(teamsChatThreadRoutes.conversationId, args.conversationId),
    eq(teamsChatThreadRoutes.threadId, args.threadId),
    eq(teamsChatThreadRoutes.userId, args.userId),
    eq(chatThreads.userId, args.userId),
  );
}

const loadTeamsChatThread$ = command(
  async (
    { get },
    args: {
      readonly request: AuthorizationRequestRow;
      readonly userId: string;
    },
    signal: AbortSignal,
  ) => {
    const connectionId = args.request.teamsConnectionId;
    const conversationId = args.request.teamsConversationId;
    const threadId = args.request.teamsThreadId;
    if (!connectionId || !conversationId || !threadId) {
      return undefined;
    }

    const [thread] = await get(db$)
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
        teamsChatThreadCondition({
          connectionId,
          conversationId,
          threadId,
          userId: args.userId,
        }),
      )
      .limit(1);
    signal.throwIfAborted();
    return thread;
  },
);

const loadAuthorizedComputerUseHostId$ = command(
  async (
    { get, set },
    args: {
      readonly request: AuthorizationRequestRow;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    if (!args.request.completedAt) {
      return null;
    }

    if (args.request.source === "chat") {
      const [thread] = await get(db$)
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
      signal.throwIfAborted();
      return thread?.computerUseHostId ?? null;
    }

    if (
      args.request.source === "teams" &&
      args.request.teamsConnectionId &&
      args.request.teamsConversationId &&
      args.request.teamsThreadId
    ) {
      const thread = await set(loadTeamsChatThread$, args, signal);
      signal.throwIfAborted();
      return thread?.computerUseHostId ?? null;
    }

    return null;
  },
);

const teamsScopeExists$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly connectionId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const [connection] = await get(db$)
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
    signal.throwIfAborted();
    return connection !== undefined;
  },
);

const applyChatAuthorizationScope$ = command(
  async (
    { set },
    args: {
      readonly request: AuthorizationRequestRow;
      readonly orgId: string;
      readonly userId: string;
      readonly computerUseHostId: string;
      readonly now: Date;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    // Successful preference and durable event writes commit together.
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0108; new non-billing transactions are prohibited.
    const applied = await set(writeDb$).transaction(async (tx) => {
      const [thread] = await tx
        .update(chatThreads)
        .set({
          computerUseHostId: args.computerUseHostId,
          cloudBrowserEnabled: false,
          updatedAt: args.now,
        })
        .where(
          and(
            eq(chatThreads.id, requiredChatThreadId(args.request)),
            eq(chatThreads.userId, args.userId),
          ),
        )
        .returning({
          id: chatThreads.id,
          agentId: chatThreads.agentId,
        });
      if (!thread?.agentId) {
        return false;
      }
      await tx.execute(
        chatThreadEventInsertSql({
          kind: "computer_use_host_updated",
          userId: args.userId,
          orgId: args.orgId,
          chatThreadId: thread.id,
          agentId: thread.agentId,
          computerUseHostId: args.computerUseHostId,
          cloudBrowserEnabled: false,
          createdAt: args.now,
        }),
      );
      return true;
    });
    signal.throwIfAborted();
    return applied;
  },
);

const applyTeamsAuthorizationScope$ = command(
  async (
    { set },
    args: {
      readonly request: AuthorizationRequestRow;
      readonly orgId: string;
      readonly userId: string;
      readonly computerUseHostId: string;
      readonly now: Date;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const connectionId = args.request.teamsConnectionId;
    const conversationId = args.request.teamsConversationId;
    const threadId = args.request.teamsThreadId;
    if (
      !connectionId ||
      !conversationId ||
      !threadId ||
      !(await set(
        teamsScopeExists$,
        {
          orgId: args.orgId,
          userId: args.userId,
          connectionId,
        },
        signal,
      ))
    ) {
      return false;
    }
    signal.throwIfAborted();

    // Keep route authority, preference and durable event in this transaction.
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0109; new non-billing transactions are prohibited.
    const applied = await set(writeDb$).transaction(async (tx) => {
      const [existing] = await tx
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
          teamsChatThreadCondition({
            connectionId,
            conversationId,
            threadId,
            userId: args.userId,
          }),
        )
        .limit(1);
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
      await tx.execute(
        chatThreadEventInsertSql({
          kind: "computer_use_host_updated",
          userId: args.userId,
          orgId: args.orgId,
          chatThreadId: thread.id,
          agentId: thread.agentId,
          computerUseHostId: args.computerUseHostId,
          cloudBrowserEnabled: false,
          createdAt: args.now,
        }),
      );
      return true;
    });
    signal.throwIfAborted();
    return applied;
  },
);

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
    const scope = await set(resolveRequestScope$, args, signal);
    signal.throwIfAborted();

    if (scope === "run_not_found") {
      return { status: "run_not_found" };
    }
    if (scope === "unsupported_context") {
      return { status: "unsupported_context" };
    }

    const requestToken = generateOpaqueToken();
    const now = nowDate();
    const expiresAt = new Date(
      now.getTime() + COMPUTER_USE_AUTHORIZATION_REQUEST_TTL_MS,
    );

    await db.insert(computerUseAuthorizationRequests).values({
      requestTokenHash: hashSecret(requestToken),
      orgId: args.orgId,
      userId: args.userId,
      runId: args.runId,
      source: scope.source,
      chatThreadId: scope.chatThreadId,
      teamsConnectionId: null,
      teamsConversationId: null,
      teamsThreadId: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    signal.throwIfAborted();

    return {
      status: "created",
      authorizationUrl: authorizationUrl(requestToken),
      source: scope.source,
      expiresAt: expiresAt.toISOString(),
    };
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
    const loaded = await set(
      loadRequestByToken$,
      {
        orgId: args.orgId,
        userId: args.userId,
        requestToken: args.requestToken,
        now: nowDate(),
      },
      signal,
    );
    signal.throwIfAborted();

    if (loaded.status !== "found") {
      return loaded;
    }

    const computerUseHostId = await set(
      loadAuthorizedComputerUseHostId$,
      {
        request: loaded.request,
        userId: args.userId,
      },
      signal,
    );
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
    const loaded = await set(
      loadRequestByToken$,
      {
        orgId: args.orgId,
        userId: args.userId,
        requestToken: args.requestToken,
        now,
      },
      signal,
    );
    signal.throwIfAborted();

    if (loaded.status !== "found") {
      return loaded;
    }

    if (
      !(await set(
        onlineHostExists$,
        {
          orgId: args.orgId,
          userId: args.userId,
          hostId: args.computerUseHostId,
          now,
        },
        signal,
      ))
    ) {
      return { status: "host_not_found" };
    }
    signal.throwIfAborted();

    const request = loaded.request;
    const applied =
      request.source === "chat"
        ? await set(
            applyChatAuthorizationScope$,
            {
              request,
              orgId: args.orgId,
              userId: args.userId,
              computerUseHostId: args.computerUseHostId,
              now,
            },
            signal,
          )
        : request.source === "teams"
          ? await set(
              applyTeamsAuthorizationScope$,
              {
                request,
                orgId: args.orgId,
                userId: args.userId,
                computerUseHostId: args.computerUseHostId,
                now,
              },
              signal,
            )
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

    await publishThreadListChanged({
      userId: args.userId,
      orgId: args.orgId,
    });
    signal.throwIfAborted();

    return {
      status: "applied",
      source: request.source as ComputerUseAuthorizationSource,
      computerUseHostId: args.computerUseHostId,
    };
  },
);
