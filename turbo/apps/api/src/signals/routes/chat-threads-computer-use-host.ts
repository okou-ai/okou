import { command } from "ccstate";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { chatThreadComputerUseHostContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { computerUseHosts } from "@okouai/db/schema/computer-use-host";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { badRequestMessage, notFound } from "../../lib/error";
import { withChatThreadContentWrite } from "../services/chat-thread-content-erasure-admission.service";
import { appendChatThreadEvent } from "../services/chat-thread-event.service";
import { chatThreadOrganizationCondition } from "../services/chat-thread-organization.service";
import type { RouteEntry } from "../route-entry";

async function threadExists(params: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
}): Promise<boolean> {
  const [thread] = await params.db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, params.threadId),
        eq(chatThreads.userId, params.userId),
        chatThreadOrganizationCondition(params.db, params.orgId),
      ),
    )
    .limit(1);
  return thread !== undefined;
}

async function computerUseHostExists(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly hostId: string;
}): Promise<boolean> {
  const [host] = await params.db
    .select({ id: computerUseHosts.id })
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.id, params.hostId),
        eq(computerUseHosts.orgId, params.orgId),
        eq(computerUseHosts.userId, params.userId),
        isNull(computerUseHosts.revokedAt),
      ),
    )
    .limit(1);
  return host !== undefined;
}

const computerUseHostBody$ = bodyResultOf(
  chatThreadComputerUseHostContract.update,
);

const updateComputerUseHostInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(chatThreadComputerUseHostContract.update));
    const body = await get(computerUseHostBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const db = set(writeDb$);
    if (
      !(await threadExists({
        db,
        threadId: params.id,
        userId: auth.userId,
        orgId: auth.orgId,
      }))
    ) {
      return notFound("Chat thread not found");
    }
    signal.throwIfAborted();

    const hostId = body.data.computerUseHostId;
    if (hostId !== null && body.data.cloudBrowserEnabled === true) {
      return badRequestMessage(
        "Cloud browser and Computer Use cannot be enabled together",
      );
    }
    if (hostId !== null) {
      if (
        !(await computerUseHostExists({
          db,
          orgId: auth.orgId,
          userId: auth.userId,
          hostId,
        }))
      ) {
        return notFound("Computer-use host not found");
      }
      signal.throwIfAborted();
    }

    // A thread's Computer Use binding, its cloud-browser flag and the sidebar
    // copy of both are account content, so the existing transaction now runs
    // inside the shared B1 admission and the canonical Agent/thread locks. The
    // thread UPDATE, the durable sidebar sequence and the
    // `computer_use_host_updated` event stay in that one transaction: a denied
    // or rolled back selection consumes no sequence and appends no event, and
    // the content-free invalidation below still publishes only after a
    // successful COMMIT. B1 closure reuses this route's existing 404, alongside
    // its unchanged organization and non-null Agent requirements.
    //
    // The host eligibility read above keeps its own semantics and stays outside
    // the fenced transaction. It admits an offline but non-revoked installed
    // host on purpose, and a host revoked between that read and this COMMIT is
    // a pre-existing race that closure fencing neither repairs nor worsens:
    // `stopComputerUseHost$` takes the host `FOR UPDATE` before clearing the
    // threads bound to it, so rechecking the host under a lock here would
    // invert that order. Host-grant linearization needs its own bounded design.
    const result = await withChatThreadContentWrite(
      db,
      {
        chatThreadId: params.id,
        authorize: (identity) => {
          return (
            identity.userId === auth.userId &&
            identity.agentId !== null &&
            identity.orgId === auth.orgId
          );
        },
      },
      async (tx) => {
        const updatedAt = nowDate();
        const cloudBrowserEnabled =
          hostId !== null ? false : body.data.cloudBrowserEnabled;
        const [thread] = await tx
          .update(chatThreads)
          .set({
            computerUseHostId: hostId,
            ...(cloudBrowserEnabled === undefined
              ? {}
              : { cloudBrowserEnabled }),
            updatedAt,
          })
          .where(
            and(
              eq(chatThreads.id, params.id),
              eq(chatThreads.userId, auth.userId),
              chatThreadOrganizationCondition(tx, auth.orgId),
              isNotNull(chatThreads.agentId),
            ),
          )
          .returning({
            id: chatThreads.id,
            agentId: chatThreads.agentId,
            cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
          });
        if (!thread?.agentId) {
          return false;
        }
        await appendChatThreadEvent(tx, {
          kind: "computer_use_host_updated",
          userId: auth.userId,
          orgId: auth.orgId,
          chatThreadId: thread.id,
          agentId: thread.agentId,
          eventId: body.data.eventId,
          computerUseHostId: hostId,
          cloudBrowserEnabled: thread.cloudBrowserEnabled,
          createdAt: updatedAt,
        });
        return true;
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.outcome !== "written" || !result.value) {
      return notFound("Chat thread not found");
    }

    await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
    signal.throwIfAborted();

    return { status: 204 as const, body: undefined };
  },
);

export const chatThreadComputerUseHostRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadComputerUseHostContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateComputerUseHostInner$,
    ),
  },
];
