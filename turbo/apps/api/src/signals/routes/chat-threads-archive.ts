import { command } from "ccstate";
import { chatThreadArchiveContract } from "@okouai/api-contracts/contracts/chat-threads";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { notFound } from "../../lib/error";
import { updateOwnedChatThreadWithEvent } from "../services/chat-thread-owned-update.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

const archivingUnavailable = notFound("Chat thread archiving is not available");

/** Sets the flag and appends its sidebar event; false when the thread is not the caller's. */
async function writeChatThreadArchived(
  writeDb: Db,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly threadId: string;
    readonly archived: boolean;
    readonly eventId: string | undefined;
  },
): Promise<boolean> {
  return await updateOwnedChatThreadWithEvent(writeDb, {
    userId: args.userId,
    orgId: args.orgId,
    threadId: args.threadId,
    set: { archived: args.archived },
    event: () => {
      return {
        kind: args.archived ? "archived" : "unarchived",
        eventId: args.eventId,
      };
    },
  });
}

const archiveInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadArchiveContract.archive));
  const query = get(queryOf(chatThreadArchiveContract.archive));
  signal.throwIfAborted();
  const featureContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.ChatThreadArchiving, featureContext)) {
    return archivingUnavailable;
  }

  const written = await writeChatThreadArchived(set(writeDb$), {
    userId: auth.userId,
    orgId: auth.orgId,
    threadId: params.id,
    archived: true,
    eventId: query?.eventId,
  });
  signal.throwIfAborted();
  if (!written) {
    return notFound("Chat thread not found");
  }

  await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

const unarchiveInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(chatThreadArchiveContract.unarchive));
  const query = get(queryOf(chatThreadArchiveContract.unarchive));
  signal.throwIfAborted();
  const featureContext = await get(
    userFeatureSwitchContext(auth.orgId, auth.userId),
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.ChatThreadArchiving, featureContext)) {
    return archivingUnavailable;
  }

  const written = await writeChatThreadArchived(set(writeDb$), {
    userId: auth.userId,
    orgId: auth.orgId,
    threadId: params.id,
    archived: false,
    eventId: query?.eventId,
  });
  signal.throwIfAborted();
  if (!written) {
    return notFound("Chat thread not found");
  }

  await publishThreadListChanged({ userId: auth.userId, orgId: auth.orgId });
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

export const chatThreadArchiveRoutes: readonly RouteEntry[] = [
  {
    route: chatThreadArchiveContract.archive,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      archiveInner$,
    ),
  },
  {
    route: chatThreadArchiveContract.unarchive,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-thread:write",
      },
      unarchiveInner$,
    ),
  },
];
