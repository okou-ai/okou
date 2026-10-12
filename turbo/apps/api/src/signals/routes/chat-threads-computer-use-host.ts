import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import { chatThreadComputerUseHostContract } from "@okouai/api-contracts/contracts/chat-threads";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { nowDate } from "../../lib/time";
import { badRequestMessage, notFound } from "../../lib/error";
import { chatThreadOrganizationCondition } from "../services/chat-thread-organization.service";
import { updateOwnedChatThreadWithEvent$ } from "../services/chat-thread-owned-update.service";
import type { RouteEntry } from "../route-entry";

const threadExists$ = command(
  async (
    { set },
    params: {
      readonly threadId: string;
      readonly userId: string;
      readonly orgId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const [thread] = await set(writeDb$)
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, params.threadId),
          eq(chatThreads.userId, params.userId),
          chatThreadOrganizationCondition(params.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return thread !== undefined;
  },
);

const computerUseHostExists$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly hostId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const [host] = await set(writeDb$)
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
    signal.throwIfAborted();
    return host !== undefined;
  },
);

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

    if (
      !(await set(
        threadExists$,
        {
          threadId: params.id,
          userId: auth.userId,
          orgId: auth.orgId,
        },
        signal,
      ))
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
        !(await set(
          computerUseHostExists$,
          {
            orgId: auth.orgId,
            userId: auth.userId,
            hostId,
          },
          signal,
        ))
      ) {
        return notFound("Computer-use host not found");
      }
      signal.throwIfAborted();
    }

    const updatedAt = nowDate();
    const cloudBrowserEnabled =
      hostId !== null ? false : body.data.cloudBrowserEnabled;
    const written = await set(
      updateOwnedChatThreadWithEvent$,
      {
        userId: auth.userId,
        orgId: auth.orgId,
        threadId: params.id,
        set: {
          computerUseHostId: hostId,
          ...(cloudBrowserEnabled === undefined ? {} : { cloudBrowserEnabled }),
          updatedAt,
        },
        event: {
          kind: "computer_use_host_updated",
          eventId: body.data.eventId,
          computerUseHostId: hostId,
          createdAt: updatedAt,
        },
      },
      signal,
    );
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
