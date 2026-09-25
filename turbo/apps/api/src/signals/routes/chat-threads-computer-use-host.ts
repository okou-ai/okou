import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { chatThreadComputerUseHostContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { computerUseHosts } from "@okouai/db/schema/computer-use-host";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { badRequestMessage, notFound } from "../../lib/error";
import { updateOwnedChatThreadWithEvent } from "../services/chat-thread-owned-update.service";
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

    const updatedAt = nowDate();
    const cloudBrowserEnabled =
      hostId !== null ? false : body.data.cloudBrowserEnabled;
    const written = await updateOwnedChatThreadWithEvent(db, {
      userId: auth.userId,
      orgId: auth.orgId,
      threadId: params.id,
      set: {
        computerUseHostId: hostId,
        ...(cloudBrowserEnabled === undefined ? {} : { cloudBrowserEnabled }),
        updatedAt,
      },
      event: (thread) => {
        return {
          kind: "computer_use_host_updated",
          eventId: body.data.eventId,
          computerUseHostId: hostId,
          cloudBrowserEnabled: thread.cloudBrowserEnabled,
          createdAt: updatedAt,
        };
      },
    });
    signal.throwIfAborted();
    if (!written) {
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
