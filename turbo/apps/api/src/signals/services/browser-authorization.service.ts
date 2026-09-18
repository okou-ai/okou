import { createHash, randomBytes } from "node:crypto";
import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { browserAuthorizationRequests } from "@okouai/db/schema/browser-session";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { env } from "../../lib/env";
import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import {
  ChatThreadContentOwnershipChangedError,
  type ChatThreadContentIdentity,
  withChatThreadContentWrite,
} from "./chat-thread-content-erasure-admission.service";
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

interface BrowserAuthorizationRunLocator {
  readonly chatThreadId: string;
  readonly triggerSource: string;
}

async function resolveRunLocator(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}): Promise<
  BrowserAuthorizationRunLocator | "run_not_found" | "unsupported_context"
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
 * Extends the shared thread admission only for authorization-request creation.
 *
 * The shared helper's retained thread KEY SHARE protects deletion, but not a
 * non-key `user_id` or `agent_id` update. Creation can then wait while pinning
 * its run, so it first upgrades this one thread to SHARE and compares the row
 * returned under that lock with the identity whose subjects were admitted.
 * Any change restarts the helper's whole bounded attempt, before a newly
 * discovered subject or Agent can be locked out of order.
 *
 * The run comes last. SHARE is required because every identity field checked
 * here is non-key; KEY SHARE would allow those updates to commit while the
 * request retained stale labels. The exact locator is never followed to a new
 * thread.
 */
async function retainBrowserAuthorizationCreationIdentity(
  tx: Tx,
  args: {
    readonly identity: ChatThreadContentIdentity;
    readonly locator: BrowserAuthorizationRunLocator;
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
    const locator = await resolveRunLocator({ db, ...args });
    signal.throwIfAborted();
    if (locator === "run_not_found") {
      return { status: "run_not_found" };
    }
    if (locator === "unsupported_context") {
      return { status: "unsupported_context" };
    }

    // This value is opaque and is never persisted. Reusing it across a bounded
    // ownership retry is safe because only the accepted attempt can INSERT its
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
      ): Promise<CreateBrowserAuthorizationRequestResult> => {
        const retained = await retainBrowserAuthorizationCreationIdentity(tx, {
          identity,
          locator,
          ...args,
        });
        if (!retained) {
          return { status: "run_not_found" };
        }
        signal.throwIfAborted();

        // Required locks can wait on real deletion and identity writers. Start
        // the one-hour validity only after those waits, immediately before the
        // INSERT whose transaction retains every admission and identity lock.
        const now = nowDate();
        const expiresAt = new Date(
          now.getTime() + BROWSER_AUTHORIZATION_REQUEST_TTL_MS,
        );
        await tx.insert(browserAuthorizationRequests).values({
          requestTokenHash: hashSecret(requestToken),
          orgId: args.orgId,
          userId: args.userId,
          runId: args.runId,
          chatThreadId: locator.chatThreadId,
          expiresAt,
          createdAt: now,
          updatedAt: now,
        });

        return {
          status: "created",
          authorizationUrl: authorizationUrl(requestToken),
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

/**
 * Approving an authorization link writes the same thread selection state as the
 * direct settings route, so the one transaction that owns those writes runs
 * inside the shared B1 admission and the canonical Agent and thread identity
 * locks. The thread `UPDATE`, the durable sidebar sequence and event, and this
 * request's own completion stamp stay in that single transaction.
 *
 * The request row is a locator, not authority. Its stored `user_id`/`org_id`
 * only decide which opaque token was presented; the thread's real user, its
 * non-null Agent and that Agent's organization decide whether this apply may
 * write. A request whose thread has since moved to another organization is
 * therefore no longer in scope, and is refused instead of publishing a
 * selection event under the organization the request was minted in.
 *
 * Inside the admitted transaction the exact request is re-read and pinned
 * before any content mutation, so a request deleted or expired after the
 * preflight — including one that lapses while that pin is being acquired —
 * can never leave a committed thread update, a consumed sidebar sequence or a
 * false success behind.
 */
async function applyAuthorizedBrowserSelection(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly requestToken: string;
    readonly requestId: string;
    readonly chatThreadId: string;
  },
): Promise<ApplyBrowserAuthorizationRequestResult> {
  // `FOR NO KEY UPDATE` is exactly the lock the completion `UPDATE` below
  // takes, so the pin never upgrades mid-transaction; it also blocks a
  // concurrent `DELETE`, though that alone would not require this mode, since
  // `KEY SHARE` blocks `DELETE` too. No other statement in the codebase locks
  // `browser_authorization_requests`: the only writers are this service's own
  // creation `INSERT` and this completion `UPDATE`. Creation now takes subjects
  // -> Agent -> thread -> run before inserting a fresh request, apply takes
  // subjects -> Agent -> thread -> this existing request, and the token lookups
  // take no row lock. No path therefore locks a request before Agent or thread.
  const [request] = await tx
    .select({ expiresAt: browserAuthorizationRequests.expiresAt })
    .from(browserAuthorizationRequests)
    .where(
      and(
        eq(browserAuthorizationRequests.id, args.requestId),
        eq(
          browserAuthorizationRequests.requestTokenHash,
          hashSecret(args.requestToken),
        ),
        eq(browserAuthorizationRequests.orgId, args.orgId),
        eq(browserAuthorizationRequests.userId, args.userId),
        eq(browserAuthorizationRequests.chatThreadId, args.chatThreadId),
      ),
    )
    .limit(1)
    .for("no key update");
  if (!request) {
    return { status: "not_found" };
  }
  // Read the clock only once the pin is held. Acquiring it can wait on a
  // concurrent holder and on the transaction's own bounded budget, so a reading
  // taken before that wait can report a request as live that has already
  // lapsed, and would let this transaction write thread settings, a durable
  // sidebar event and a completion stamp for it. This one reading decides the
  // TTL and is then reused for every timestamp the accepted write stores, so
  // they all keep sharing a single value.
  const appliedAt = nowDate();
  if (request.expiresAt.getTime() <= appliedAt.getTime()) {
    return { status: "expired" };
  }
  // An already completed request keeps its existing repeat behavior: the token
  // is not consumed, so applying it again re-applies the same selection.

  const [thread] = await tx
    .update(chatThreads)
    .set({
      computerUseHostId: null,
      cloudBrowserEnabled: true,
      updatedAt: appliedAt,
    })
    .where(
      and(
        eq(chatThreads.id, args.chatThreadId),
        eq(chatThreads.userId, args.userId),
        isNotNull(chatThreads.agentId),
      ),
    )
    .returning({
      id: chatThreads.id,
      agentId: chatThreads.agentId,
    });
  if (!thread?.agentId) {
    return { status: "scope_not_found" };
  }
  await appendChatThreadEvent(tx, {
    kind: "computer_use_host_updated",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentId: thread.agentId,
    computerUseHostId: null,
    cloudBrowserEnabled: true,
    createdAt: appliedAt,
  });
  await tx
    .update(browserAuthorizationRequests)
    .set({ completedAt: appliedAt, updatedAt: appliedAt })
    .where(eq(browserAuthorizationRequests.id, args.requestId));
  return { status: "applied" };
}

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
    const loaded = await loadRequestByToken({ db, ...args, now: nowDate() });
    signal.throwIfAborted();
    if (loaded.status !== "found") {
      return loaded;
    }

    const result = await withChatThreadContentWrite(
      db,
      {
        chatThreadId: loaded.request.chatThreadId,
        authorize: (identity) => {
          return (
            identity.userId === args.userId &&
            identity.agentId !== null &&
            identity.orgId === args.orgId
          );
        },
      },
      async (tx, identity) => {
        return await applyAuthorizedBrowserSelection(tx, {
          ...args,
          requestId: loaded.request.id,
          chatThreadId: identity.chatThreadId,
        });
      },
      signal,
    );
    signal.throwIfAborted();
    // A thread that is absent, foreign, organization-foreign or Agent-less
    // keeps this route's existing scope-not-found disposition, and B1 closure
    // reuses it without revealing which subject closed.
    if (result.outcome !== "written") {
      return { status: "scope_not_found" };
    }
    if (result.value.status !== "applied") {
      return result.value;
    }

    await publishThreadListChanged({
      userId: args.userId,
      orgId: args.orgId,
    });
    signal.throwIfAborted();
    return { status: "applied" };
  },
);
